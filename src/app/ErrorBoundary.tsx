import { Component, ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';
import { logger } from './logger';

// The catch-all boundary at the very top of the tree. Without it, a throw
// during render unmounts everything and leaves a blank window with no
// indication of what happened.

interface ErrorBoundaryState {
    error: Error | null;
    componentStack: string | null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null, componentStack: null };

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        this.setState({ componentStack: errorInfo.componentStack ?? null });
        logger.error(
            `Uncaught render error: ${error.message}\n` +
            `${error.stack ?? '(no stack)'}\n` +
            `Component stack:${errorInfo.componentStack ?? ' (unavailable)'}`
        );
    }

    render() {
        const { error, componentStack } = this.state;
        if (!error) return this.props.children;

        return (
            <div className={styles.container}>
                <h1 className={styles.heading}>The interface crashed</h1>
                <p className={styles.message}>{error.message}</p>
                <pre className={styles.stack}>
                    {error.stack ?? '(no stack)'}
                    {componentStack ?? ''}
                </pre>
                <button className={styles.reloadButton} onClick={() => window.location.reload()}>
                    Reload
                </button>
            </div>
        );
    }
}
