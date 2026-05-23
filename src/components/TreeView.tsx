import { ReactNode } from 'react';
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

    return (
        <div className={styles.node}>
            <div className={styles.row}>
                <div
                    className={styles.foldButton}
                    button-variant={
                        data.children.length == 0 ? 'none' : 'expanded'
                    }
                />
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
            <div className={styles.children}>
                {data.children.map((node) => (
                    <TreeNode
                        key={node.id}
                        data={node}
                    />
                ))}
            </div>
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
