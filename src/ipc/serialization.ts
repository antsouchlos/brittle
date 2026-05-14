import type { DocumentId, UIState } from '../store/types';
import { LIBRARY_TAB_ID, UI_STATE_VERSION } from '../store/defaults';
import type { SerializedUiState } from './wireTypes';

export function serializeUi(ui: UIState): SerializedUiState {
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

export function deserializeUi(wire: SerializedUiState): UIState {
    return {
        tabs: wire.tabs.map((t) =>
            t.kind === 'library'
                ? { id: LIBRARY_TAB_ID, kind: 'library' }
                : { id: t.id, kind: 'pdf', documentId: t.documentId as DocumentId },
        ),
        activeTabId: wire.activeTabId,
        tree: {
            expandedFolderIds: new Set(wire.tree.expandedFolderIds),
            selectedId: wire.tree.selectedId,
        },
        panels: wire.panels,
        viewerStates: wire.viewerStates,
    };
}
