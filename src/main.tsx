import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { setupTauriPinchAdapter } from "./tauriPinchAdapter";

const pinchTeardown = setupTauriPinchAdapter().catch((err) => {
    console.error("pinch adapter failed", err);
    return () => { };
});

if (import.meta.hot) {
    import.meta.hot.dispose(async () => {
        (await pinchTeardown)();
    });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
