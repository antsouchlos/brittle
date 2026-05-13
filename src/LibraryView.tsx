import ThreePaneLayout from './ThreePaneLayout';
import { useLibrary, usePanels, useStore, useTreeState } from './store';

/**
 * Adapter between the store and the (purely presentational) ThreePaneLayout.
 * Reads slices via selector hooks; dispatches via actions pulled from the
 * store. ThreePaneLayout itself never touches the store.
 */
export default function LibraryView() {
    const library = useLibrary();
    const { expandedFolderIds, selectedId } = useTreeState();
    const panels = usePanels();
    const toggleExpand = useStore((s) => s.toggleExpand);
    const selectTreeItem = useStore((s) => s.selectTreeItem);
    const openDocument = useStore((s) => s.openDocument);
    const setPanelSizes = useStore((s) => s.setPanelSizes);

    if (!library) return null;

    return (
        <ThreePaneLayout
            library={library}
            expandedFolderIds={expandedFolderIds}
            selectedId={selectedId}
            panelSizes={panels}
            onToggleExpand={toggleExpand}
            onSelect={selectTreeItem}
            onOpenDocument={openDocument}
            onPanelResize={setPanelSizes}
        />
    );
}
