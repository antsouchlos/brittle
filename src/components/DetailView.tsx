import { useEffect, useState } from 'react';
import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';

interface DetailViewProps {
    publisher: string,
    title: string,
    author: string,
    date: string,
    collection: string,
    filename: string,
    bibSource: string,
}

function DetailView(
    { publisher, title, author, date, collection, filename, bibSource }: DetailViewProps
) {
    const [bibContent, setBibContent] = useState('');

    useEffect(() => {
        setBibContent(bibSource);
    }, [bibSource]);

    return (
        <div className={styles.detailPane}>
            <div className={styles.detailBadgeRow}>
                <span className={styles.detailBadge}>{publisher}</span>
            </div>

            <dl className={styles.detailGrid}>
                <dt>Title</dt>
                <dd>{title}</dd>
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
    );
}

export default DetailView;
