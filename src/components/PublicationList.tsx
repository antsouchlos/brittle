import styles from './PublicationList.module.css';

interface Publication {
    id: string;
    title: string;
    author: string;
    journal: string;
    date: string;
}

interface PublicationListProps {
    publications: Array<Publication>
    selectedPublicationId: string;
    onSelectPublication: (key: string) => void;
}

function PublicationList({
    publications,
    selectedPublicationId,
    onSelectPublication,
}: PublicationListProps) {
    return (
        <div className={styles.publicationList}>
            <div className={styles.list}>
                {publications.map((pub) => (
                    <div
                        key={pub.id}
                        className={styles.card}
                        data-selected={selectedPublicationId === pub.id ? 'true' : 'false'}
                        onClick={() => onSelectPublication(pub.id)}
                    >
                        <div className={styles.cardTopRow}>
                            <div className={styles.journal}>{pub.journal}</div>
                            <div className={styles.dateBadge}>{pub.date}</div>
                        </div>
                        <span className={styles.cardTitle}>{pub.title}</span>
                        <span className={styles.author}>{pub.author}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default PublicationList;
