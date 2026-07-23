import { useEffect, useRef, RefObject } from 'react';
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

function useScrollToSelected(
    containerRef: RefObject<HTMLDivElement | null>,
    selectedId: string,
) {
    useEffect(() => {
        containerRef.current
            ?.querySelector<HTMLElement>('[data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, [selectedId]);
}

function PublicationList({
    publications,
    selectedPublicationId,
    onSelectPublication,
}: PublicationListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    useScrollToSelected(listRef, selectedPublicationId);

    return (
        <div className={styles.publicationList} ref={listRef}>
            <div className={styles.list}>
                {publications.map((pub) => (
                    <div
                        key={pub.id}
                        className={styles.card}
                        data-selected={selectedPublicationId === pub.id ? 'true' : 'false'}
                        onClick={() => onSelectPublication(pub.id)}
                    >
                        <div className={styles.cardTopRow}>
                            <span className={styles.journal}>{pub.journal}</span>
                            <span className={styles.dateBadge}>{pub.date}</span>
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
