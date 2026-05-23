import styles from './TreeView.module.css';

interface TreeNodeData {
    name: string;
    count?: number;
    children: TreeNodeData[];
}


interface TreeNodeProps {
    data: TreeNodeData;
}

function TreeNode({ data }: TreeNodeProps) {
    return (
        <div className={styles.node}>
            <div className={styles.nodeTitle}>
                <div
                    className={styles.nodeButton}
                    button-variant={data.children.length == 0 ? 'none' : 'expanded'}
                />
                <div className={styles.nodeName}>{data.name}</div>
                {data.count !== undefined && (
                    <div className={styles.nodeCount}>{data.count}</div>
                )}
            </div>
            <div className={styles.nodeChildren}>
                {data.children.map((node, idx) => (
                    <TreeNode
                        key={idx}
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
