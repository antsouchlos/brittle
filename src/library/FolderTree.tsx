import { ChevronRight, ChevronDown, Folder as FolderIcon, FileText } from 'lucide-react';
import type { Document, DocumentId, Folder, FolderId, Library } from '../store';
import styles from './LibraryLayout.module.css';

interface FolderTreeProps {
    library: Library;
    expandedFolderIds: Set<FolderId>;
    selectedId: DocumentId | FolderId | null;
    onToggleExpand(folderId: FolderId): void;
    onSelect(id: DocumentId | FolderId): void;
    onOpenDocument(id: DocumentId): void;
}

export default function FolderTree({
    library,
    expandedFolderIds,
    selectedId,
    onToggleExpand,
    onSelect,
    onOpenDocument,
}: FolderTreeProps) {
    const rootFolder = library.folders[library.rootFolderId];
    return (
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
    const childFolderIds = library.folderChildren[folder.id] ?? [];
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
                        return (
                            <DocumentRow
                                key={doc.id}
                                doc={doc}
                                depth={isRoot ? 0 : depth + 1}
                                isSelected={selectedId === doc.id}
                                onSelect={onSelect}
                                onOpenDocument={onOpenDocument}
                            />
                        );
                    })}
                </>
            )}
        </div>
    );
}

interface DocumentRowProps {
    doc: Document;
    depth: number;
    isSelected: boolean;
    onSelect(id: DocumentId): void;
    onOpenDocument(id: DocumentId): void;
}

function DocumentRow({ doc, depth, isSelected, onSelect, onOpenDocument }: DocumentRowProps) {
    return (
        <div
            className={styles.treeRow}
            data-selected={isSelected}
            tabIndex={0}
            role="treeitem"
            aria-selected={isSelected}
            style={{ paddingLeft: 8 + depth * 16 }}
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
}
