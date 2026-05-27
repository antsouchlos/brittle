import { useState } from 'react';
import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';

interface DetailViewProps {
    journal: string,
    author: string,
    date: string,
    collection: string,
    filename: string,
}

function DetailView({ journal, author, date, collection, filename }: DetailViewProps) {
    const [bibContent, setBibContent] = useState(`${journal}\n${author}\n${date}\n${collection}\n${filename}`);

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

                <VimTextArea
                    value={bibContent}
                    onChange={setBibContent}
                />
            </div>
        </div>
    );
}

export default DetailView;
