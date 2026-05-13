import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { serializeUi } from './serialization';
import type { LibraryDto, UiStateDto } from './dtos';

const SAVE_DEBOUNCE_MS = 300;

function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Invokes `load_library` and `load_ui_state` in parallel. In a plain browser
 * (no Tauri), returns a tiny built-in library so the frontend stays runnable
 * for UI iteration outside the desktop shell.
 */
export async function loadInitialState(): Promise<{
    libraryDto: LibraryDto;
    uiDto: UiStateDto | null;
}> {
    if (!isTauri()) {
        return { libraryDto: browserFallbackLibrary(), uiDto: null };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const [libraryDto, uiDto] = await Promise.all([
        invoke<LibraryDto>('load_library'),
        invoke<UiStateDto | null>('load_ui_state'),
    ]);
    return { libraryDto, uiDto };
}

/**
 * Subscribes to the `ui` slice and invokes `save_ui_state` (debounced) on
 * every change. Returns a teardown fn that detaches the subscription — wire it
 * to `import.meta.hot.dispose` to avoid stacking subscribers across HMR reloads.
 *
 * No-op in a plain browser.
 */
export function subscribeAndSave(): () => void {
    if (!isTauri()) return () => { };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: UiStateDto | null = null;

    const flush = async () => {
        if (!pending) return;
        const payload = pending;
        pending = null;
        timer = null;
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('save_ui_state', { state: payload });
        } catch (err) {
            console.error('save_ui_state failed', err);
        }
    };

    const unsubscribe = useStore.subscribe(
        (s) => s.ui,
        (ui) => {
            pending = serializeUi(ui);
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
        },
    );

    return () => {
        unsubscribe();
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
}

/**
 * Loads library + persisted UI state from Rust and hydrates the store before
 * first render of the shell. Wires save-on-change subscription, with HMR-safe
 * teardown to avoid stacking subscribers across module reloads.
 */
export function useHydration(): boolean {
    const [ready, setReady] = useState(false);
    const hydrate = useStore((s) => s.hydrate);

    useEffect(() => {
        let teardown: (() => void) | undefined;
        let cancelled = false;
        loadInitialState()
            .then(({ libraryDto, uiDto }) => {
                if (cancelled) return;
                hydrate(libraryDto, uiDto);
                teardown = subscribeAndSave();
                setReady(true);
            })
            .catch((err) => {
                console.error('initial state load failed', err);
                if (!cancelled) setReady(true); // still render; store has defaults
            });
        return () => {
            cancelled = true;
            teardown?.();
        };
    }, [hydrate]);

    return ready;
}

function browserFallbackLibrary(): LibraryDto {
    return {
        rootFolderId: 'root',
        folders: [
            { id: 'root', name: 'Library', parentId: null, documentIds: [] },
            {
                id: 'samples',
                name: 'Samples',
                parentId: 'root',
                documentIds: ['doc-ebook'],
            },
        ],
        documents: [
            {
                id: 'doc-ebook',
                path: 'https://snippet.embedpdf.com/ebook.pdf',
                title: 'Sample Ebook',
            },
        ],
    };
}
