import { useEffect, useRef } from 'react';

import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { drawSelection, keymap } from '@codemirror/view';
import { history, historyKeymap } from '@codemirror/commands';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import {
    deleteCharBackward,
    deleteCharForward,
    cursorCharLeft,
    cursorCharRight,
    selectCharLeft,
    selectCharRight
} from "@codemirror/commands"

import styles from './VimTextArea.module.css';

interface VimTextAreaProps {
    value: string;
    onChange: (value: string) => void;
    isFocused: boolean;
    setFocused: (value: boolean) => void;

}

// This component is based on a CodeMirror, which manages its own focus state
// internally. To allow use of this component as though the focus state is
// managed by the caller, the setFocused() function is called every time the
// CodeMirror looses or gains focus. This way, the external focus state is
// configured to mirror the interal one.
//
// TODO: Only focus textarea if the actual textarea is clicked, not the area
// below it
// TODO: Make vim mode configurable
// TODO: For some reason, typing "}," followed immediately by an enter key
// doesn't register the enter key
export default function VimTextArea({ value, onChange, isFocused, setFocused }: VimTextAreaProps) {
    const editorRef = useRef<ReactCodeMirrorRef>(null);

    useEffect(() => {
        if (isFocused !== undefined && editorRef.current) {
            if (isFocused) {
                editorRef.current.view?.contentDOM.focus();
            } else {
                editorRef.current.view?.contentDOM.blur();
            }
        }
    }, [isFocused]);

    const extensions = [
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        bracketMatching(),
        keymap.of([
            ...historyKeymap,
            // Fix char deletion on multiple lines when in visual block mode
            { key: "Backspace", run: deleteCharBackward },
            { key: "Delete", run: deleteCharForward },
            { key: "ArrowLeft", run: cursorCharLeft, shift: selectCharLeft },
            { key: "ArrowRight", run: cursorCharRight, shift: selectCharRight },
        ]),
        vim(),
        EditorView.domEventHandlers({
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
        // Mirror the internal focus state in the external focus state
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
        })
    ];


    return (
        <CodeMirror
            ref={editorRef}
            value={value}
            onChange={onChange}
            basicSetup={false}
            className={styles.editor}
            extensions={extensions}
        />
    );
}
