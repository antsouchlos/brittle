import { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import styles from './TreeView.module.css';

interface TreeNodeData {
    id: string,
    name: string;
    count?: number;
    children: TreeNodeData[];
    renderIcon?: () => ReactNode;
}


interface TreeNodeProps {
    data: TreeNodeData;
    isExpanded: (id: string) => boolean;
    isSelected: (id: string) => boolean;
    toggleExpanded: (id: string) => void;
    setSelected: (id: string) => void;
}

function TreeNode(
    { data, isExpanded, isSelected, toggleExpanded, setSelected }: TreeNodeProps
) {
    const icon = data.renderIcon?.();
    const isLeaf = data.children.length === 0;
    const expanded = isExpanded(data.id);
    const selected = isSelected(data.id);
    const buttonVariant = isLeaf ? 'none' : expanded ? 'expanded' : 'collapsed';

    return (
        <div
            className={styles.node}
            data-selected={selected || undefined}
        >
            <div className={styles.row}>
                {isLeaf ? (
                    <span
                        className={styles.foldButton}
                        button-variant={buttonVariant}
                        aria-hidden="true"
                    />
                ) : (
                    <div
                        className={styles.foldButton}
                        button-variant={buttonVariant}
                        aria-label={expanded ? 'Collapse folder' : 'Expand folder'}
                        onClick={() => toggleExpanded(data.id)}
                    >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </div>
                )}
                <div
                    className={styles.label}
                    onClick={() => {
                        if (selected && !isLeaf) {
                            toggleExpanded(data.id);
                            return;
                        }

                        setSelected(data.id);
                    }}
                >
                    {icon !== undefined && (
                        <span className={styles.icon}>{icon}</span>
                    )}
                    <span className={styles.text}>{data.name}</span>
                    {data.count !== undefined && (
                        <span className={styles.count}>{data.count}</span>
                    )}
                </div>
            </div>
            {expanded && (
                <div className={styles.children}>
                    {data.children.map((node) => (
                        <TreeNode
                            key={node.id}
                            data={node}
                            isExpanded={isExpanded}
                            isSelected={isSelected}
                            toggleExpanded={toggleExpanded}
                            setSelected={setSelected}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}


interface TreeViewProps {
    root: TreeNodeData;
    selectedNodeId: string;
    expandedNodeIds: Array<string>;
    onToggleExpanded: (id: string) => void;
    onSelectNode: (id: string) => void;
}

export default function TreeView(
    { root, selectedNodeId, expandedNodeIds, onToggleExpanded, onSelectNode }: TreeViewProps
) {
    const isExpanded = (id: string) => expandedNodeIds.includes(id);
    const isSelected = (id: string) => selectedNodeId === id;

    return (
        <TreeNode
            data={root}
            isExpanded={isExpanded}
            isSelected={isSelected}
            toggleExpanded={onToggleExpanded}
            setSelected={onSelectNode}
        />
    );
}
