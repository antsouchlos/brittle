import { Group, Panel, Separator } from 'react-resizable-panels';
import type { DocumentId, FolderId, Library, PanelSizes } from '../store';
import FolderTree from './FolderTree';
import DetailPane from './DetailPane';
import PropertiesPane from './PropertiesPane';
import styles from './LibraryLayout.module.css';

interface LibraryLayoutProps {
    library: Library;
    expandedFolderIds: Set<FolderId>;
    selectedId: DocumentId | FolderId | null;
    panelSizes: PanelSizes;
    onToggleExpand(folderId: FolderId): void;
    onSelect(id: DocumentId | FolderId): void;
    onOpenDocument(id: DocumentId): void;
    onPanelResize(sizes: PanelSizes): void;
}

export default function LibraryLayout({
    library,
    expandedFolderIds,
    selectedId,
    panelSizes,
    onToggleExpand,
    onSelect,
    onOpenDocument,
    onPanelResize,
}: LibraryLayoutProps) {
    const middleSize = Math.max(10, 100 - panelSizes.left - panelSizes.right);

    return (
        <div className={styles.root}>
            <Group
                orientation="horizontal"
                className={styles.group}
                onLayoutChange={(sizes) => {
                    if (sizes.length >= 3) {
                        onPanelResize({ left: sizes[0], right: sizes[2] });
                    }
                }}
            >
                <Panel defaultSize={`${panelSizes.left}%`} minSize="10%" maxSize="40%">
                    <aside className={styles.sidebar}>
                        <div className={styles.sectionHeader}>Explorer</div>
                        <FolderTree
                            library={library}
                            expandedFolderIds={expandedFolderIds}
                            selectedId={selectedId}
                            onToggleExpand={onToggleExpand}
                            onSelect={onSelect}
                            onOpenDocument={onOpenDocument}
                        />
                    </aside>
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize={`${middleSize}%`} minSize="30%">
                    <DetailPane library={library} selectedId={selectedId} />
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize={`${panelSizes.right}%`} minSize="10%" maxSize="40%">
                    <PropertiesPane library={library} selectedId={selectedId} />
                </Panel>
            </Group>
        </div>
    );
}
