import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { type Publication, type PublicationId } from '../app/LibraryModel';
import { logger } from '../app/logger';

interface SourceEntry {
    source: string;
    diskText: string | null;
    version: number;
    queue: Promise<void>;
}

// Keeps the store as source of truth for the active publication's metadata
// source and autosaves edits.
function usePublicationSource(
    publicationId: PublicationId | null,
    publication: Publication | null,
    bibEditorFocused: boolean,
    autosaveDebounceMs: number,
) {
    const entriesRef = useRef(new Map<PublicationId, SourceEntry>());
    const [, setRenderVersion] = useState(0);
    const forceRender = useCallback(() => setRenderVersion(v => v + 1), []);

    const activeIdRef = useRef(publicationId);
    const prevIdRef = useRef<PublicationId | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    activeIdRef.current = publicationId;

    const clearDebounceTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const ensureSourceEntry = useCallback((id: PublicationId): SourceEntry => {
        let sourceEntry = entriesRef.current.get(id);
        if (!sourceEntry) {
            sourceEntry = { source: '', diskText: null, version: 0, queue: Promise.resolve() };
            entriesRef.current.set(id, sourceEntry);
        }
        return sourceEntry;
    }, []);

    // Serializes writes per buffer, so two autosaves of the same publication
    // never race each other.
    const enqueue = useCallback((sourceEntry: SourceEntry, op: () => Promise<void>) => {
        sourceEntry.queue = sourceEntry.queue
            .then(op)
            .catch(e => logger.error(String(e)));
    }, []);

    const persist = useCallback((id: PublicationId) => {
        const sourceEntry = entriesRef.current.get(id);
        if (!sourceEntry || sourceEntry.diskText === null) return;
        enqueue(sourceEntry, async () => {
            const current = entriesRef.current.get(id);
            if (!current) return;
            const content = current.source;
            if (content === current.diskText) return;
            await invoke('write_publication_source', { publicationId: id, content });
            current.diskText = content;
        });
    }, [enqueue]);

    // Adopts the store's metadata source whenever it differs from the last text
    // we confirmed, replacing the buffer over any unsaved typing.
    const adoptStoreSource = useCallback((id: PublicationId, metadataSource: string) => {
        const sourceEntry = ensureSourceEntry(id);
        if (metadataSource === sourceEntry.diskText) return;
        sourceEntry.diskText = metadataSource;
        if (metadataSource === sourceEntry.source) return;
        clearDebounceTimer();
        sourceEntry.source = metadataSource;
        sourceEntry.version += 1;
        forceRender();
    }, [clearDebounceTimer, ensureSourceEntry, forceRender]);

    const handleSourceChange = useCallback((value: string) => {
        const id = activeIdRef.current;
        if (!id) return;
        const sourceEntry = ensureSourceEntry(id);
        if (sourceEntry.source === value) return;
        sourceEntry.source = value;

        clearDebounceTimer();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            persist(id);
        }, autosaveDebounceMs);

        forceRender();
    }, [autosaveDebounceMs, clearDebounceTimer, ensureSourceEntry, forceRender, persist]);

    const flush = useCallback((id: PublicationId) => {
        if (!entriesRef.current.has(id)) return;
        clearDebounceTimer();
        persist(id);
    }, [clearDebounceTimer, persist]);

    // Flush the publication we are leaving. Only the active publication can be
    // dirty, so writes stay uncontended between publications.
    useEffect(() => {
        const prevId = prevIdRef.current;
        prevIdRef.current = publicationId;
        if (prevId !== null && prevId !== publicationId) {
            flush(prevId);
        }
    }, [publicationId, flush]);

    // A reload replaces the publication record with a fresh metadata source, so
    // both activation and external changes are handled here.
    useEffect(() => {
        if (!publicationId || !publication) return;
        adoptStoreSource(publicationId, publication.metadataSource);
    }, [publicationId, publication, adoptStoreSource]);

    // Flush immediately when the editor loses focus.
    useEffect(() => {
        if (bibEditorFocused) return;
        const id = activeIdRef.current;
        if (id) flush(id);
    }, [bibEditorFocused, flush]);

    const sourceEntry = publicationId ? entriesRef.current.get(publicationId) ?? null : null;

    return {
        value: sourceEntry ? sourceEntry.source : '',
        version: sourceEntry ? sourceEntry.version : 0,
        onChange: handleSourceChange,
    };
}

interface DetailViewProps {
    publicationId: PublicationId | null,
    publication: Publication | null,
    collectionName: string,
    bibEditorFocused: boolean,
    onBibEditorFocusedChange: (value: boolean) => void,
    autosaveDebounceMs: number,
}

function DetailView(
    { publicationId, publication, collectionName, bibEditorFocused, onBibEditorFocusedChange, autosaveDebounceMs }: DetailViewProps
) {
    const { value, version, onChange } = usePublicationSource(
        publicationId,
        publication,
        bibEditorFocused,
        autosaveDebounceMs,
    );

    const metadata = publication?.metadata ?? null;
    const publisher = metadata?.publisher ?? '';
    const title = metadata?.title ?? '';
    const author = metadata?.authors ?? '';
    const date = metadata?.year ? String(metadata.year) : '';
    const collection = collectionName;
    const filename = publication?.name ?? '';

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

            {publicationId && publication && (
                <VimTextArea
                    key={`${publicationId}:${version}`}
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
