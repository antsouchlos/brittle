import CodeMirror from '@uiw/react-codemirror';
import { drawSelection, dropCursor, rectangularSelection, crosshairCursor, keymap, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { vim, getCM, Vim } from '@replit/codemirror-vim';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { closeBrackets, autocompletion } from '@codemirror/autocomplete';
import {
    deleteCharBackward,
    deleteCharForward,
    cursorCharLeft,
    cursorCharRight,
    selectCharLeft,
    selectCharRight
} from "@codemirror/commands"

import styles from './VimTextArea.module.css';

interface MinimalWrapperEditorProps {
    value: string;
    onChange: (value: string) => void;
}

// TODO: Make vim mode configurable
export default function MinimalWrapperEditor({ value, onChange }: MinimalWrapperEditorProps) {
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
                            view.contentDOM.blur();
                            return true;
                        }
                    }
                }

                return false;
            }
        })
    ];

    return (
        <CodeMirror
            value={value}
            onChange={onChange}
            basicSetup={false}
            className={styles.editor}
            extensions={extensions}
        />
    );
}
