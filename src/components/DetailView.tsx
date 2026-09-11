import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { MARKDOWN_PREVIEW_EXTENSIONS } from './markdownPreview';
import { parseInlineMarkup } from './inlineMarkup.tsx';
import { type Publication, type PublicationId } from '../app/LibraryModel';
import { type PublicationUpserted } from '../app/libraryUpdates';
import { logger } from '../app/logger';
import { Action, useActionHandler } from '../app/actions';
import { useConfig } from '../app/config';
import { useTabActive } from './TabView';

// Hard-coded until `Config.opts` grows a wrapping field; this is the only call
// site to replace with `useConfig()`.
const LINE_WRAPPING = true;

interface SourceEntry {
    source: string;
    diskText: string | null;
    queue: Promise<void>;
}

// Keeps the store as source of truth for the active publication's metadata
// source and autosaves edits.
function usePublicationSource(
    publicationId: PublicationId | null,
    publication: Publication | null,
    bibEditorFocused: boolean,
    autosaveDebounceMs: number,
    libraryReloadCount: number,
) {
    const entriesRef = useRef(new Map<PublicationId, SourceEntry>());
    const [, setRenderVersion] = useState(0);
    const forceRender = useCallback(() => setRenderVersion(v => v + 1), []);

    const activeIdRef = useRef(publicationId);
    const prevIdRef = useRef<PublicationId | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    activeIdRef.current = publicationId;

    const publicationRef = useRef(publication);
    publicationRef.current = publication;

    const clearDebounceTimer = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const ensureSourceEntry = useCallback((id: PublicationId): SourceEntry => {
        let sourceEntry = entriesRef.current.get(id);
        if (!sourceEntry) {
            sourceEntry = { source: '', diskText: null, queue: Promise.resolve() };
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

    const adoptExternalSource = useCallback((id: PublicationId, metadataSource: string) => {
        const sourceEntry = entriesRef.current.get(id);
        if (!sourceEntry || sourceEntry.diskText === null) return;
        if (id === activeIdRef.current) clearDebounceTimer();
        sourceEntry.source = metadataSource;
        sourceEntry.diskText = metadataSource;
        forceRender();
    }, [clearDebounceTimer, forceRender]);

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

    // Fills a buffer the first time its publication is shown. `diskText` stays null until
    // then, which is what keeps `persist` from writing a buffer it never read.
    useEffect(() => {
        if (!publicationId || !publication) return;
        const sourceEntry = ensureSourceEntry(publicationId);
        if (sourceEntry.diskText !== null) return;
        sourceEntry.source = publication.metadataSource;
        sourceEntry.diskText = publication.metadataSource;
        forceRender();
    }, [publicationId, publication, ensureSourceEntry, forceRender]);

    useEffect(() => {
        const unlisten = listen<PublicationUpserted>('publication-upserted', event => {
            if (event.payload.origin !== 'disk') return;
            adoptExternalSource(
                event.payload.publicationId,
                event.payload.publication.metadataSource,
            );
        });

        return () => { unlisten.then(stop => stop()); };
    }, [adoptExternalSource]);

    useEffect(() => {
        const activeId = activeIdRef.current;
        for (const id of [...entriesRef.current.keys()]) {
            if (id !== activeId) entriesRef.current.delete(id);
        }

        const activePublication = publicationRef.current;
        if (activeId && activePublication) {
            adoptExternalSource(activeId, activePublication.metadataSource);
        }
    }, [libraryReloadCount]);

    // Flush immediately when the editor loses focus.
    useEffect(() => {
        if (bibEditorFocused) return;
        const id = activeIdRef.current;
        if (id) flush(id);
    }, [bibEditorFocused, flush]);

    const sourceEntry = publicationId ? entriesRef.current.get(publicationId) ?? null : null;

    return {
        value: sourceEntry ? sourceEntry.source : '',
        onChange: handleSourceChange,
    };
}

function useRequestReferencePreview(
    publicationId: PublicationId | null,
    libraryReloadCount: number,
) {
    // `libraryReloadCount` is a dependency because a config reload or a full
    // rescan rebuilds every publication, dropping the compiled preview with it.
    useEffect(() => {
        if (!publicationId) return;
        invoke('request_reference_preview', { publicationId })
            .catch(e => logger.error(String(e)));
    }, [publicationId, libraryReloadCount]);
}

interface ReferencePreviewProps {
    markup: string | null,
}

function ReferencePreview({ markup }: ReferencePreviewProps) {
    if (markup === null || markup.trim() === '') return null;

    return (
        <section className={styles.referencePreview}>
            <hr />
            <h2 className={styles.referencePreviewLabel}>Compiled Reference Preview</h2>
            <p className={styles.referencePreviewBody}>{parseInlineMarkup(markup)}</p>
        </section>
    );
}

interface NotesEditorProps {
    initialNotes: string,
}

function NotesEditor({ initialNotes }: NotesEditorProps) {
    const [notes, setNotes] = useState(initialNotes);
    const [focused, setFocused] = useState(false);

    return (
        <div className={styles.notesEditorSlot}>
            <VimTextArea
                value={notes}
                onChange={setNotes}
                focused={focused}
                onFocusedChange={setFocused}
                extraExtensions={MARKDOWN_PREVIEW_EXTENSIONS}
                lineWrapping={LINE_WRAPPING}
            />
        </div>
    );
}

interface MetadataSourceEditorProps {
    value: string,
    onChange: (value: string) => void,
    focused: boolean,
    onFocusedChange: (value: boolean) => void,
}

function MetadataSourceEditor(
    { value, onChange, focused, onFocusedChange }: MetadataSourceEditorProps
) {
    return (
        <div className={styles.bibEditorSlot}>
            <VimTextArea
                value={value}
                onChange={onChange}
                focused={focused}
                onFocusedChange={onFocusedChange}
                lineWrapping={LINE_WRAPPING}
            />
        </div>
    );
}

interface DetailViewProps {
    publicationId: PublicationId | null,
    publication: Publication | null,
    collectionName: string,
    libraryReloadCount: number,
}

function DetailView(
    { publicationId, publication, collectionName, libraryReloadCount }: DetailViewProps
) {
    const [bibEditorFocused, setBibEditorFocused] = useState(false);
    const { opts: { autosaveDebounceMs } } = useConfig();
    const tabActive = useTabActive();

    useRequestReferencePreview(publicationId, libraryReloadCount);

    useActionHandler(Action.FocusBibEditor, () => setBibEditorFocused(true), tabActive);

    const { value, onChange } = usePublicationSource(
        publicationId,
        publication,
        bibEditorFocused,
        autosaveDebounceMs,
        libraryReloadCount,
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
                <Fragment key={publicationId}>
                    <NotesEditor initialNotes={publication.notes ?? ''} />
                    <MetadataSourceEditor
                        value={value}
                        onChange={onChange}
                        focused={bibEditorFocused}
                        onFocusedChange={setBibEditorFocused}
                    />
                </Fragment>
            )}

            {publication && <ReferencePreview markup={publication.referencePreview} />}
        </div>
    );
}

export default DetailView;
