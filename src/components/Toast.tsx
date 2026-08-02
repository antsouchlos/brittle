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
        <ToastContext.Provider value={{ toasts, log, addToast, dismissToast }}>
            {children}
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within ToastProvider');

    return { toast: ctx.addToast, log: ctx.log };
}

export function ToastContainer() {
    const ctx = useContext(ToastContext);
    if (!ctx) return null;

    const { toasts, dismissToast } = ctx;

    if (toasts.length === 0) return null;

    return (
        <div className={styles.toastArea}>
            {toasts.map(item => (
                <div key={item.id} className={`${styles.toast} ${styles[item.severity]}`}>
                    <span className={styles.toastMessage}>{item.message}</span>
                    <button
                        className={styles.toastClose}
                        onClick={() => dismissToast(item.id)}
                    >
                        ×
                    </button>
                </div>
            ))}
        </div>
    );
}
