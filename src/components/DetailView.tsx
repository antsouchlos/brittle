import { Fragment, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, ChevronUp, Eye, Pencil, X } from 'lucide-react';

import styles from './DetailView.module.css';
import TextEditor, { type EditorMode } from './TextEditor.tsx';
import { parseInlineMarkup } from './inlineMarkup.tsx';
import { useFocusTarget } from '../app/focus.tsx';
import { Action, findKeybindingForAction, useActionHandler } from '../app/actions.tsx';
import { useRestoredState } from '../app/uiState.tsx';

const METADATA_EDITOR_PINNED_KEY = 'detail.metadataEditor.pinned';

export interface DetailDocument {
    id: string;
    title: string | null;
    authors: string | null;
    notes: string;
    metadataSource: string;
    referencePreview: string | null;
}

export interface DetailViewProps {
    document: DetailDocument | null;
    onNotesChange: (text: string) => void;
    onMetadataSourceChange: (text: string) => void;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
}

function preventToggleFocus(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
}

function handleEditorKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();

    if (event.key === 'Tab') event.preventDefault();
}

// 
// Tracks whether an editor session is open independently of text area focus.
// Vim's command and search prompts take focus without ending that session.
// 
// TODO: Preserve and restore editor focus across tab switches; returning currently leaves the editor unfocused.
function useEditorSession() {
    const focusTarget = useFocusTarget();
    const [editing, setEditing] = useState(false);

    const openEditor = () => {
        setEditing(true);
        focusTarget.requestFocus();
    };
    const closeEditor = () => {
        setEditing(false);
        focusTarget.releaseFocus();
    };
    const handleEditorFocus = () => setEditing(true);
    const handleEditorBlur = (event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;

        setEditing(false);
    };

    return { focusTarget, editing, openEditor, closeEditor, handleEditorFocus, handleEditorBlur };
}

interface NotesSectionProps {
    notes: string;
    onChange: (text: string) => void;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
}

function NotesSection({ notes, onChange, editorMode, onEditorModeChange }: NotesSectionProps) {
    const editor = useEditorSession();
    const { editing } = editor;
    const editShortcut = editing ? 'Esc' : findKeybindingForAction(Action.FocusNotesEditor);

    useActionHandler(Action.FocusNotesEditor, editor.openEditor);

    const toggleEditing = () => {
        if (editing) editor.closeEditor();
        else editor.openEditor();
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
                    onClick={toggleEditing}
                    aria-label={editing ? 'Show rendered notes' : 'Edit notes source'}
                >
                    {editing
                        ? <Eye aria-hidden="true" />
                        : <Pencil aria-hidden="true" />}
                    {editShortcut && (
                        <span className={styles.sectionToggleShortcut}>{editShortcut}</span>
                    )}
                </button>
            </header>

            {editing ? (
                <div
                    className={styles.notesEditorSlot}
                    onFocus={editor.handleEditorFocus}
                    onBlur={editor.handleEditorBlur}
                    onKeyDown={handleEditorKeyDown}
                >
                    <TextEditor
                        value={notes}
                        onChange={onChange}
                        mode={editorMode}
                        onModeChange={onEditorModeChange}
                        editorElementRef={editor.focusTarget.ref}
                        onLeaveRequest={editor.focusTarget.releaseFocus}
                        lineWrapping={true}
                    />
                </div>
            ) : (
                <div className={styles.notesPreview}>
                    <Markdown>{notes}</Markdown>
                </div>
            )}
        </section>
    );
}

interface ReferencePreviewProps {
    markup: string | null;
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
    source: string;
    referencePreview: string | null;
    onChange: (text: string) => void;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

function MetadataSection({
    source,
    referencePreview,
    onChange,
    editorMode,
    onEditorModeChange,
    expanded,
    onExpandedChange,
}: MetadataSectionProps) {
    const editor = useEditorSession();
    const { editing } = editor;
    const visible = expanded || editing;
    const editShortcut = editing ? 'Esc' : findKeybindingForAction(Action.FocusMetadataEditor);
    const toggleShortcut = findKeybindingForAction(Action.ToggleMetadataEditor);

    const toggleEditing = () => {
        if (editing) editor.closeEditor();
        else editor.openEditor();
    };
    const toggleExpanded = () => {
        onExpandedChange(!visible);
        editor.closeEditor();
    };

    useActionHandler(Action.FocusMetadataEditor, editor.openEditor);
    useActionHandler(Action.ToggleMetadataEditor, toggleExpanded);

    return (
        <section className={styles.metadataSection}>
            <header className={styles.sectionHeader}>
                <h2 className={editing ? styles.editingMarker : styles.sectionLabel}>
                    {editing ? '\u25cf Editing' : 'Metadata'}
                </h2>
                <button
                    type="button"
                    className={styles.sectionToggle}
                    data-active={editing}
                    onMouseDown={preventToggleFocus}
                    onClick={toggleEditing}
                    aria-label={editing ? 'Leave metadata editor' : 'Edit metadata source'}
                >
                    {editing
                        ? <X aria-hidden="true" />
                        : <Pencil aria-hidden="true" />}
                    {editShortcut && (
                        <span className={styles.sectionToggleShortcut}>{editShortcut}</span>
                    )}
                </button>
                <button
                    type="button"
                    className={styles.sectionToggle}
                    data-active={editing}
                    onMouseDown={preventToggleFocus}
                    onClick={toggleExpanded}
                    aria-label={visible ? 'Hide metadata editor' : 'Show metadata editor'}
                    aria-expanded={visible}
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
                    <div
                        className={styles.metadataEditorSlot}
                        onFocus={editor.handleEditorFocus}
                        onBlur={editor.handleEditorBlur}
                        onKeyDown={handleEditorKeyDown}
                    >
                        <TextEditor
                            value={source}
                            onChange={onChange}
                            mode={editorMode}
                            onModeChange={onEditorModeChange}
                            editorElementRef={editor.focusTarget.ref}
                            onLeaveRequest={editor.focusTarget.releaseFocus}
                            lineWrapping={true}
                        />
                    </div>

                    <ReferencePreview markup={referencePreview} />
                </Fragment>
            )}
        </section>
    );
}

function DetailView({
    document,
    onNotesChange,
    onMetadataSourceChange,
    editorMode,
    onEditorModeChange,
}: DetailViewProps) {
    const [metadataExpanded, setMetadataExpanded] = useRestoredState<boolean>(
        METADATA_EDITOR_PINNED_KEY,
        false,
    );

    return (
        <div className={styles.detailPane}>
            {document && (
                <Fragment key={document.id}>
                    <NotesSection
                        notes={document.notes}
                        onChange={onNotesChange}
                        editorMode={editorMode}
                        onEditorModeChange={onEditorModeChange}
                    />
                    <MetadataSection
                        source={document.metadataSource}
                        referencePreview={document.referencePreview}
                        onChange={onMetadataSourceChange}
                        editorMode={editorMode}
                        onEditorModeChange={onEditorModeChange}
                        expanded={metadataExpanded}
                        onExpandedChange={setMetadataExpanded}
                    />
                </Fragment>
            )}
        </div>
    );
}

export default DetailView;
