import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import styles from './ThreePaneLayout.module.css';

interface TreeNodeData {
    id: string;
    name: string;
    children?: TreeNodeData[];
    type?: string;
    description?: string;
    status?: string;
}

interface TreeNodeProps {
    node: TreeNodeData;
    depth: number;
    selectedId: string | undefined;
    onSelect: (node: TreeNodeData) => void;
    expandedIds: Set<string>;
    toggleExpand: (id: string) => void;
}

interface PropertyRowProps {
    label: string;
    value: string;
}

const initialTree: TreeNodeData[] = [
    {
        id: '1',
        name: 'Projects',
        children: [
            {
                id: '1-1',
                name: 'Website Redesign',
                children: [
                    { id: '1-1-1', name: 'Homepage', type: 'page', description: 'Main landing page', status: 'In progress' },
                    { id: '1-1-2', name: 'About', type: 'page', description: 'About us page', status: 'Done' },
                ],
            },
            {
                id: '1-2',
                name: 'Mobile App',
                children: [
                    { id: '1-2-1', name: 'Login Flow', type: 'flow', description: 'User authentication', status: 'In review' },
                ],
            },
        ],
    },
    {
        id: '2',
        name: 'Archived',
        children: [
            { id: '2-1', name: 'Old Logo Concepts', type: 'asset', description: 'Legacy brand work', status: 'Archived' },
        ],
    },
];

function TreeNode({ node, depth, selectedId, onSelect, expandedIds, toggleExpand }: TreeNodeProps) {
    const hasChildren = !!node.children && node.children.length > 0;
    const isExpanded = expandedIds.has(node.id);
    const isSelected = selectedId === node.id;

    return (
        <div>
            <div
                className={styles.treeRow}
                data-selected={isSelected}
                tabIndex={0}
                role="treeitem"
                aria-expanded={hasChildren ? isExpanded : undefined}
                aria-selected={isSelected}
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={() => {
                    onSelect(node);
                    if (hasChildren) toggleExpand(node.id);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onSelect(node);
                        if (hasChildren) toggleExpand(node.id);
                    }
                }}
            >
                {hasChildren ? (
                    isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                ) : (
                    <span className={styles.treeChevronSpacer} />
                )}
                {hasChildren ? <Folder size={14} /> : <FileText size={14} />}
                <span>{node.name}</span>
            </div>
            {hasChildren && isExpanded && node.children!.map((child) => (
                <TreeNode
                    key={child.id}
                    node={child}
                    depth={depth + 1}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    expandedIds={expandedIds}
                    toggleExpand={toggleExpand}
                />
            ))}
        </div>
    );
}

export default function ThreePaneLayout() {
    const [selected, setSelected] = useState<TreeNodeData | null>(null);
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['1', '1-1']));

    const toggleExpand = (id: string) => {
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <div className={styles.root}>
            <Group orientation="horizontal" className={styles.group}>
                <Panel defaultSize="20%" minSize="10%" maxSize="40%">
                    <aside className={styles.sidebar}>
                        <div className={styles.sectionHeader}>Explorer</div>
                        {initialTree.map((node) => (
                            <TreeNode
                                key={node.id}
                                node={node}
                                depth={0}
                                selectedId={selected?.id}
                                onSelect={setSelected}
                                expandedIds={expandedIds}
                                toggleExpand={toggleExpand}
                            />
                        ))}
                    </aside>
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize="60%" minSize="30%">
                    <main className={styles.main}>
                        {selected ? (
                            <>
                                <h1 className={styles.title}>{selected.name}</h1>
                                <p className={styles.description}>
                                    {selected.description || 'No description available.'}
                                </p>
                                <div className={styles.contentBox}>
                                    Center content goes here. Drop in an editor, viewer, or whatever this node represents.
                                </div>
                            </>
                        ) : (
                            <div className={styles.empty}>Select an item from the tree to view it.</div>
                        )}
                    </main>
                </Panel>

                <Separator className={styles.separator} />

                <Panel defaultSize="20%" minSize="10%" maxSize="40%">
                    <aside className={styles.sidebarPadded}>
                        <div className={styles.sectionHeaderTight}>Properties</div>
                        {selected ? (
                            <div className={styles.properties}>
                                <PropertyRow label="ID" value={selected.id} />
                                <PropertyRow label="Name" value={selected.name} />
                                <PropertyRow label="Type" value={selected.type || 'folder'} />
                                <PropertyRow label="Status" value={selected.status || '—'} />
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

function PropertyRow({ label, value }: PropertyRowProps) {
    return (
        <div>
            <div className={styles.propertyLabel}>{label}</div>
            <div className={styles.propertyValue}>{value}</div>
        </div>
    );
}
