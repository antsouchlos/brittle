import { useEffect, useRef } from 'react';

import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { drawSelection, KeyBinding, keymap } from '@codemirror/view';
// import { cursorDocEnd, cursorDocStart, cursorGroupLeft, cursorGroupRight, cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorLineBoundaryLeft, cursorLineBoundaryRight, cursorLineDown, cursorLineUp, cursorPageDown, cursorPageUp, deleteGroupBackward, deleteGroupForward, deleteLineBoundaryBackward, deleteLineBoundaryForward, emacsStyleKeymap, history, historyKeymap, selectAll, selectDocEnd, selectDocStart, selectGroupLeft, selectGroupRight, selectLineBoundaryBackward, selectLineBoundaryForward, selectLineBoundaryLeft, selectLineBoundaryRight, selectLineDown, selectLineUp, selectPageDown, selectPageUp, standardKeymap } from '@codemirror/commands';
import { cursorGroupLeft, cursorGroupRight, cursorLineBoundaryBackward, cursorLineBoundaryForward, cursorLineBoundaryLeft, cursorLineBoundaryRight, cursorLineDown, cursorLineUp, cursorPageDown, cursorPageUp, emacsStyleKeymap, history, selectGroupLeft, selectGroupRight, selectLineBoundaryBackward, selectLineBoundaryForward, selectLineBoundaryLeft, selectLineBoundaryRight, selectLineDown, selectLineUp, selectPageDown, selectPageUp } from '@codemirror/commands';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { EditorState, Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import {
    deleteCharBackward,
    deleteCharForward,
    cursorCharLeft,
    cursorCharRight,
    selectCharLeft,
    selectCharRight,
    insertNewlineAndIndent,
} from "@codemirror/commands";

import styles from './VimTextArea.module.css';

// This hook is responsible for syncing the external focus state managed by
// the caller with the internal one managed by the `CodeMirror` component
function useCodeMirrorFocusSync(
    editorRef: React.RefObject<ReactCodeMirrorRef | null>,
    isFocused: boolean,
    setFocused: (value: boolean) => void
): Extension[] {
    // Sync external isFocused state to CodeMirror's internal focus state
    useEffect(() => {
        if (editorRef.current?.view) {
            if (isFocused) {
                editorRef.current.view?.contentDOM.focus();
            } else {
                editorRef.current.view?.contentDOM.blur();
            }
        }
    }, [isFocused, editorRef]);

    // Return extensions that sync internal focus state back to parent
    return [
        EditorView.domEventHandlers({
            focus(_event, _view) {
                setFocused(true);
            },
            blur(_event, view) {
                // Use requestAnimationFrame to avoid race conditions
                requestAnimationFrame(() => {
                    // Check if focus moved outside the editor
                    if (!view.contentDOM.contains(document.activeElement)) {
                        setFocused(false);
                    }
                });
            },
        }),
    ];
}

// Selection of key bindings required for the proper function of the text area.
// This is a subset of the `standardKeymap` defined by the code mirror library.
const minimumFunctionalKeymap: readonly KeyBinding[] = ([
    { key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft, preventDefault: true },
    { key: "Mod-ArrowLeft", mac: "Alt-ArrowLeft", run: cursorGroupLeft, shift: selectGroupLeft, preventDefault: true },
    { mac: "Cmd-ArrowLeft", run: cursorLineBoundaryLeft, shift: selectLineBoundaryLeft, preventDefault: true },

    { key: "ArrowRight", run: cursorCharRight, shift: selectCharRight, preventDefault: true },
    { key: "Mod-ArrowRight", mac: "Alt-ArrowRight", run: cursorGroupRight, shift: selectGroupRight, preventDefault: true },
    { mac: "Cmd-ArrowRight", run: cursorLineBoundaryRight, shift: selectLineBoundaryRight, preventDefault: true },

    { key: "ArrowUp", run: cursorLineUp, shift: selectLineUp, preventDefault: true },
    { key: "ArrowDown", run: cursorLineDown, shift: selectLineDown, preventDefault: true },

    { key: "PageUp", run: cursorPageUp, shift: selectPageUp },
    { key: "PageDown", run: cursorPageDown, shift: selectPageDown },

    { key: "Home", run: cursorLineBoundaryBackward, shift: selectLineBoundaryBackward, preventDefault: true },
    { key: "End", run: cursorLineBoundaryForward, shift: selectLineBoundaryForward, preventDefault: true },

    { key: "Enter", run: insertNewlineAndIndent, shift: insertNewlineAndIndent },
    { key: "Backspace", run: deleteCharBackward, shift: deleteCharBackward, preventDefault: true },
    { key: "Delete", run: deleteCharForward, preventDefault: true },
] as KeyBinding[]).concat(emacsStyleKeymap.map(b => ({ mac: b.key, run: b.run, shift: b.shift })));

// // Selection of auxiliary key bindings, not absolutely required for proper
// // operation but usually existing in text editors by convention.
// // This is a subset of the `standardKeymap` defined by the code mirror library.
// // TODO: Use this when not in vim mode
// const auxKeymap: readonly KeyBinding[] = ([
//     { mac: "Cmd-ArrowUp", run: cursorDocStart, shift: selectDocStart },
//     { mac: "Ctrl-ArrowUp", run: cursorPageUp, shift: selectPageUp },
//     { mac: "Cmd-ArrowDown", run: cursorDocEnd, shift: selectDocEnd },
//     { mac: "Ctrl-ArrowDown", run: cursorPageDown, shift: selectPageDown },
//
//     { key: "Mod-Home", run: cursorDocStart, shift: selectDocStart },
//     { key: "Mod-End", run: cursorDocEnd, shift: selectDocEnd },
//
//     { key: "Mod-a", run: selectAll },
//
//     { key: "Mod-Backspace", mac: "Alt-Backspace", run: deleteGroupBackward, preventDefault: true },
//     { key: "Mod-Delete", mac: "Alt-Delete", run: deleteGroupForward, preventDefault: true },
//     { mac: "Mod-Backspace", run: deleteLineBoundaryBackward, preventDefault: true },
//     { mac: "Mod-Delete", run: deleteLineBoundaryForward, preventDefault: true }
// ] as KeyBinding[]).concat(emacsStyleKeymap.map(b => ({ mac: b.key, run: b.run, shift: b.shift })));


interface VimTextAreaProps {
    value: string;
    onChange: (value: string) => void;
    isFocused: boolean;
    setFocused: (value: boolean) => void;

}

// This component is based on a CodeMirror, which manages its own focus state
// internally. To allow use of this component as though the focus state is
// managed by the caller, the external focus state is set up to mirror the 
// internal one.
//
// TODO: Only focus textarea if the actual textarea is clicked, not the area
// below it
// TODO: Make vim mode configurable
// TODO: Make history work as expected
export default function VimTextArea({ value, onChange, isFocused, setFocused }: VimTextAreaProps) {
    const editorRef = useRef<ReactCodeMirrorRef>(null);
    const focusSyncExtensions = useCodeMirrorFocusSync(editorRef, isFocused, setFocused);

    const extensions = [
        history(),
        drawSelection({ cursorBlinkRate: 0 }),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        ...focusSyncExtensions,
        keymap.of([
            // ...historyKeymap,  // TODO: Use this when not in vim mode
            ...minimumFunctionalKeymap,
        ]),
        vim(),
        EditorView.domEventHandlers({
            // TODO: Only use in vim mode
            keydown(event, view) {
                // Fix alt key bindings for vim mode
                if (event.altKey && event.key !== 'Alt' && event.key !== 'Control' && event.key !== 'Shift') {
                    const cm = getCM(view);

                    if (cm && (cm as any).state?.vim?.insertMode) {
                        event.preventDefault();
                        event.stopPropagation();

                        Vim.handleKey(cm as any, '<Esc>', 'input');
                        Vim.handleKey(cm as any, event.key, 'input');

                        return true;
                    }
                }

                // Unfocus when 'Escape' is pressed in normal mode
                if (event.key === 'Escape') {
                    const cm = getCM(view);
                    if (cm) {
                        const vimState = (cm as any).state?.vim;
                        // Check if in normal mode (not insert mode AND not visual mode)
                        if (vimState && !vimState.insertMode && !vimState.visualMode) {
                            setFocused(false);
                            return true;
                        }
                    }
                }

                return false;
            }
        }),
    ];


    return (
        <CodeMirror
            ref={editorRef}
            value={value}
            onChange={onChange}
            basicSetup={false}
            className={styles.editor}
            extensions={extensions}
            data-focused={isFocused ? 'true' : 'false'}
        />
    );
}
