import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { getFilename, type Metadata, type PublicationEntry } from '../app/LibraryModel';
import { logger } from '../app/logger';

interface SourceEntry {
    source: string;
    diskText: string | null;
    pub: PublicationEntry;
    version: number;
    queue: Promise<void>;
}

// Keeps the disk as source of truth for the active publication's bib source
// and autosaves edits.
function usePublicationSource(
    publication: PublicationEntry | null,
    bibEditorFocused: boolean,
    autosaveDebounceMs: number,
) {
    const entriesRef = useRef(new Map<string, SourceEntry>());
    const publicationRef = useRef(publication);
    const [, setRenderVersion] = useState(0);
    const forceRender = useCallback(() => setRenderVersion(v => v + 1), []);

    const activeStem = publication?.pathStem ?? null;
    const activeStemRef = useRef(activeStem);
    const prevStemRef = useRef<string | null>(null);
    const prevPublicationRef = useRef<PublicationEntry | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    publicationRef.current = publication;
    activeStemRef.current = activeStem;

    const clearDebounceTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const ensureSourceEntry = useCallback((stem: string, pub: PublicationEntry): SourceEntry => {
        let sourceEntry = entriesRef.current.get(stem);
        if (!sourceEntry) {
            sourceEntry = { source: '', diskText: null, pub, version: 0, queue: Promise.resolve() };
            entriesRef.current.set(stem, sourceEntry);
        } else {
            sourceEntry.pub = pub;
        }
        return sourceEntry;
    }, []);

    // Serializes disk operations per buffer, so a read never runs while one of
    // our own writes is mid-flight and mistakes the pre-write file for an
    // external change.
    const enqueue = useCallback((sourceEntry: SourceEntry, op: () => Promise<void>) => {
        sourceEntry.queue = sourceEntry.queue
            .then(op)
            .catch(e => logger.error(String(e)));
    }, []);

    const persist = useCallback((stem: string) => {
        const sourceEntry = entriesRef.current.get(stem);
        if (!sourceEntry || sourceEntry.diskText === null) return;
        enqueue(sourceEntry, async () => {
            const current = entriesRef.current.get(stem);
            if (!current) return;
            const content = current.source;
            if (content === current.diskText) return;
            await invoke('write_publication_source', {
                pathStem: current.pub.pathStem,
                extension: current.pub.referenceFileExtension,
                content,
            });
            current.diskText = content;
        });
    }, [enqueue]);

    // Reads disk and, when the file changed externally (read differs from the
    // last confirmed disk text), replaces the buffer over any unsaved typing.
    const sync = useCallback((stem: string) => {
        const pub = publicationRef.current;
        if (!pub || pub.pathStem !== stem) return;
        const sourceEntry = ensureSourceEntry(stem, pub);
        enqueue(sourceEntry, async () => {
            const current = entriesRef.current.get(stem);
            if (!current) return;
            const text = await invoke<string>('read_publication_source', {
                pathStem: current.pub.pathStem,
                extension: current.pub.referenceFileExtension,
            });
            if (activeStemRef.current !== stem) return;
            if (text === current.diskText) return;
            current.diskText = text;
            if (text === current.source) return;
            clearDebounceTimer();
            current.source = text;
            current.version += 1;
            forceRender();
        });
    }, [clearDebounceTimer, enqueue, ensureSourceEntry, forceRender]);

    const handleSourceChange = useCallback((value: string) => {
        const stem = activeStemRef.current;
        const pub = publicationRef.current;
        if (!stem || !pub) return;
        const sourceEntry = ensureSourceEntry(stem, pub);
        if (sourceEntry.source === value) return;
        sourceEntry.source = value;

        clearDebounceTimer();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            persist(stem);
        }, autosaveDebounceMs);

        forceRender();
    }, [autosaveDebounceMs, clearDebounceTimer, ensureSourceEntry, forceRender, persist]);

    const flush = useCallback((stem: string) => {
        if (!entriesRef.current.has(stem)) return;
        clearDebounceTimer();
        persist(stem);
    }, [clearDebounceTimer, persist]);

    // Flush the publication we are leaving. Only the active publication can be
    // dirty, so writes stay uncontended between publications.
    useEffect(() => {
        const prevStem = prevStemRef.current;
        prevStemRef.current = activeStem;
        if (prevStem !== null && prevStem !== activeStem) {
            flush(prevStem);
        }
    }, [activeStem, flush]);

    // Re-read the disk on every activation: returning to a publication always
    // reflects its current file content.
    useEffect(() => {
        if (!activeStem) return;
        sync(activeStem);
    }, [activeStem, sync]);

    // A rescan (library-changed) replaces the publication record for the open
    // publication while its path stem is unchanged. That is the signal that
    // its file may have changed on disk, so re-read it. Genuine switches have
    // a different stem and are handled by the activation effect.
    useEffect(() => {
        const prev = prevPublicationRef.current;
        prevPublicationRef.current = publication;
        if (!publication) return;
        if (!prev || prev.pathStem !== publication.pathStem) return;
        if (prev === publication) return;
        sync(publication.pathStem);
    }, [publication, sync]);

    // Flush immediately when the editor loses focus.
    useEffect(() => {
        if (bibEditorFocused) return;
        const stem = activeStemRef.current;
        if (stem) flush(stem);
    }, [bibEditorFocused, flush]);

    const sourceEntry = activeStem ? entriesRef.current.get(activeStem) ?? null : null;

    return {
        value: sourceEntry ? sourceEntry.source : '',
        version: sourceEntry ? sourceEntry.version : 0,
        onChange: handleSourceChange,
    };
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
    const { value, version, onChange } = usePublicationSource(
        publication,
        bibEditorFocused,
        autosaveDebounceMs,
    );

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

            {publication && (
                <VimTextArea
                    key={`${publication.pathStem}:${version}`}
                    value={value}
                    onChange={onChange}
                    focused={bibEditorFocused}
                    onFocusedChange={onBibEditorFocusedChange}
                />
            )}
        </div>
    );
}

export default DetailView;
