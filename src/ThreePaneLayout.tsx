import { ChevronRight, ChevronDown, Folder as FolderIcon, FileText } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type {
    DocumentId,
    Folder,
    FolderId,
    Library,
    PanelSizes,
} from './store';
import styles from './ThreePaneLayout.module.css';

interface ThreePaneLayoutProps {
    library: Library;
    expandedFolderIds: Set<FolderId>;
    selectedId: DocumentId | FolderId | null;
    panelSizes: PanelSizes;
    onToggleExpand(folderId: FolderId): void;
    onSelect(id: DocumentId | FolderId): void;
    onOpenDocument(id: DocumentId): void;
    onPanelResize(sizes: PanelSizes): void;
}

export default function ThreePaneLayout({
    library,
    expandedFolderIds,
    selectedId,
    panelSizes,
    onToggleExpand,
    onSelect,
    onOpenDocument,
    onPanelResize,
}: ThreePaneLayoutProps) {
    const rootFolder = library.folders[library.rootFolderId];
    const selectedFolder = selectedId ? library.folders[selectedId] : undefined;
    const selectedDoc = selectedId ? library.documents[selectedId] : undefined;

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
                        <FolderNode
                            folder={rootFolder}
                            depth={0}
                            library={library}
                            expandedFolderIds={expandedFolderIds}
                            selectedId={selectedId}
                            onToggleExpand={onToggleExpand}
                            onSelect={onSelect}
                            onOpenDocument={onOpenDocument}
                            isRoot
                        />
                    </aside>
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize={`${middleSize}%`} minSize="30%">
                    <main className={styles.main}>
                        {selectedDoc ? (
                            <>
                                <h1 className={styles.title}>{selectedDoc.title}</h1>
                                <p className={styles.description}>{selectedDoc.path}</p>
                                <div className={styles.contentBox}>
                                    Double-click the document in the tree (or press Enter) to open it in a new tab.
                                </div>
                            </>
                        ) : selectedFolder ? (
                            <>
                                <h1 className={styles.title}>{selectedFolder.name}</h1>
                                <p className={styles.description}>
                                    {selectedFolder.documentIds.length} document(s)
                                </p>
                            </>
                        ) : (
                            <div className={styles.empty}>Select an item from the tree to view it.</div>
                        )}
                    </main>
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize={`${panelSizes.right}%`} minSize="10%" maxSize="40%">
                    <aside className={styles.sidebarPadded}>
                        <div className={styles.sectionHeaderTight}>Properties</div>
                        {selectedDoc ? (
                            <div className={styles.properties}>
                                <PropertyRow label="ID" value={selectedDoc.id} />
                                <PropertyRow label="Title" value={selectedDoc.title} />
                                <PropertyRow label="Path" value={selectedDoc.path} />
                                {selectedDoc.tags && selectedDoc.tags.length > 0 && (
                                    <PropertyRow label="Tags" value={selectedDoc.tags.join(', ')} />
                                )}
                            </div>
                        ) : selectedFolder ? (
                            <div className={styles.properties}>
                                <PropertyRow label="ID" value={selectedFolder.id} />
                                <PropertyRow label="Name" value={selectedFolder.name} />
                                <PropertyRow label="Type" value="folder" />
                                <PropertyRow
                                    label="Documents"
                                    value={String(selectedFolder.documentIds.length)}
                                />
                            </div>
                        ) : (
                            <div className={styles.emptySmall}>Nothing selected.</div>
                        )}
                    </aside>
                </Panel>
            </Group>
        </div>
    );
}

interface FolderNodeProps {
    folder: Folder;
    depth: number;
    library: Library;
    expandedFolderIds: Set<FolderId>;
    selectedId: DocumentId | FolderId | null;
    onToggleExpand(folderId: FolderId): void;
    onSelect(id: DocumentId | FolderId): void;
    onOpenDocument(id: DocumentId): void;
    isRoot?: boolean;
}

function FolderNode({
    folder,
    depth,
    library,
    expandedFolderIds,
    selectedId,
    onToggleExpand,
    onSelect,
    onOpenDocument,
    isRoot,
}: FolderNodeProps) {
    const childFolderIds = library.childFolderIdsByParent[folder.id] ?? [];
    const hasChildren = childFolderIds.length > 0 || folder.documentIds.length > 0;
    // The root folder is always expanded and not rendered as a row.
    const isExpanded = isRoot ? true : expandedFolderIds.has(folder.id);
    const isSelected = selectedId === folder.id;

    return (
        <div>
            {!isRoot && (
                <div
                    className={styles.treeRow}
                    data-selected={isSelected}
                    tabIndex={0}
                    role="treeitem"
                    aria-expanded={hasChildren ? isExpanded : undefined}
                    aria-selected={isSelected}
                    style={{ paddingLeft: 8 + depth * 16 }}
                    onClick={() => {
                        onSelect(folder.id);
                        if (hasChildren) onToggleExpand(folder.id);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(folder.id);
                            if (hasChildren) onToggleExpand(folder.id);
                        }
                    }}
                >
                    {hasChildren ? (
                        isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                    ) : (
                        <span className={styles.treeChevronSpacer} />
                    )}
                    <FolderIcon size={14} />
                    <span>{folder.name}</span>
                </div>
            )}
            {isExpanded && (
                <>
                    {childFolderIds.map((cid) => (
                        <FolderNode
                            key={cid}
                            folder={library.folders[cid]}
                            depth={isRoot ? 0 : depth + 1}
                            library={library}
                            expandedFolderIds={expandedFolderIds}
                            selectedId={selectedId}
                            onToggleExpand={onToggleExpand}
                            onSelect={onSelect}
                            onOpenDocument={onOpenDocument}
                        />
                    ))}
                    {folder.documentIds.map((docId) => {
                        const doc = library.documents[docId];
                        if (!doc) return null;
                        const isDocSelected = selectedId === doc.id;
                        return (
                            <div
                                key={doc.id}
                                className={styles.treeRow}
                                data-selected={isDocSelected}
                                tabIndex={0}
                                role="treeitem"
                                aria-selected={isDocSelected}
                                style={{ paddingLeft: 8 + (isRoot ? 0 : depth + 1) * 16 }}
                                onClick={() => onSelect(doc.id)}
                                onDoubleClick={() => onOpenDocument(doc.id)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        onOpenDocument(doc.id);
                                    } else if (e.key === ' ') {
                                        e.preventDefault();
                                        onSelect(doc.id);
                                    }
                                }}
                            >
                                <span className={styles.treeChevronSpacer} />
                                <FileText size={14} />
                                <span>{doc.title}</span>
                            </div>
                        );
                    })}
                </>
            )}
        </div>
    );
}

function PropertyRow({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div className={styles.propertyLabel}>{label}</div>
            <div className={styles.propertyValue}>{value}</div>
        </div>
    );
}
