import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { logger } from './logger';

export interface TagColors {
    foreground: string | null;
    background: string | null;
}

export interface Config {
    opts: {
        autosaveDebounceMs: number;
        tagColors: Record<string, TagColors>;
    };
}

const DEFAULT_CONFIG: Config = {
    opts: {
        autosaveDebounceMs: 250,
        tagColors: {},
    },
};

type ConfigChangedCallback = () => void;

interface ConfigContextValue {
    config: Config;
    subscribeToChanges: (callback: ConfigChangedCallback) => () => void;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

// Owns the single `config-changed` listener. The Lua config hot-reloads at
// runtime, and several components hold data derived from it (the cmdline's
// command list, the detail view's autosave delay), so they subscribe here
// instead of each registering their own Tauri listener.
export function ConfigProvider({ children }: { children: ReactNode }) {
    const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
    const subscribersRef = useRef(new Set<ConfigChangedCallback>());

    const loadConfig = useCallback(() => {
        invoke<Config>('get_config')
            .then(setConfig)
            .catch(e => logger.error(`Failed to load config: ${e}`));
    }, []);

    useEffect(() => {
        loadConfig();

        const configChanged = listen('config-changed', () => {
            loadConfig();
            for (const callback of subscribersRef.current) callback();
        });
        const configError = listen('config-reload-error', (event) => {
            logger.error(String(event.payload));
        });

        return () => {
            configChanged.then(unlisten => unlisten());
            configError.then(unlisten => unlisten());
        };
    }, [loadConfig]);

    const subscribeToChanges = useCallback((callback: ConfigChangedCallback) => {
        subscribersRef.current.add(callback);
        return () => { subscribersRef.current.delete(callback); };
    }, []);

    return (
        <ConfigContext.Provider value={{ config, subscribeToChanges }}>
            {children}
        </ConfigContext.Provider>
    );
}

export function useConfig(): Config {
    const context = useContext(ConfigContext);
    if (!context) throw new Error('useConfig used outside a ConfigProvider');
    return context.config;
}

// Runs `callback` whenever the Lua config is reloaded, for consumers that hold
// derived backend data rather than the config itself.
export function useConfigChanged(callback: ConfigChangedCallback) {
    const context = useContext(ConfigContext);
    if (!context) throw new Error('useConfigChanged used outside a ConfigProvider');
    const { subscribeToChanges } = context;

    const latestRef = useRef(callback);
    latestRef.current = callback;

    useEffect(
        () => subscribeToChanges(() => latestRef.current()),
        [subscribeToChanges],
    );
}
