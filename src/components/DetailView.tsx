import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { getFilename, type Metadata, type PublicationEntry } from '../app/LibraryModel';
import { logger } from '../app/logger';

function usePublicationSource(
    publication: PublicationEntry | null,
    bibEditorFocused: boolean,
    autosaveDebounceMs: number,
) {
    const [source, setSource] = useState('');
    const lastSavedRef = useRef('');
    const saveSeqRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const publicationRef = useRef(publication);
    const sourceRef = useRef(source);
    const prevPathStemRef = useRef<string | null>(null);
    const prevPubRef = useRef<PublicationEntry | null>(null);

    publicationRef.current = publication;
    sourceRef.current = source;

    const write = useCallback((pub: PublicationEntry, content: string) => {
        saveSeqRef.current += 1;
        lastSavedRef.current = content;
        invoke('write_publication_source', {
            pathStem: pub.pathStem,
            extension: pub.referenceFileExtension,
            content,
        }).catch(e => logger.error(String(e)));
    }, []);

    const flushTo = useCallback((pub: PublicationEntry) => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        const content = sourceRef.current;
        if (content === lastSavedRef.current) return;
        write(pub, content);
    }, [write]);

    // On a reload, a read that raced one of our own writes is discarded via
    // the save sequence, so stale content never clobbers newer keystrokes,
    // while genuine external changes are registered.
    useEffect(() => {
        const nextPathStem = publication?.pathStem ?? null;
        const isPublicationSwitch = prevPathStemRef.current !== nextPathStem;
        prevPathStemRef.current = nextPathStem;

        if (!publication) {
            setSource('');
            return;
        }

        let cancelled = false;
        const seqAtRead = saveSeqRef.current;

        invoke<string>('read_publication_source', {
            pathStem: publication.pathStem,
            extension: publication.referenceFileExtension,
        })
            .then(text => {
                if (cancelled) return;
                if (isPublicationSwitch) {
                    setSource(text);
                    lastSavedRef.current = text;
                    return;
                }
                if (saveSeqRef.current !== seqAtRead) return;
                if (text === lastSavedRef.current) return;
                setSource(text);
                lastSavedRef.current = text;
            })
            .catch(e => logger.error(String(e)));

        return () => {
            cancelled = true;
        };
    }, [publication]);

    // Flush unsaved edits before switching away from the current publication.
    useEffect(() => {
        const prev = prevPubRef.current;
        if (prev && prev.pathStem !== publication?.pathStem) {
            flushTo(prev);
        }
        prevPubRef.current = publication;
    }, [publication, flushTo]);

    // Debounced write on edit.
    useEffect(() => {
        if (!publication || source === lastSavedRef.current) return;

        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            write(publication, source);
        }, autosaveDebounceMs);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [source, publication, write, autosaveDebounceMs]);

    // Flush immediately when the editor loses focus.
    useEffect(() => {
        if (bibEditorFocused) return;
        if (publication) flushTo(publication);
    }, [bibEditorFocused, publication, flushTo]);

    return { source, setSource };
}

interface DetailViewProps {
    publication: PublicationEntry | null,
    metadata: Metadata | null,
    bibEditorFocused: boolean,
    onBibEditorFocusedChange: (value: boolean) => void,
    autosaveDebounceMs: number,
}

function DetailView(
    { publication, metadata, bibEditorFocused, onBibEditorFocusedChange, autosaveDebounceMs }: DetailViewProps
) {
    const { source, setSource } = usePublicationSource(publication, bibEditorFocused, autosaveDebounceMs);

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
