import type { DocumentId, FolderId, Library } from '../store';
import styles from './LibraryLayout.module.css';

interface DetailPaneProps {
    library: Library;
    selectedId: DocumentId | FolderId | null;
}

export default function DetailPane({ library, selectedId }: DetailPaneProps) {
    const selectedFolder = selectedId ? library.folders[selectedId] : undefined;
    const selectedDoc = selectedId ? library.documents[selectedId] : undefined;

    return (
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
    );
}
