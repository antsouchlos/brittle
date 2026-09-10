import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './CmdLine.module.css';
import { logger } from '../app/logger';
import { Action, useActionHandler } from '../app/actions';
import { useConfigChanged } from '../app/config';

// Converts a React keyboard event into a canonical combo string
// used for lookup in the key mapping tables.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

function normalizeKeyCombo(event: React.KeyboardEvent<HTMLInputElement>): string | null {
    const key = event.key;

    if (MODIFIER_KEYS.has(key)) {
        return null;
    }

    if (event.ctrlKey && key.length === 1) {
        return 'Ctrl+' + key.toLowerCase();
    }

    if (event.altKey && key.length === 1) {
        return 'Alt+' + key.toLowerCase();
    }

    return key;
}

// Action taken upon triggering a key mapping. Takes the current input buffer
// and returns one of
//   - `string` -> replaces the buffer
//   - `Promise<string | null>` -> replaces the buffer when resolved
//   - `null` -> no-op (buffer unchanged)
type KeyMappingAction = (buffer: string) => string | Promise<string | null> | null;

type PrefixedKeyMappingTable = Record<string, Record<string, KeyMappingAction>>;
type KeyMappingTable = Record<string, KeyMappingAction>;

interface CmdLineBindings {
    keyMapping: KeyMappingTable;
    prefixedKeyMapping: PrefixedKeyMappingTable;
}

function createDefaultBindings(
    onExecute: (cmd: string) => void,
    onCancel: () => void,
): CmdLineBindings {
    return {
        keyMapping: {
            'Enter': (buf) => {
                onExecute(buf);
                return '';
            },
            'Escape': () => {
                onCancel();
                return '';
            },
        },
        prefixedKeyMapping: {
            'Ctrl+r': {
                '0': async (buf) => {
                    try {
                        const text = await readText();
                        return buf + text;
                    } catch (e) {
                        logger.error(`Clipboard paste failed: ${e}`);
                        return null;
                    }
                },
            },
        },
    };
}

// Manages buffer state and a pending-prefix state for multi-key
// sequences. The feed() function drives the state machine and returns true
// when the combo was consumed.
function useCmdLineInput(bindings: CmdLineBindings) {
    const [buffer, setBuffer] = useState('');
    const pendingPrefix = useRef<string | null>(null);
    const bufferRef = useRef(buffer);

    useEffect(() => {
        bufferRef.current = buffer;
    }, [buffer]);

    const feed = useCallback((combo: string): boolean => {
        // Awaiting second key of a prefix sequence
        if (pendingPrefix.current !== null) {
            const prefix = pendingPrefix.current;
            pendingPrefix.current = null;

            const subTable = bindings.prefixedKeyMapping[prefix];
            if (subTable && combo in subTable) {
                const result = subTable[combo](bufferRef.current);
                if (result instanceof Promise) {
                    result.then((newBuf) => {
                        if (newBuf !== null) setBuffer(newBuf);
                    });
                } else if (result !== null) {
                    setBuffer(result);
                }
                return true;
            }

            // Invalid sequence let the key fall through to the input
            return false;
        }

        // Start of a prefix sequence
        if (combo in bindings.prefixedKeyMapping) {
            pendingPrefix.current = combo;
            return true;
        }

        // Direct action key
        if (combo in bindings.keyMapping) {
            const result = bindings.keyMapping[combo](bufferRef.current);
            if (result instanceof Promise) {
                result.then((newBuf) => {
                    if (newBuf !== null) setBuffer(newBuf);
                });
            } else if (result !== null) {
                setBuffer(result);
            }
            return true;
        }

        return false;
    }, [bindings]);

    const clear = useCallback(() => {
        setBuffer('');
        pendingPrefix.current = null;
    }, []);

    return { buffer, setBuffer, feed, clear };
}

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

    const resetHighlight = useCallback(() => {
        setHighlightedIndex(-1);
    }, []);

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
        resetSuggestionHighlight: resetHighlight,
        resetSuggestionDropdown: resetDropdown,
    };
}

function useCmdFocus(onCancel: () => void) {
    const inputRef = useRef<HTMLInputElement>(null);
    const blurGuardRef = useRef(false);

    const focusInput = useCallback(() => {
        requestAnimationFrame(() => inputRef.current?.focus());
    }, []);

    const handleBlur = useCallback(() => {
        if (blurGuardRef.current) {
            blurGuardRef.current = false;
            return;
        }
        onCancel();
    }, [onCancel]);

    const guardBlur = useCallback(() => {
        blurGuardRef.current = true;
    }, []);

    const resetBlurGuard = useCallback(() => {
        blurGuardRef.current = false;
    }, []);

    return { inputRef, focusInput, handleBlur, guardBlur, resetBlurGuard };
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
    const { suggestions, commandHistory, rememberCommand } = useCommandData();

    useActionHandler(Action.OpenCmdLine, () => setVisible(true));

    const onExecute = useCallback((cmdLine: string) => {
        const spaceIdx = cmdLine.indexOf(' ');
        const cmd = spaceIdx === -1 ? cmdLine : cmdLine.slice(0, spaceIdx);
        const args = spaceIdx === -1 ? '' : cmdLine.slice(spaceIdx + 1);

        invoke<string>('execute_command', { cmd, args })
            .then(message => { if (message) logger.info(message); })
            .catch(e => logger.error(String(e)));

        setVisible(false);
        rememberCommand(cmdLine);
    }, [rememberCommand]);

    const onCancel = useCallback(() => setVisible(false), []);

    const bindings = useMemo(
        () => createDefaultBindings(onExecute, onCancel),
        [onExecute, onCancel],
    );
    const { buffer, setBuffer, feed } = useCmdLineInput(bindings);
    const { historyNavigate, resetHistoryPosition } = useCmdHistory(commandHistory, buffer);
    const {
        filteredSuggestions,
        showSuggestionDropdown,
        highlightedSuggestionIndex,
        setHighlightedSuggestionIndex,
        setSuggestionPrefix,
        setShowAllSuggestions,
        navigateSuggestion,
        resetSuggestionHighlight,
        resetSuggestionDropdown,
    } = useCmdSuggestions(suggestions, buffer);

    const { inputRef, focusInput, handleBlur, guardBlur, resetBlurGuard } = useCmdFocus(onCancel);

    // Auto-focus the input whenever the cmdline becomes visible.
    useEffect(() => {
        if (visible) {
            setSuggestionPrefix('');
            resetHistoryPosition();
            resetBlurGuard();
            focusInput();
        }
    }, [visible]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();

        const combo = normalizeKeyCombo(event);
        if (combo === null) return;

        if (combo === 'ArrowUp' || combo === 'ArrowDown') {
            event.preventDefault();
            const result = historyNavigate(combo === 'ArrowUp' ? -1 : 1);
            if (result !== null) setBuffer(result);
            return;
        }

        if (combo === 'Ctrl+n') {
            event.preventDefault();
            event.stopPropagation();
            const result = navigateSuggestion(1);
            if (result !== null) setBuffer(result);
            return;
        }

        if (combo === 'Ctrl+p') {
            event.preventDefault();
            event.stopPropagation();
            const result = navigateSuggestion(-1);
            if (result !== null) setBuffer(result);
            return;
        }

        if (combo === 'Tab') {
            event.preventDefault();
            event.stopPropagation();

            if (showSuggestionDropdown) {
                const result = navigateSuggestion(event.shiftKey ? -1 : 1);
                if (result !== null) setBuffer(result);
                return;
            }

            if (buffer.length === 0 && !event.shiftKey) {
                setShowAllSuggestions(true);
                setSuggestionPrefix('');
            }
            return;
        }

        resetSuggestionDropdown();

        const wasHandled = feed(combo);
        if (wasHandled) {
            event.preventDefault();
            event.stopPropagation();

            if (combo === 'Enter' || combo === 'Escape') {
                guardBlur();
            }
        }
    };

    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const newVal = event.target.value;
        setBuffer(newVal);
        setSuggestionPrefix(newVal);
        resetSuggestionHighlight();
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
