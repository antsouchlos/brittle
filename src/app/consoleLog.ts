import { invoke } from '@tauri-apps/api/core';

type BackendLogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

// `trace` is dropped by the backend's `LevelFilter::Debug`, so console.trace
// is demoted to debug rather than sent into the void.
const CONSOLE_METHOD_LEVELS: Array<[keyof Console, BackendLogLevel]> = [
    ['error', 'error'],
    ['warn', 'warn'],
    ['info', 'info'],
    ['log', 'info'],
    ['debug', 'debug'],
    ['trace', 'debug'],
];

// Guards against a loop: forwarding a message can itself write to the console,
// and `logger` writes to the console for messages it already sends itself.
let isForwardingLogMessage = false;

// Runs `body` with console forwarding suppressed, for callers that send the
// same message to the backend through another path.
export function runWithoutConsoleForwarding(body: () => void) {
    const wasForwarding = isForwardingLogMessage;
    isForwardingLogMessage = true;
    try {
        body();
    } finally {
        isForwardingLogMessage = wasForwarding;
    }
}

function formatConsoleArgument(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value instanceof Error) {
        return `${value.name}: ${value.message}\n${value.stack ?? '(no stack)'}`;
    }

    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        // Cyclic or otherwise unserializable.
        return String(value);
    }
}

export function formatConsoleArguments(args: unknown[]): string {
    return args.map(formatConsoleArgument).join(' ');
}

function forwardToBackend(level: BackendLogLevel, message: string) {
    if (isForwardingLogMessage) return;

    isForwardingLogMessage = true;
    try {
        void invoke('ts_log', { level, message }).catch(() => {
            // Nowhere left to report this; the console is the thing that
            // failed to reach the backend in the first place.
        });
    } finally {
        isForwardingLogMessage = false;
    }
}

export function installConsoleLogForwarding() {
    for (const [method, level] of CONSOLE_METHOD_LEVELS) {
        const original = console[method] as (...args: unknown[]) => void;
        (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            original.apply(console, args);
            forwardToBackend(level, formatConsoleArguments(args));
        };
    }

    // The browser reports these through its own channel rather than through
    // the console methods patched above, so without these listeners an
    // uncaught throw still leaves no trace in the app log.
    window.addEventListener('error', event => {
        const where = `${event.filename}:${event.lineno}:${event.colno}`;
        const detail = event.error instanceof Error
            ? formatConsoleArgument(event.error)
            : event.message;
        forwardToBackend('error', `Uncaught error at ${where}: ${detail}`);
    });

    window.addEventListener('unhandledrejection', event => {
        forwardToBackend('error', `Unhandled rejection: ${formatConsoleArgument(event.reason)}`);
    });
}
