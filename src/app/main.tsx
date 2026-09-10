import React from "react";
import ReactDOM from "react-dom/client";
import { installConsoleLogForwarding } from "./consoleLog";
import { logger } from "./logger";
import "../theme.css";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import { setupTauriPinchAdapter } from "./tauriPinchAdapter";

installConsoleLogForwarding();

// Re-dispatch captured touchpad zoom events as ctrl+wheel zoom events
{
    const pinchTeardown = setupTauriPinchAdapter().catch((err) => {
        logger.error(`pinch adapter failed: ${err}`);
        return () => { };
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(async () => {
            (await pinchTeardown)();
        });
    }
}

function describeReactError(kind: string, error: unknown, componentStack?: string | null): string {
    const detail = error instanceof Error
        ? `${error.message}\n${error.stack ?? '(no stack)'}`
        : String(error);
    return `${kind}: ${detail}\nComponent stack:${componentStack ?? ' (unavailable)'}`;
}

// React's own reporting channel. It covers the cases the boundary cannot, and
// does not depend on React continuing to route its reports through the
// console.
const rootErrorOptions = {
    onUncaughtError: (error: unknown, errorInfo: { componentStack?: string | null }) => {
        logger.error(describeReactError('Uncaught React error', error, errorInfo.componentStack));
    },
    onCaughtError: (error: unknown, errorInfo: { componentStack?: string | null }) => {
        logger.error(describeReactError('Caught React error', error, errorInfo.componentStack));
    },
    onRecoverableError: (error: unknown, errorInfo: { componentStack?: string | null }) => {
        logger.warn(describeReactError('Recoverable React error', error, errorInfo.componentStack));
    },
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, rootErrorOptions).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
        </ErrorBoundary>
    </React.StrictMode>,
);
