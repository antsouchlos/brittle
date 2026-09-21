import { Fragment, type MouseEvent } from 'react';
import Markdown from 'markdown-to-jsx';
import { ChevronDown, ChevronUp, Eye, LogOut, Pencil } from 'lucide-react';

import styles from './DetailView.module.css';
import VimTextArea from './VimTextArea.tsx';
import { parseInlineMarkup } from './inlineMarkup.tsx';
import { useFocusTarget } from '../app/focus.tsx';
import { Action, findKeybindingForAction, useActionHandler } from '../app/actions.tsx';
import { useTabActive } from './TabView.tsx';
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
}

function preventToggleFocus(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
}

interface NotesSectionProps {
    notes: string;
    onChange: (text: string) => void;
    tabActive: boolean;
}

function NotesSection({ notes, onChange, tabActive }: NotesSectionProps) {
    const focusTarget = useFocusTarget({ available: tabActive });
    const editing = focusTarget.focused;
    const editShortcut = editing ? 'Esc' : findKeybindingForAction(Action.FocusNotesEditor);

    useActionHandler(Action.FocusNotesEditor, focusTarget.requestFocus, tabActive);

    const toggleEditing = () => {
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
                <div className={styles.notesEditorSlot}>
                    <VimTextArea
                        value={notes}
                        onChange={onChange}
                        focusTarget={focusTarget}
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
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    tabActive: boolean;
}

function MetadataSection({
    source,
    referencePreview,
    onChange,
    expanded,
    onExpandedChange,
    tabActive,
}: MetadataSectionProps) {
    const focusTarget = useFocusTarget({ available: tabActive });
    const editing = focusTarget.focused;
    const visible = expanded || editing;
    const editShortcut = editing ? 'Esc' : findKeybindingForAction(Action.FocusMetadataEditor);
    const toggleShortcut = findKeybindingForAction(Action.ToggleMetadataEditor);

    const toggleEditing = () => {
        if (editing) focusTarget.releaseFocus();
        else focusTarget.requestFocus();
    };
    const toggleExpanded = () => {
        onExpandedChange(!visible);
        focusTarget.releaseFocus();
    };

    useActionHandler(Action.FocusMetadataEditor, focusTarget.requestFocus, tabActive);
    useActionHandler(Action.ToggleMetadataEditor, toggleExpanded, tabActive);

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
                        ? <LogOut aria-hidden="true" />
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
                    <div className={styles.metadataEditorSlot}>
                        <VimTextArea
                            value={source}
                            onChange={onChange}
                            focusTarget={focusTarget}
                            lineWrapping={true}
                        />
                    </div>

                    <ReferencePreview markup={referencePreview} />
                </Fragment>
            )}
        </section>
    );
}

function DetailView({ document, onNotesChange, onMetadataSourceChange }: DetailViewProps) {
    // TODO: Reexamine how to move active-tab management out of DetailView.

    const tabActive = useTabActive();
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
                        tabActive={tabActive}
                    />
                    <MetadataSection
                        source={document.metadataSource}
                        referencePreview={document.referencePreview}
                        onChange={onMetadataSourceChange}
                        expanded={metadataExpanded}
                        onExpandedChange={setMetadataExpanded}
                        tabActive={tabActive}
                    />
                </Fragment>
            )}
        </div>
    );
}

export default DetailView;
