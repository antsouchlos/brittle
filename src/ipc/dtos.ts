import type {
    Document,
    DocumentId,
    FolderId,
    PanelSizes,
    ViewerState,
} from '../store/types';

// DTO returned from Rust (flat lists; the runtime `Library` derives
// `childFolderIdsByParent` on hydration).
export interface LibraryDto {
    documents: Document[];
    folders: { id: FolderId; name: string; parentId: FolderId | null; documentIds: DocumentId[] }[];
    rootFolderId: FolderId;
}

// Persisted UI state: Sets flattened to arrays, version tag.
export interface UiStateDto {
    version: number;
    tabs: { id: string; kind: 'library' | 'pdf'; documentId?: DocumentId }[];
    activeTabId: string;
    tree: { expandedFolderIds: FolderId[]; selectedId: string | null };
    panels: PanelSizes;
    viewerStates: Record<DocumentId, ViewerState>;
}
