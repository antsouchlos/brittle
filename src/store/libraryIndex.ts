import type {
    Document,
    DocumentId,
    Folder,
    FolderId,
    Library,
    TabState,
    UIState,
    PdfViewerState,
} from './types';
import type { SerializedLibrary } from '../ipc/wireTypes';
import { LIBRARY_TAB_ID } from './defaults';

export function indexLibrary(wire: SerializedLibrary): Library {
    const documents: Record<DocumentId, Document> = {};
    for (const d of wire.documents) documents[d.id] = d;

    const folders: Record<FolderId, Folder> = {};
    const folderChildren: Record<FolderId, FolderId[]> = {};
    for (const f of wire.folders) {
        folders[f.id] = f;
        if (f.parentId !== null) {
            (folderChildren[f.parentId] ??= []).push(f.id);
        }
    }
    return { documents, folders, rootFolderId: wire.rootFolderId, folderChildren };
}

export function pruneUiToLibrary(ui: UIState, library: Library): UIState {
    const validTabs: TabState[] = ui.tabs.filter((t) => {
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

    const viewerStates: Record<DocumentId, PdfViewerState> = {};
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
