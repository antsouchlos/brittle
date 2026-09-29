import { ReactNode, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import styles from './TreeView.module.css';
import { Action, useActionHandler } from '../app/actions';
import { useRestoredState } from '../app/uiState';

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
    onSelectNode: (id: string) => void;
    // Key the expanded nodes are restored from and saved under.
    persistKey: string;
}

function collectVisibleNodeIds(node: TreeNodeData, isExpanded: (id: string) => boolean): string[] {
    if (!isExpanded(node.id)) return [node.id];
    return [node.id, ...node.children.flatMap(child => collectVisibleNodeIds(child, isExpanded))];
}

function collectAllNodeIds(node: TreeNodeData): string[] {
    return [node.id, ...node.children.flatMap(collectAllNodeIds)];
}

function useDropRemovedIds(
    root: TreeNodeData,
    setExpandedNodeIds: (value: string[] | ((prev: string[]) => string[])) => void,
) {
    useEffect(() => {
        const presentIds = new Set(collectAllNodeIds(root));
        setExpandedNodeIds(prev => {
            const pruned = prev.filter(id => presentIds.has(id));
            if (pruned.length === prev.length) return prev;
            return pruned.length > 0 ? pruned : [root.id];
        });
    }, [root, setExpandedNodeIds]);
}

export default function TreeView(
    { root, selectedNodeId, onSelectNode, persistKey }: TreeViewProps
) {
    const [expandedNodeIds, setExpandedNodeIds] = useRestoredState<string[]>(persistKey, [root.id]);

    const isExpanded = (id: string) => expandedNodeIds.includes(id);
    const isSelected = (id: string) => selectedNodeId === id;

    const toggleExpanded = (id: string) => {
        setExpandedNodeIds(prev => (
            prev.includes(id)
                ? prev.filter(expandedId => expandedId !== id)
                : [...prev, id]
        ));
    };


    const cycleSelection = (delta: 1 | -1) => {
        const visibleIds = collectVisibleNodeIds(root, isExpanded);
        const currentIdx = visibleIds.indexOf(selectedNodeId);
        if (visibleIds.length === 0) return;
        const nextIdx = (currentIdx + delta + visibleIds.length) % visibleIds.length;
        onSelectNode(visibleIds[nextIdx]);
    };

    useActionHandler(Action.CycleNext, () => cycleSelection(1));
    useActionHandler(Action.CyclePrev, () => cycleSelection(-1));

    useDropRemovedIds(root, setExpandedNodeIds);

    return (
        <TreeNode
            data={root}
            isExpanded={isExpanded}
            isSelected={isSelected}
            toggleExpanded={toggleExpanded}
            setSelected={onSelectNode}
        />
    );
}
