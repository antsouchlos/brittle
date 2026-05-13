import type { UIState } from './types';

export const LIBRARY_TAB_ID = 'library';
export const UI_STATE_VERSION = 1;

export const DEFAULT_UI: UIState = {
    tabs: [{ id: LIBRARY_TAB_ID, kind: 'library' }],
    activeTabId: LIBRARY_TAB_ID,
    tree: { expandedFolderIds: new Set(), selectedId: null },
    panels: { left: 20, right: 20 },
    viewerStates: {},
};
