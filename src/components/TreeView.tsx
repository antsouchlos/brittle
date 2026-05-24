import { ReactNode, useState } from 'react';
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
}

function TreeNode({ data }: TreeNodeProps) {
    const icon = data.renderIcon?.();
    const isLeaf = data.children.length === 0;
    const [isExpanded, setIsExpanded] = useState(true);
    const buttonVariant = isLeaf ? 'none' : isExpanded ? 'expanded' : 'collapsed';

    return (
        <div className={styles.node}>
            <div className={styles.row}>
                {isLeaf ? (
                    <span
                        className={styles.foldButton}
                        button-variant={buttonVariant}
                        aria-hidden="true"
                    />
                ) : (
                    <button
                        type="button"
                        className={styles.foldButton}
                        button-variant={buttonVariant}
                        aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
                        onClick={() => setIsExpanded((expanded) => !expanded)}
                    >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                )}
                <div className={styles.label}>
                    {icon !== undefined && (
                        <span className={styles.icon}>{icon}</span>
                    )}
                    <span className={styles.text}>{data.name}</span>
                    {data.count !== undefined && (
                        <span className={styles.count}>{data.count}</span>
                    )}
                </div>
            </div>
            {isExpanded && (
                <div className={styles.children}>
                    {data.children.map((node) => (
                        <TreeNode
                            key={node.id}
                            data={node}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}


interface DirectoryTreeViewProps {
    root: TreeNodeData;
}

export default function DirectoryTreeView({ root }: DirectoryTreeViewProps) {
    return (
        <TreeNode data={root} />
    );
}
