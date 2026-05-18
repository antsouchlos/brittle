import React from "react";
import ReactDOM from "react-dom/client";
import "../theme.css";
import App from "./App";
import { setupTauriPinchAdapter } from "./tauriPinchAdapter";

// Re-dispatch captured touchpad zoom events as ctrl+wheel zoom events
{
    const pinchTeardown = setupTauriPinchAdapter().catch((err) => {
        console.error("pinch adapter failed", err);
        return () => { };
    });

    if (import.meta.hot) {
        import.meta.hot.dispose(async () => {
            (await pinchTeardown)();
        });
    }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
