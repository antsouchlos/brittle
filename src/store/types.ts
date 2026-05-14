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
    folderChildren: Record<FolderId, FolderId[]>;
}

// ---------- UI state ----------

export type LibraryTabState = { id: 'library'; kind: 'library' };
export type PdfTabState = { id: string; kind: 'pdf'; documentId: DocumentId };
export type TabState = LibraryTabState | PdfTabState;

// Shape kept open — embed-pdf integration will fill this in later.
export interface PdfViewerState {
    page?: number;
    zoom?: number;
    scrollY?: number;
}

export interface PanelSizes {
    left: number;   // percent
    right: number;  // percent
}

export interface UIState {
    tabs: TabState[];
    activeTabId: string;
    tree: {
        expandedFolderIds: Set<FolderId>;
        selectedId: DocumentId | FolderId | null;
    };
    panels: PanelSizes;
    viewerStates: Record<DocumentId, PdfViewerState>;
}
