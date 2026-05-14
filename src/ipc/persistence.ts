import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { serializeUi } from './serialization';
import type { SerializedLibrary, SerializedUiState } from './wireTypes';

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
    libraryWire: SerializedLibrary;
    uiWire: SerializedUiState | null;
}> {
    if (!isTauri()) {
        return { libraryWire: browserFallbackLibrary(), uiWire: null };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const [libraryWire, uiWire] = await Promise.all([
        invoke<SerializedLibrary>('load_library'),
        invoke<SerializedUiState | null>('load_ui_state'),
    ]);
    return { libraryWire, uiWire };
}

/**
 * Subscribes to the `ui` slice and invokes `save_ui_state` (debounced) on
 * every change. Returns a teardown fn that detaches the subscription — wire it
 * to `import.meta.hot.dispose` to avoid stacking subscribers across HMR reloads.
 *
 * No-op in a plain browser.
 */
export function startAutoSave(): () => void {
    if (!isTauri()) return () => { };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: SerializedUiState | null = null;

    const saveNow = async () => {
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
            timer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
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
 * Loads library + persisted UI state from Rust and initializes the store before
 * first render of the shell. Wires save-on-change subscription, with HMR-safe
 * teardown to avoid stacking subscribers across module reloads.
 */
export function useInitialLoad(): boolean {
    const [isReady, setIsReady] = useState(false);
    const initialize = useStore((s) => s.initialize);

    useEffect(() => {
        let teardown: (() => void) | undefined;
        let cancelled = false;
        loadInitialState()
            .then(({ libraryWire, uiWire }) => {
                if (cancelled) return;
                initialize(libraryWire, uiWire);
                teardown = startAutoSave();
                setIsReady(true);
            })
            .catch((err) => {
                console.error('initial state load failed', err);
                if (!cancelled) setIsReady(true); // still render; store has defaults
            });
        return () => {
            cancelled = true;
            teardown?.();
        };
    }, [initialize]);

    return isReady;
}

function browserFallbackLibrary(): SerializedLibrary {
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
