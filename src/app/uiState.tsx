import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from './logger';

const SAVE_DEBOUNCE_MS = 250;

type UiStateMap = Record<string, unknown>;

interface UiStateContextValue {
    loaded: boolean;
    read: (key: string) => unknown;
    write: (key: string, value: unknown) => void;
}

const UiStateContext = createContext<UiStateContextValue | null>(null);

export function UiStateProvider({ children }: { children: ReactNode }) {
    // The map lives in a ref so that a write does not re-render every consumer;
    // each `useRestoredState` holds its own copy of its own value as state.
    const mapRef = useRef<UiStateMap>({});
    const [loaded, setLoaded] = useState(false);
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        invoke<UiStateMap>('load_ui_state')
            .then(stored => { mapRef.current = stored ?? {}; })
            .catch(e => logger.error(`Failed to load UI state: ${e}`))
            .finally(() => setLoaded(true));
    }, []);

    const read = useCallback((key: string) => mapRef.current[key], []);

    const write = useCallback((key: string, value: unknown) => {
        mapRef.current = { ...mapRef.current, [key]: value };

        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            invoke('save_ui_state', { uiState: mapRef.current })
                .catch(e => logger.error(`Failed to save UI state: ${e}`));
        }, SAVE_DEBOUNCE_MS);
    }, []);

    return (
        <UiStateContext.Provider value={{ loaded, read, write }}>
            {children}
        </UiStateContext.Provider>
    );
}

// `useState` that seeds itself from the stored UI state once it has been read
// from disk, and writes every subsequent value back.
//
// Until the load resolves the caller sees `initial`, and nothing is written, so
// a default rendered on the first frame can never overwrite a stored value.
export function useRestoredState<T>(
    key: string,
    initial: T,
): [T, (value: T | ((prev: T) => T)) => void] {
    const context = useContext(UiStateContext);
    if (!context) throw new Error('useRestoredState used outside a UiStateProvider');
    const { loaded, read, write } = context;

    const [value, setValue] = useState<T>(initial);
    // Mirrors `value` so the setter can resolve an updater without running a
    // write inside a state-updater callback.
    const valueRef = useRef(value);
    valueRef.current = value;
    const hydratedRef = useRef(false);

    useEffect(() => {
        if (!loaded || hydratedRef.current) return;
        hydratedRef.current = true;

        const stored = read(key);
        if (stored === undefined) return;
        valueRef.current = stored as T;
        setValue(stored as T);
    }, [loaded, key, read]);

    const set = useCallback((next: T | ((prev: T) => T)) => {
        const resolved = typeof next === 'function'
            ? (next as (prev: T) => T)(valueRef.current)
            : next;

        const unchanged = resolved === valueRef.current;
        valueRef.current = resolved;
        setValue(resolved);

        // An updater that returns its input (a no-op prune, say) should not
        // rewrite the file.
        if (hydratedRef.current && !unchanged) write(key, resolved);
    }, [key, write]);

    return [value, set];
}
