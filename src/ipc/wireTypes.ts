import type {
    Document,
    DocumentId,
    FolderId,
    PanelSizes,
    PdfViewerState,
} from '../store/types';

// The JSON shape Rust returns from `load_library` (flat lists; the runtime
// `Library` derives `folderChildren` on initialize).
export interface SerializedLibrary {
    documents: Document[];
    folders: { id: FolderId; name: string; parentId: FolderId | null; documentIds: DocumentId[] }[];
    rootFolderId: FolderId;
}

// The JSON shape of persisted UI state: Sets flattened to arrays, version tag.
export interface SerializedUiState {
    version: number;
    tabs: { id: string; kind: 'library' | 'pdf'; documentId?: DocumentId }[];
    activeTabId: string;
    tree: { expandedFolderIds: FolderId[]; selectedId: string | null };
    panels: PanelSizes;
    viewerStates: Record<DocumentId, PdfViewerState>;
}
