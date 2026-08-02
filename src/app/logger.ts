import { invoke } from '@tauri-apps/api/core';

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const TOAST_LEVELS: LogLevel[] = ['error', 'warn', 'info'];

async function log(level: LogLevel, message: string) {
    console[level](message);

    if (TOAST_LEVELS.includes(level)) {
        window.dispatchEvent(new CustomEvent('brittle:toast', {
            detail: { message, severity: level },
        }));
    }

    try {
        await invoke('ts_log', { level, message });
    } catch {
        console.error('Failed to send log to backend');
    }
}

export const logger = {
    error: (message: string) => log('error', message),
    warn: (message: string) => log('warn', message),
    info: (message: string) => log('info', message),
    debug: (message: string) => log('debug', message),
    trace: (message: string) => log('trace', message),
};
