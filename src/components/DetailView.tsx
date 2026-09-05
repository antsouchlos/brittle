import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { getFilename, type Metadata, type PublicationEntry } from '../app/LibraryModel';
import { logger } from '../app/logger';

function usePublicationSource(publication: PublicationEntry | null) {
    const [source, setSource] = useState('');

    useEffect(() => {
        if (!publication) {
            setSource('');
            return;
        }

        let cancelled = false;

        invoke<string>('read_publication_source', {
            pathStem: publication.pathStem,
            extension: publication.referenceFileExtension,
        })
            .then(text => {
                if (!cancelled) setSource(text);
            })
            .catch(e => logger.error(String(e)));

        return () => {
            cancelled = true;
        };
    }, [publication]);

    return { source, setSource };
}

interface DetailViewProps {
    publication: PublicationEntry | null,
    metadata: Metadata | null,
    bibEditorFocused: boolean,
    onBibEditorFocusedChange: (value: boolean) => void,
}

function DetailView(
    { publication, metadata, bibEditorFocused, onBibEditorFocusedChange }: DetailViewProps
) {
    const { source, setSource } = usePublicationSource(publication);

    const publisher = metadata?.publisher ?? '';
    const title = metadata?.title ?? '';
    const author = metadata?.author ?? '';
    const date = metadata?.year ? String(metadata.year) : '';
    const collection = publication ? getFilename(publication.parentDirectoryPath) : '';
    const filename = publication ? getFilename(publication.pathStem) : '';

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
                value={source}
                onChange={setSource}
                focused={bibEditorFocused}
                onFocusedChange={onBibEditorFocusedChange}
            />
        </div>
    );
}

export default DetailView;
