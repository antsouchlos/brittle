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

// ---------- UI state ----------

export type LibraryTab = { id: 'library'; kind: 'library' };
export type PdfTab = { id: string; kind: 'pdf'; documentId: DocumentId };
export type Tab = LibraryTab | PdfTab;

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
