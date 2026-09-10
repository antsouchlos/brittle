import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './CmdLine.module.css';
import { logger } from '../app/logger';
import { Action, isTextProducingKey, useActionHandler } from '../app/actions';
import { useConfigChanged } from '../app/config';

function useCmdHistory(commandHistory: string[], buffer: string) {
    const [historyPosition, setHistoryPosition] = useState(-1);
    const savedBufferRef = useRef('');

    const historyNavigate = useCallback((direction: -1 | 1): string | null => {
        if (commandHistory.length === 0) return null;

        if (direction === -1) {
            if (historyPosition === -1) {
                savedBufferRef.current = buffer;
                setHistoryPosition(commandHistory.length - 1);
                return commandHistory[commandHistory.length - 1];
            }
            if (historyPosition > 0) {
                setHistoryPosition(historyPosition - 1);
                return commandHistory[historyPosition - 1];
            }
            return null;
        }

        if (historyPosition === -1) return null;

        if (historyPosition < commandHistory.length - 1) {
            setHistoryPosition(historyPosition + 1);
            return commandHistory[historyPosition + 1];
        }

        setHistoryPosition(-1);
        return savedBufferRef.current;
    }, [commandHistory, historyPosition, buffer]);

    const resetHistoryPosition = useCallback(() => {
        setHistoryPosition(-1);
        savedBufferRef.current = '';
    }, []);

    return { historyNavigate, resetHistoryPosition };
}

function useCmdSuggestions(suggestions: string[], buffer: string) {
    const [prefix, setPrefix] = useState('');
    const [showAllSuggestions, setShowAllSuggestions] = useState(false);
    const [highlightedIndex, setHighlightedIndex] = useState(-1);

    const filteredSuggestions = useMemo(() => {
        if (prefix.length === 0) return suggestions;
        return suggestions.filter(s => s.startsWith(prefix));
    }, [suggestions, prefix]);

    const showDropdown = showAllSuggestions || buffer.length > 0 && filteredSuggestions.length > 0;

    const navigateSuggestion = useCallback((direction: 1 | -1): string | null => {
        const items = showAllSuggestions ? suggestions : filteredSuggestions;
        if (items.length === 0) return null;
        const next = ((highlightedIndex + direction) % items.length + items.length) % items.length;
        setHighlightedIndex(next);
        return items[next];
    }, [suggestions, filteredSuggestions, showAllSuggestions, highlightedIndex]);

    const resetDropdown = useCallback(() => {
        setShowAllSuggestions(false);
        setHighlightedIndex(-1);
    }, []);

    return {
        filteredSuggestions,
        showSuggestionDropdown: showDropdown,
        highlightedSuggestionIndex: highlightedIndex,
        setHighlightedSuggestionIndex: setHighlightedIndex,
        setSuggestionPrefix: setPrefix,
        setShowAllSuggestions,
        navigateSuggestion,
        resetSuggestionDropdown: resetDropdown,
    };
}

function useCmdFocus(onCancel: () => void) {
    const inputRef = useRef<HTMLInputElement>(null);

    const focusInput = useCallback(() => {
        requestAnimationFrame(() => inputRef.current?.focus());
    }, []);

    const handleBlur = useCallback(() => { onCancel(); }, [onCancel]);

    return { inputRef, focusInput, handleBlur };
}

// Loads the available commands and the persisted history, and writes the
// history back as it grows.
function useCommandData() {
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const historyLoadedRef = useRef(false);

    const loadCommandList = useCallback(() => {
        invoke<string[]>('list_commands')
            .then(setSuggestions)
            .catch(e => logger.error(`Failed to list commands: ${e}`));
    }, []);

    const loadCommandHistory = useCallback(() => {
        invoke<string[]>('load_command_history')
            .then(setCommandHistory)
            .catch(e => logger.error(`Failed to load command history: ${e}`))
            .finally(() => { historyLoadedRef.current = true; });
    }, []);

    useEffect(() => {
        loadCommandList();
        loadCommandHistory();
    }, [loadCommandList, loadCommandHistory]);

    // A config reload can add or remove Lua commands.
    useConfigChanged(() => {
        loadCommandList();
        loadCommandHistory();
    });

    useEffect(() => {
        if (!historyLoadedRef.current) return;
        invoke('save_command_history', { history: commandHistory })
            .catch(e => logger.error(`Failed to save command history: ${e}`));
    }, [commandHistory]);

    const rememberCommand = useCallback((cmdLine: string) => {
        setCommandHistory(prevHistory => {
            if (prevHistory.length > 0 && prevHistory[prevHistory.length - 1] === cmdLine) return prevHistory;
            return [...prevHistory, cmdLine];
        });
    }, []);

    return { suggestions, commandHistory, rememberCommand };
}

export default function CmdLine() {
    const [visible, setVisible] = useState(false);
    const [buffer, setBuffer] = useState('');
    const { suggestions, commandHistory, rememberCommand } = useCommandData();

    const close = useCallback(() => {
        setVisible(false);
        setBuffer('');
    }, []);

    const { historyNavigate, resetHistoryPosition } = useCmdHistory(commandHistory, buffer);
    const {
        filteredSuggestions,
        showSuggestionDropdown,
        highlightedSuggestionIndex,
        setHighlightedSuggestionIndex,
        setSuggestionPrefix,
        setShowAllSuggestions,
        navigateSuggestion,
        resetSuggestionDropdown,
    } = useCmdSuggestions(suggestions, buffer);

    const { inputRef, focusInput, handleBlur } = useCmdFocus(close);

    // Auto-focus the input whenever the cmdline becomes visible.
    useEffect(() => {
        if (visible) {
            setSuggestionPrefix('');
            resetHistoryPosition();
            focusInput();
        }
    }, [visible]);

    const execute = () => {
        const spaceIdx = buffer.indexOf(' ');
        const cmd = spaceIdx === -1 ? buffer : buffer.slice(0, spaceIdx);
        const args = spaceIdx === -1 ? '' : buffer.slice(spaceIdx + 1);

        invoke<string>('execute_command', { cmd, args })
            .then(message => { if (message) logger.info(message); })
            .catch(e => logger.error(String(e)));

        rememberCommand(buffer);
        close();
    };

    const replaceBuffer = (next: string | null) => {
        if (next !== null) setBuffer(next);
    };

    // Tab both walks the dropdown and, on an empty buffer, opens it.
    const cycleSuggestion = (direction: 1 | -1) => {
        if (showSuggestionDropdown) {
            replaceBuffer(navigateSuggestion(direction));
            return;
        }

        if (buffer.length === 0 && direction === 1) {
            setShowAllSuggestions(true);
            setSuggestionPrefix('');
        }
    };

    useActionHandler(Action.OpenCmdLine, () => setVisible(true));

    useActionHandler(Action.Submit, execute, visible);
    useActionHandler(Action.Cancel, close, visible);
    useActionHandler(Action.SelectNext, () => replaceBuffer(navigateSuggestion(1)), visible);
    useActionHandler(Action.SelectPrev, () => replaceBuffer(navigateSuggestion(-1)), visible);
    useActionHandler(Action.CycleNext, () => cycleSuggestion(1), visible);
    useActionHandler(Action.CyclePrev, () => cycleSuggestion(-1), visible);
    useActionHandler(Action.HistoryPrev, () => replaceBuffer(historyNavigate(-1)), visible);
    useActionHandler(Action.HistoryNext, () => replaceBuffer(historyNavigate(1)), visible);

    // Typing belongs to the input. Every other key bubbles to the global
    // keymap.
    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (isTextProducingKey(event.nativeEvent)) event.stopPropagation();
    };

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = event.target.value;
        setBuffer(newVal);
        setSuggestionPrefix(newVal);
        resetSuggestionDropdown();
        resetHistoryPosition();
    };

    if (!visible) return null;

    return (
        <div className={styles.cmdLine}>
            <span className={styles.prompt}>:</span>
            <input
                ref={inputRef}
                className={styles.input}
                value={buffer}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                spellCheck={false}
                autoComplete="off"
            />
            {showSuggestionDropdown && filteredSuggestions.length > 0 && (
                <div className={styles.suggestions}>
                    {filteredSuggestions.map((s, i) => (
                        <div key={s}
                            className={`${styles.suggestionItem} ${i === highlightedSuggestionIndex ? styles.suggestionSelected : ''}`}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                setBuffer(s);
                                setHighlightedSuggestionIndex(i);
                            }}
                        >{s}</div>
                    ))}
                </div>
            )}
        </div>
    );
}
