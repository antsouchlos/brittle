import type { DocumentId, UIState } from '../store/types';
import { LIBRARY_TAB_ID, UI_STATE_VERSION } from '../store/defaults';
import type { UiStateDto } from './dtos';

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

export function dtoToUi(dto: UiStateDto): UIState {
    return {
        tabs: dto.tabs.map((t) =>
            t.kind === 'library'
                ? { id: LIBRARY_TAB_ID, kind: 'library' }
                : { id: t.id, kind: 'pdf', documentId: t.documentId as DocumentId },
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
