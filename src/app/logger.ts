import { invoke } from '@tauri-apps/api/core';

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

async function log(level: LogLevel, message: string) {
    console[level](message);

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
