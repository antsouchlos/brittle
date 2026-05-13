import type { LibraryDto, UiStateDto } from './store';
import { serializeUi, useStore } from './store';

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
