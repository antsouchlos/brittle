import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

// ---------- Library (data domain) ----------

export type DocumentId = string;
export type FolderId = string;

export interface Document {
    id: DocumentId;
    path: string;
    title: string;
    tags?: string[];
}

export interface Folder {
    id: FolderId;
    name: string;
    parentId: FolderId | null;
    documentIds: DocumentId[];
}

export interface Library {
    documents: Record<DocumentId, Document>;
    folders: Record<FolderId, Folder>;
    rootFolderId: FolderId;
    childFolderIdsByParent: Record<FolderId, FolderId[]>;
}

// DTO returned from Rust (flat lists; we derive `childFolderIdsByParent` on hydration).
export interface LibraryDto {
    documents: Document[];
    folders: { id: FolderId; name: string; parentId: FolderId | null; documentIds: DocumentId[] }[];
    rootFolderId: FolderId;
}

// ---------- UI state ----------

export type LibraryTab = { id: 'library'; kind: 'library' };
export type PdfTab = { id: string; kind: 'pdf'; documentId: DocumentId };
export type Tab = LibraryTab | PdfTab;

export const LIBRARY_TAB_ID = 'library';

// Shape kept open — embed-pdf integration will fill this in later.
export interface ViewerState {
    page?: number;
    zoom?: number;
    scrollY?: number;
}

export interface PanelSizes {
    left: number;   // percent
    right: number;  // percent
}

export interface UIState {
    tabs: Tab[];
    activeTabId: string;
    tree: {
        expandedFolderIds: Set<FolderId>;
        selectedId: DocumentId | FolderId | null;
    };
    panels: PanelSizes;
    viewerStates: Record<DocumentId, ViewerState>;
}

// Persisted form: Sets flattened to arrays, version tag.
export interface UiStateDto {
    version: number;
    tabs: { id: string; kind: 'library' | 'pdf'; documentId?: DocumentId }[];
    activeTabId: string;
    tree: { expandedFolderIds: FolderId[]; selectedId: string | null };
    panels: PanelSizes;
    viewerStates: Record<DocumentId, ViewerState>;
}

export const UI_STATE_VERSION = 1;

// ---------- Defaults ----------

const DEFAULT_UI: UIState = {
    tabs: [{ id: LIBRARY_TAB_ID, kind: 'library' }],
    activeTabId: LIBRARY_TAB_ID,
    tree: { expandedFolderIds: new Set(), selectedId: null },
    panels: { left: 20, right: 20 },
    viewerStates: {},
};

// ---------- Store ----------

interface StoreState {
    library: Library | null;
    ui: UIState;

    hydrate(libraryDto: LibraryDto, uiDto: UiStateDto | null): void;

    activateTab(id: string): void;
    closeTab(id: string): void;
    openDocument(documentId: DocumentId): void;

    toggleExpand(folderId: FolderId): void;
    selectTreeItem(id: DocumentId | FolderId | null): void;

    setPanelSizes(sizes: PanelSizes): void;
    setViewerState(documentId: DocumentId, state: ViewerState): void;
}

function indexLibrary(dto: LibraryDto): Library {
    const documents: Record<DocumentId, Document> = {};
    for (const d of dto.documents) documents[d.id] = d;

    const folders: Record<FolderId, Folder> = {};
    const childFolderIdsByParent: Record<FolderId, FolderId[]> = {};
    for (const f of dto.folders) {
        folders[f.id] = f;
        if (f.parentId !== null) {
            (childFolderIdsByParent[f.parentId] ??= []).push(f.id);
        }
    }
    return { documents, folders, rootFolderId: dto.rootFolderId, childFolderIdsByParent };
}

function pdfTabIdFor(documentId: DocumentId): string {
    return `pdf:${documentId}`;
}

function filterUiAgainstLibrary(ui: UIState, library: Library): UIState {
    const validTabs: Tab[] = ui.tabs.filter((t) => {
        if (t.kind === 'library') return true;
        return !!library.documents[t.documentId];
    });
    if (!validTabs.find((t) => t.id === LIBRARY_TAB_ID)) {
        validTabs.unshift({ id: LIBRARY_TAB_ID, kind: 'library' });
    }
    const activeStillValid = validTabs.some((t) => t.id === ui.activeTabId);
    const activeTabId = activeStillValid ? ui.activeTabId : LIBRARY_TAB_ID;

    const expanded = new Set<FolderId>();
    ui.tree.expandedFolderIds.forEach((id) => {
        if (library.folders[id]) expanded.add(id);
    });

    let selectedId = ui.tree.selectedId;
    if (selectedId && !library.folders[selectedId] && !library.documents[selectedId]) {
        selectedId = null;
    }

    const viewerStates: Record<DocumentId, ViewerState> = {};
    for (const [docId, vs] of Object.entries(ui.viewerStates)) {
        if (library.documents[docId]) viewerStates[docId] = vs;
    }

    return {
        tabs: validTabs,
        activeTabId,
        tree: { expandedFolderIds: expanded, selectedId },
        panels: ui.panels,
        viewerStates,
    };
}

function dtoToUi(dto: UiStateDto): UIState {
    return {
        tabs: dto.tabs.map((t) =>
            t.kind === 'library'
                ? { id: LIBRARY_TAB_ID, kind: 'library' }
                : { id: t.id, kind: 'pdf', documentId: t.documentId! },
        ),
        activeTabId: dto.activeTabId,
        tree: {
            expandedFolderIds: new Set(dto.tree.expandedFolderIds),
            selectedId: dto.tree.selectedId,
        },
        panels: dto.panels,
        viewerStates: dto.viewerStates,
    };
}

export const useStore = create<StoreState>()(
    subscribeWithSelector((set, get) => ({
        library: null,
        ui: DEFAULT_UI,

        hydrate(libraryDto, uiDto) {
            const library = indexLibrary(libraryDto);
            const base = uiDto ? dtoToUi(uiDto) : DEFAULT_UI;
            const ui = filterUiAgainstLibrary(base, library);
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
            const tabId = pdfTabIdFor(documentId);
            const exists = ui.tabs.some((t) => t.id === tabId);
            const tabs = exists ? ui.tabs : [...ui.tabs, { id: tabId, kind: 'pdf', documentId } as PdfTab];
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

// ---------- Serialization for persistence ----------

export function serializeUi(ui: UIState): UiStateDto {
    return {
        version: UI_STATE_VERSION,
        tabs: ui.tabs.map((t) =>
            t.kind === 'library'
                ? { id: t.id, kind: 'library' }
                : { id: t.id, kind: 'pdf', documentId: t.documentId },
        ),
        activeTabId: ui.activeTabId,
        tree: {
            expandedFolderIds: [...ui.tree.expandedFolderIds].sort(),
            selectedId: ui.tree.selectedId,
        },
        panels: ui.panels,
        viewerStates: ui.viewerStates,
    };
}
