import styles from './DetailView.module.css';

interface DetailViewProps {
    journal: string,
    author: string,
    date: string,
    collection: string,
    filename: string,
}

function DetailView({ journal, author, date, collection, filename }: DetailViewProps) {
    return (
        <div>
            <div className={styles.detailPane}>
                <div className={styles.detailBadgeRow}>
                    <span className={styles.detailBadge}>{journal}</span>
                </div>

                <dl className={styles.detailGrid}>
                    <dt>Author</dt>
                    <dd>{author}</dd>
                    <dt>Published</dt>
                    <dd>{date}</dd>
                    <dt>Collection</dt>
                    <dd>{collection}</dd>
                    <dt>Filename</dt>
                    <dd>{filename}</dd>
                </dl>

                <p className={styles.detailSummary}>
                    Sample metadata pane styled after the previous Brittle UI:
                    compact, information-dense, and visually quiet so the
                    document tabs stay the primary focus.
                </p>
            </div>
        </div>
    );
}

export default DetailView;
