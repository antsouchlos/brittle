import type { DocumentId, FolderId, Library } from '../store';
import styles from './LibraryLayout.module.css';

interface PropertiesPaneProps {
    library: Library;
    selectedId: DocumentId | FolderId | null;
}

export default function PropertiesPane({ library, selectedId }: PropertiesPaneProps) {
    const selectedFolder = selectedId ? library.folders[selectedId] : undefined;
    const selectedDoc = selectedId ? library.documents[selectedId] : undefined;

    return (
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
