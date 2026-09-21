import { Fragment, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, ChevronUp, Eye, LogOut, Pencil } from 'lucide-react';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea';
import { parseInlineMarkup } from './inlineMarkup.tsx';
import { type Publication, type PublicationId } from '../app/LibraryModel';
import { type PublicationChangeOrigin, type PublicationUpserted } from '../app/libraryUpdates';
import { logger } from '../app/logger';
import { Action, findKeybindingForAction, useActionHandler } from '../app/actions';
import { useConfig } from '../app/config';
import { useRestoredState } from '../app/uiState';
import { useTabActive } from './TabView';
import { useFocusTarget, type FocusTarget } from '../app/focus.tsx';

const LINE_WRAPPING = true;

const METADATA_EDITOR_PINNED_KEY = 'detail.metadataEditor.pinned';

interface PublicationTextFile {
    writeCommand: string;
    originsThatRereadFile: PublicationChangeOrigin[];
    readText: (publication: Publication) => string;
}

const NOTES_FILE: PublicationTextFile = {
    writeCommand: 'write_publication_notes',
    originsThatRereadFile: ['disk', 'notes'],
    readText: publication => publication.notes ?? '',
};

const METADATA_SOURCE_FILE: PublicationTextFile = {
    writeCommand: 'write_publication_source',
    originsThatRereadFile: ['disk'],
    readText: publication => publication.metadataSource,
};

// Disk wins outright: an external change replaces the buffer, unwritten
// keystrokes included.
function useAutosavedPublicationText(
    publicationId: PublicationId,
    text: string,
    file: PublicationTextFile,
) {
    const [value, setValue] = useState(text);
    const { opts: { autosaveDebounceMs } } = useConfig();

    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const unwrittenRef = useRef<string | null>(null);
    const queueRef = useRef<Promise<void>>(Promise.resolve());

    const cancelPendingWrite = useCallback(() => {
        if (timerRef.current === null) return;

        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    // Chained, so two autosaves never race over the same file.
    const writeText = useCallback(() => {
        const content = unwrittenRef.current;
        if (content === null) return;
        unwrittenRef.current = null;

        queueRef.current = queueRef.current
            .then(() => invoke(file.writeCommand, { publicationId, content }))
            .then(() => undefined)
            .catch(e => logger.error(String(e)));
    }, [publicationId, file]);

    const handleChange = useCallback((next: string) => {
        setValue(next);
        unwrittenRef.current = next;

        cancelPendingWrite();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            writeText();
        }, autosaveDebounceMs);
    }, [autosaveDebounceMs, cancelPendingWrite, writeText]);

    useEffect(() => {
        const unlisten = listen<PublicationUpserted>('publication-upserted', event => {
            if (event.payload.publicationId !== publicationId) return;
            if (!file.originsThatRereadFile.includes(event.payload.origin)) return;

            cancelPendingWrite();
            unwrittenRef.current = null;
            setValue(file.readText(event.payload.publication));
        });

        return () => { unlisten.then(stop => stop()); };
    }, [publicationId, file, cancelPendingWrite]);

    // Selecting another publication unmounts this subtree mid-debounce.
    useEffect(() => () => {
        cancelPendingWrite();
        writeText();
    }, [cancelPendingWrite, writeText]);

    return { value, onChange: handleChange };
}

// `libraryReloadCount` is a dependency because a config reload or a full
// rescan rebuilds every publication, dropping the compiled preview with it.
function useRequestReferencePreview(
    publicationId: PublicationId | null,
    libraryReloadCount: number,
) {
    useEffect(() => {
        if (!publicationId) return;

        invoke('request_reference_preview', { publicationId })
            .catch(e => logger.error(String(e)));
    }, [publicationId, libraryReloadCount]);
}

// Letting a toggle button take focus blurs CodeMirror, which releases the
// editor before the click handler runs.
function preventToggleFocus(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
}

interface NotesSectionProps {
    publicationId: PublicationId,
    notes: string,
}

function NotesSection({ publicationId, notes }: NotesSectionProps) {
    const { value: notesSource, onChange: handleNotesChange } = useAutosavedPublicationText(
        publicationId,
        notes,
        NOTES_FILE,
    );

    const tabActive = useTabActive();
    const focusTarget = useFocusTarget({ available: tabActive });
    const editing = focusTarget.focused;

    useActionHandler(Action.FocusNotesEditor, focusTarget.requestFocus, tabActive);

    const toggleShortcut = editing ? 'Esc' : findKeybindingForAction(Action.FocusNotesEditor);

    const handleToggleClick = () => {
        if (editing) focusTarget.releaseFocus();
        else focusTarget.requestFocus();
    };

    return (
        <section className={styles.notesSection}>
            <header className={styles.sectionHeader}>
                <h2 className={editing ? styles.editingMarker : styles.sectionLabel}>
                    {editing ? '\u25cf Editing' : 'Notes'}
                </h2>

                <button
                    type="button"
                    className={styles.sectionToggle}
                    data-active={editing}
                    onMouseDown={preventToggleFocus}
                    onClick={handleToggleClick}
                    aria-label={editing ? 'Show rendered notes' : 'Edit notes source'}
                >
                    {editing
                        ? <Eye aria-hidden="true" />
                        : <Pencil aria-hidden="true" />}
                    {toggleShortcut && (
                        <span className={styles.sectionToggleShortcut}>{toggleShortcut}</span>
                    )}
                </button>
            </header>

            {editing ? (
                <div className={styles.notesEditorSlot}>
                    <VimTextArea
                        value={notesSource}
                        onChange={handleNotesChange}
                        focusTarget={focusTarget}
                        lineWrapping={LINE_WRAPPING}
                    />
                </div>
            ) : (
                <div className={styles.notesPreview}>
                    <Markdown>{notesSource}</Markdown>
                </div>
            )}
        </section>
    );
}

interface ReferencePreviewProps {
    markup: string | null,
}

function ReferencePreview({ markup }: ReferencePreviewProps) {
    if (markup === null || markup.trim() === '') return null;

    return (
        <div className={styles.referencePreview}>
            <hr />
            <p className={styles.referencePreviewBody}>{parseInlineMarkup(markup)}</p>
        </div>
    );
}

interface MetadataSectionProps {
    publicationId: PublicationId,
    metadataSource: string,
    referencePreview: string | null,
    visible: boolean,
    onToggle: () => void,
    focusTarget: FocusTarget,
}

function MetadataSection({
    publicationId,
    metadataSource,
    referencePreview,
    visible,
    onToggle,
    focusTarget,
}: MetadataSectionProps) {
    const { value, onChange } = useAutosavedPublicationText(
        publicationId,
        metadataSource,
        METADATA_SOURCE_FILE,
    );

    const focused = focusTarget.focused;
    const toggleShortcut = findKeybindingForAction(Action.ToggleMetadataEditor);
    const focusShortcut = focused ? 'Esc' : findKeybindingForAction(Action.FocusMetadataEditor);

    const handleFocusClick = () => {
        if (focused) focusTarget.releaseFocus();
        else focusTarget.requestFocus();
    };

    return (
        <section className={styles.metadataSection}>
            <header className={styles.sectionHeader}>
                <h2 className={focused ? styles.editingMarker : styles.sectionLabel}>
                    {focused ? '\u25cf Editing' : 'Metadata'}
                </h2>

                <button
                    type="button"
                    className={styles.sectionToggle}
                    data-active={focused}
                    onMouseDown={preventToggleFocus}
                    onClick={handleFocusClick}
                    aria-label={focused ? 'Leave metadata editor' : 'Edit metadata source'}
                >
                    {focused
                        ? <LogOut aria-hidden="true" />
                        : <Pencil aria-hidden="true" />}
                    {focusShortcut && (
                        <span className={styles.sectionToggleShortcut}>{focusShortcut}</span>
                    )}
                </button>

                <button
                    type="button"
                    className={styles.sectionToggle}
                    data-active={focused}
                    onMouseDown={preventToggleFocus}
                    onClick={onToggle}
                    aria-label={visible ? 'Hide metadata editor' : 'Show metadata editor'}
                >
                    {visible
                        ? <ChevronDown aria-hidden="true" />
                        : <ChevronUp aria-hidden="true" />}
                    {toggleShortcut && (
                        <span className={styles.sectionToggleShortcut}>{toggleShortcut}</span>
                    )}
                </button>
            </header>

            {visible && (
                <Fragment>
                    <div className={styles.metadataEditorSlot}>
                        <VimTextArea
                            value={value}
                            onChange={onChange}
                            focusTarget={focusTarget}
                            lineWrapping={LINE_WRAPPING}
                        />
                    </div>

                    <ReferencePreview markup={referencePreview} />
                </Fragment>
            )}
        </section>
    );
}

interface DetailViewProps {
    publicationId: PublicationId | null,
    publication: Publication | null,
    collectionName: string,
    libraryReloadCount: number,
}

function DetailView(
    // { publicationId, publication, collectionName, libraryReloadCount }: DetailViewProps
    { publicationId, publication, libraryReloadCount }: DetailViewProps
) {
    const [metadataEditorPinned, setMetadataEditorPinned] =
        useRestoredState<boolean>(METADATA_EDITOR_PINNED_KEY, false);
    const tabActive = useTabActive();
    const metadataFocusTarget = useFocusTarget({
        available: tabActive && publicationId !== null && publication !== null,
        identity: publicationId,
    });
    const metadataEditorFocused = metadataFocusTarget.focused;
    const { releaseFocus: releaseMetadataFocus } = metadataFocusTarget;

    useRequestReferencePreview(publicationId, libraryReloadCount);

    // Focus is a reveal of its own, so a section that was not pinned open
    // collapses again the moment the editor releases the keyboard.
    const metadataEditorVisible = metadataEditorPinned || metadataEditorFocused;

    const toggleMetadataEditor = useCallback(() => {
        setMetadataEditorPinned(!metadataEditorVisible);
        releaseMetadataFocus();
    }, [metadataEditorVisible, setMetadataEditorPinned, releaseMetadataFocus]);

    useActionHandler(
        Action.FocusMetadataEditor,
        metadataFocusTarget.requestFocus,
        tabActive,
    );

    useActionHandler(Action.ToggleMetadataEditor, toggleMetadataEditor, tabActive);

    return (
        <div className={styles.detailPane}>

            {publicationId && publication && (
                <Fragment key={publicationId}>
                    <NotesSection publicationId={publicationId} notes={publication.notes ?? ''} />

                    <MetadataSection
                        publicationId={publicationId}
                        metadataSource={publication.metadataSource}
                        referencePreview={publication.referencePreview}
                        visible={metadataEditorVisible}
                        onToggle={toggleMetadataEditor}
                        focusTarget={metadataFocusTarget}
                    />
                </Fragment>
            )}
        </div>
    );
}

export default DetailView;
