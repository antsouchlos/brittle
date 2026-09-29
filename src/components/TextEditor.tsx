import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import CodeMirror from '@uiw/react-codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, type KeyBinding } from '@codemirror/view';
import {
    cursorCharLeft,
    cursorCharRight,
    cursorGroupLeft,
    cursorGroupRight,
    cursorLineBoundaryBackward,
    cursorLineBoundaryForward,
    cursorLineBoundaryLeft,
    cursorLineBoundaryRight,
    cursorLineDown,
    cursorLineUp,
    cursorPageDown,
    cursorPageUp,
    deleteCharBackward,
    deleteCharForward,
    emacsStyleKeymap,
    history,
    historyKeymap,
    insertNewlineAndIndent,
    selectCharLeft,
    selectCharRight,
    selectGroupLeft,
    selectGroupRight,
    selectLineBoundaryBackward,
    selectLineBoundaryForward,
    selectLineBoundaryLeft,
    selectLineBoundaryRight,
    selectLineDown,
    selectLineUp,
    selectPageDown,
    selectPageUp,
    standardKeymap,
} from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { getCM, Vim, vim, type CodeMirrorV } from '@replit/codemirror-vim';

import { WRAP_MARKERS } from './wrapMarkers.ts';

import styles from './TextEditor.module.css';

export type EditorMode = 'vim' | 'standard';

export interface TextEditorProps {
    value: string;
    onChange: (value: string) => void;
    mode: EditorMode;
    onModeChange: (mode: EditorMode) => void;
    onLeaveRequest?: () => void;
    editorElementRef?: (element: HTMLElement | null) => void;
    lineWrapping?: boolean;
}

const WRAPPED_VISUAL_EXTENSIONS: Extension[] = [EditorView.lineWrapping, WRAP_MARKERS];
const UNWRAPPED_VISUAL_EXTENSIONS: Extension[] = [];
const SHARED_EDITOR_EXTENSIONS: Extension[] = [
    history(),
    drawSelection({ cursorBlinkRate: 0 }),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
];
const MINIMUM_VIM_KEYMAP: readonly KeyBinding[] = [
    { key: 'ArrowLeft', run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
    { key: 'Mod-ArrowLeft', mac: 'Alt-ArrowLeft', run: cursorGroupLeft, shift: selectGroupLeft, preventDefault: true },
    { mac: 'Cmd-ArrowLeft', run: cursorLineBoundaryLeft, shift: selectLineBoundaryLeft, preventDefault: true },
    { key: 'ArrowRight', run: cursorCharRight, shift: selectCharRight, preventDefault: true },
    { key: 'Mod-ArrowRight', mac: 'Alt-ArrowRight', run: cursorGroupRight, shift: selectGroupRight, preventDefault: true },
    { mac: 'Cmd-ArrowRight', run: cursorLineBoundaryRight, shift: selectLineBoundaryRight, preventDefault: true },
    { key: 'ArrowUp', run: cursorLineUp, shift: selectLineUp, preventDefault: true },
    { key: 'ArrowDown', run: cursorLineDown, shift: selectLineDown, preventDefault: true },
    { key: 'PageUp', run: cursorPageUp, shift: selectPageUp },
    { key: 'PageDown', run: cursorPageDown, shift: selectPageDown },
    { key: 'Home', run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward, preventDefault: true },
    { key: 'End', run: cursorLineBoundaryForward, shift: selectLineBoundaryForward, preventDefault: true },
    { key: 'Enter', run: insertNewlineAndIndent, shift: insertNewlineAndIndent },
    { key: 'Backspace', run: deleteCharBackward, shift: deleteCharBackward, preventDefault: true },
    { key: 'Delete', run: deleteCharForward, preventDefault: true },
    ...emacsStyleKeymap.map(binding => ({ mac: binding.key, run: binding.run, shift: binding.shift })),
];
const VIM_EDITOR_EXTENSIONS: Extension[] = [keymap.of(MINIMUM_VIM_KEYMAP), vim()];
const STANDARD_EDITOR_EXTENSIONS: Extension[] = [keymap.of([...standardKeymap, ...historyKeymap])];

export default function TextEditor({
    value,
    onChange,
    mode,
    onModeChange,
    onLeaveRequest,
    editorElementRef,
    lineWrapping = true,
}: TextEditorProps) {
    const [view, setView] = useState<EditorView | null>(null);
    const leaveRequestRef = useRef(onLeaveRequest);
    leaveRequestRef.current = onLeaveRequest;

    useLayoutEffect(() => {
        if (!view || !editorElementRef) return;
        editorElementRef(view.contentDOM);

        return () => editorElementRef(null);
    }, [view, editorElementRef]);

    const extensions = useMemo(() => [
        ...SHARED_EDITOR_EXTENSIONS,
        ...(lineWrapping ? WRAPPED_VISUAL_EXTENSIONS : UNWRAPPED_VISUAL_EXTENSIONS),
        ...(mode === 'vim' ? VIM_EDITOR_EXTENSIONS : STANDARD_EDITOR_EXTENSIONS),
        EditorView.domEventHandlers({
            keydown(event, editorView) {
                if (mode === 'vim' && event.ctrlKey && !event.altKey && !event.metaKey
                    && !event.shiftKey && event.key.toLowerCase() === 'l') {
                    const cm = getCM(editorView);
                    const vimState = cm?.state.vim;

                    if (cm && vimState && !vimState.insertMode && !vimState.visualMode) {
                        event.preventDefault();
                        event.stopPropagation();
                        Vim.handleEx(cm as CodeMirrorV, 'nohlsearch');

                        return true;
                    }
                }

                if (mode === 'vim' && event.altKey
                    && event.key !== 'Alt' && event.key !== 'Control' && event.key !== 'Shift') {
                    const cm = getCM(editorView);

                    if (cm?.state.vim?.insertMode) {
                        event.preventDefault();
                        Vim.handleKey(cm, '<Esc>', 'input');
                        Vim.handleKey(cm, event.key, 'input');

                        return true;
                    }
                }

                if (event.key !== 'Escape' || !leaveRequestRef.current) return false;

                if (mode === 'vim') {
                    const vimState = getCM(editorView)?.state.vim;
                    if (!vimState || vimState.insertMode || vimState.visualMode) return false;
                }

                event.preventDefault();
                event.stopPropagation();
                leaveRequestRef.current();

                return true;
            },
        }),
    ], [mode, lineWrapping]);

    return (
        <div className={styles.editorHost}>
            <CodeMirror
                onCreateEditor={setView}
                value={value}
                onChange={onChange}
                basicSetup={false}
                extensions={extensions}
                className={styles.editor}
            />
            <button
                type="button"
                className={styles.modeToggle}
                tabIndex={-1}
                role="switch"
                aria-checked={mode === 'vim'}
                aria-label="Vim mode"
                onMouseDown={event => event.preventDefault()}
                onClick={() => onModeChange(mode === 'vim' ? 'standard' : 'vim')}
            >
                <span>Vim</span>
                <span className={styles.modeToggleTrack} aria-hidden="true">
                    <span className={styles.modeToggleThumb} />
                </span>
            </button>
        </div>
    );
}
