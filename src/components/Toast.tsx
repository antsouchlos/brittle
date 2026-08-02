import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import styles from './Toast.module.css';

export type ToastSeverity = 'info' | 'warn' | 'error';

export interface ToastItem {
    id: number;
    message: string;
    severity: ToastSeverity;
}

interface ToastContextValue {
    toasts: ToastItem[];
    log: ToastItem[];
    addToast: (message: string, severity: ToastSeverity) => void;
    dismissToast: (id: number) => void;
    clearToastTimer: (id: number) => void;
    resetToastTimer: (id: number, timeoutMs: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const logRef = useRef<ToastItem[]>([]);
    const [log, setLog] = useState<ToastItem[]>([]);
    const timersRef = useRef<Map<number, number>>(new Map());

    const dismissToast = useCallback((id: number) => {
        const timer = timersRef.current.get(id);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timersRef.current.delete(id);
        }

        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    const clearToastTimer = useCallback((id: number) => {
        const timer = timersRef.current.get(id);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timersRef.current.delete(id);
        }
    }, []);

    const resetToastTimer = useCallback((id: number, timeoutMs: number) => {
        clearToastTimer(id);
        const timer = window.setTimeout(() => dismissToast(id), timeoutMs);
        timersRef.current.set(id, timer);
    }, [clearToastTimer, dismissToast]);

    const addToast = useCallback((message: string, severity: ToastSeverity) => {
        const id = nextId++;
        const item: ToastItem = { id, message, severity };

        logRef.current.push(item);
        setLog([...logRef.current]);

        setToasts(prev => {
            if (prev.length >= 5) {
                const oldest = prev[0];
                const timer = timersRef.current.get(oldest.id);
                if (timer !== undefined) {
                    window.clearTimeout(timer);
                    timersRef.current.delete(oldest.id);
                }
                return [...prev.slice(1), item];
            }

            return [...prev, item];
        });

        const timeout = severity === 'error' ? 8000 : 5000;
        const timer = window.setTimeout(() => dismissToast(id), timeout);
        timersRef.current.set(id, timer);
    }, [dismissToast]);

    useEffect(() => {
        const handler = (event: Event) => {
            const { message, severity } = (event as CustomEvent).detail as {
                message: string;
                severity: ToastSeverity;
            };
            addToast(message, severity);
        };
        window.addEventListener('brittle:toast', handler);
        return () => window.removeEventListener('brittle:toast', handler);
    }, [addToast]);

    return (
        <ToastContext.Provider value={{
            toasts,
            log,
            addToast,
            dismissToast,
            clearToastTimer,
            resetToastTimer,
        }}>
            {children}
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within ToastProvider');

    return { toast: ctx.addToast, log: ctx.log };
}

const EXTEND_TIMEOUT = 15000;

function useToastTimerPause(
    id: number,
    clearTimer: (id: number) => void,
    resetTimer: (id: number, timeoutMs: number) => void,
) {
    const docListenerRef = useRef<(() => void) | null>(null);

    const onMouseDown = () => {
        clearTimer(id);

        const onDocMouseUp = () => {
            resetTimer(id, EXTEND_TIMEOUT);
            document.removeEventListener('mouseup', onDocMouseUp);
            docListenerRef.current = null;
        };
        document.addEventListener('mouseup', onDocMouseUp);
        docListenerRef.current = onDocMouseUp;
    };

    const onMouseUp = () => {
        resetTimer(id, EXTEND_TIMEOUT);
    };

    useEffect(() => {
        return () => {
            if (docListenerRef.current) {
                document.removeEventListener('mouseup', docListenerRef.current);
            }
        };
    }, [id]);

    return { onMouseDown, onMouseUp };
}

function ToastItemView({
    item,
    dismissToast,
    clearToastTimer,
    resetToastTimer,
}: {
    item: ToastItem;
    dismissToast: (id: number) => void;
    clearToastTimer: (id: number) => void;
    resetToastTimer: (id: number, timeoutMs: number) => void;
}) {
    const { onMouseDown, onMouseUp } = useToastTimerPause(
        item.id,
        clearToastTimer,
        resetToastTimer,
    );

    return (
        <div
            className={`${styles.toast} ${styles[item.severity]}`}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
        >
            <span className={styles.toastMessage}>{item.message}</span>
            <button
                className={styles.toastClose}
                onClick={() => dismissToast(item.id)}
            >
                ×
            </button>
        </div>
    );
}

export function ToastContainer() {
    const ctx = useContext(ToastContext);
    if (!ctx) return null;

    const { toasts, dismissToast, clearToastTimer, resetToastTimer } = ctx;

    if (toasts.length === 0) return null;

    return (
        <div className={styles.toastArea}>
            {toasts.map(item => (
                <ToastItemView
                    key={item.id}
                    item={item}
                    dismissToast={dismissToast}
                    clearToastTimer={clearToastTimer}
                    resetToastTimer={resetToastTimer}
                />
            ))}
        </div>
    );
}
