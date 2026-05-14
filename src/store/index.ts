import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
    Document,
    DocumentId,
    FolderId,
    Library,
    PanelSizes,
    PdfTabState,
    UIState,
    PdfViewerState,
} from './types';
import { DEFAULT_UI, LIBRARY_TAB_ID } from './defaults';
import { pruneUiToLibrary, indexLibrary } from './libraryIndex';
import type { SerializedLibrary, SerializedUiState } from '../ipc/wireTypes';
import { deserializeUi } from '../ipc/serialization';

export type {
    Document,
    DocumentId,
    Folder,
    FolderId,
    Library,
    LibraryTabState,
    PanelSizes,
    PdfTabState,
    TabState,
    UIState,
    PdfViewerState,
} from './types';
export { LIBRARY_TAB_ID, UI_STATE_VERSION, DEFAULT_UI } from './defaults';

interface AppStore {
    library: Library | null;
    ui: UIState;

    initialize(libraryWire: SerializedLibrary, uiWire: SerializedUiState | null): void;

    activateTab(id: string): void;
    closeTab(id: string): void;
    openDocument(documentId: DocumentId): void;

    toggleExpand(folderId: FolderId): void;
    selectTreeItem(id: DocumentId | FolderId | null): void;

    setPanelSizes(sizes: PanelSizes): void;
    setViewerState(documentId: DocumentId, state: PdfViewerState): void;
}

function makePdfTabId(documentId: DocumentId): string {
    return `pdf:${documentId}`;
}

export const useStore = create<AppStore>()(
    subscribeWithSelector((set, get) => ({
        library: null,
        ui: DEFAULT_UI,

        initialize(libraryWire, uiWire) {
            const library = indexLibrary(libraryWire);
            const base = uiWire ? deserializeUi(uiWire) : DEFAULT_UI;
            const ui = pruneUiToLibrary(base, library);
            set({ library, ui });
        },

        activateTab(id) {
            const { ui } = get();
            if (!ui.tabs.some((t) => t.id === id)) return;
            if (ui.activeTabId === id) return;
            set({ ui: { ...ui, activeTabId: id } });
        },

        closeTab(id) {
            if (id === LIBRARY_TAB_ID) return;
            const { ui } = get();
            const idx = ui.tabs.findIndex((t) => t.id === id);
            if (idx === -1) return;
            const tabs = ui.tabs.filter((t) => t.id !== id);
            let activeTabId = ui.activeTabId;
            if (id === activeTabId) {
                const fallback = tabs[idx] ?? tabs[idx - 1] ?? tabs[0];
                activeTabId = fallback.id;
            }
            const viewerStates = { ...ui.viewerStates };
            const closedTab = ui.tabs[idx];
            if (closedTab.kind === 'pdf') delete viewerStates[closedTab.documentId];
            set({ ui: { ...ui, tabs, activeTabId, viewerStates } });
        },

        openDocument(documentId) {
            const { ui, library } = get();
            if (!library || !library.documents[documentId]) return;
            const tabId = makePdfTabId(documentId);
            const exists = ui.tabs.some((t) => t.id === tabId);
            const tabs = exists ? ui.tabs : [...ui.tabs, { id: tabId, kind: 'pdf', documentId } as PdfTabState];
            set({ ui: { ...ui, tabs, activeTabId: tabId } });
        },

        toggleExpand(folderId) {
            const { ui } = get();
            const next = new Set(ui.tree.expandedFolderIds);
            if (next.has(folderId)) next.delete(folderId);
            else next.add(folderId);
            set({ ui: { ...ui, tree: { ...ui.tree, expandedFolderIds: next } } });
        },

        selectTreeItem(id) {
            const { ui } = get();
            set({ ui: { ...ui, tree: { ...ui.tree, selectedId: id } } });
        },

        setPanelSizes(sizes) {
            const { ui } = get();
            if (ui.panels.left === sizes.left && ui.panels.right === sizes.right) return;
            set({ ui: { ...ui, panels: sizes } });
        },

        setViewerState(documentId, state) {
            const { ui } = get();
            set({ ui: { ...ui, viewerStates: { ...ui.viewerStates, [documentId]: state } } });
        },
    })),
);

// ---------- Selector hooks ----------

export const useLibrary = () => useStore((s) => s.library);
export const useDocument = (id: DocumentId | null | undefined): Document | null =>
    useStore((s) => (id && s.library ? s.library.documents[id] ?? null : null));
export const useTabs = () => useStore((s) => s.ui.tabs);
export const useActiveTabId = () => useStore((s) => s.ui.activeTabId);
export const useTreeState = () => useStore((s) => s.ui.tree);
export const usePanels = () => useStore((s) => s.ui.panels);
