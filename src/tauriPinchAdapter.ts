/**
 * On Linux, Tauri's WebKitGTK webview intercepts trackpad pinch as page zoom
 * before JS sees it. The Rust side captures the gesture and emits Tauri events;
 * this adapter re-dispatches them as synthetic Ctrl+wheel events so frontend
 * code can handle pinch the same way browsers natively report it.
 *
 * Returns a teardown fn that removes the Tauri event listeners. Needed so HMR
 * reloads don't stack duplicate listeners across module reloads; the caller
 * should invoke it from `import.meta.hot.dispose`.
 */
// TODO: Make zoom factor configurable (factor 100 on deltaY)
export async function setupTauriPinchAdapter(): Promise<() => void> {
    // Bail out if not running inside Tauri
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
        return () => { };
    }

    // Dynamic import so the @tauri-apps/api code isn't even loaded in the browser
    const { listen } = await import('@tauri-apps/api/event');

    let pinchOriginX = 0;
    let pinchOriginY = 0;
    let lastScale = 1;

    const unlistenBegin = await listen<[number, number]>('pinch-begin', (event) => {
        const [x, y] = event.payload;
        pinchOriginX = x;
        pinchOriginY = y;
        lastScale = 1;
    });

    const unlistenScale = await listen<number>('pinch-scale', (event) => {
        const currentScale = event.payload;
        const scaleRatio = currentScale / lastScale;
        lastScale = currentScale;

        const deltaY = -Math.log(scaleRatio) * 100;
        const target = deepElementFromPoint(pinchOriginX, pinchOriginY) ?? document.body;

        const wheelEvent = new WheelEvent('wheel', {
            deltaY,
            ctrlKey: true,
            clientX: pinchOriginX,
            clientY: pinchOriginY,
            bubbles: true,
            cancelable: true,
            composed: true,
        });

        target.dispatchEvent(wheelEvent);
    });

    return () => {
        unlistenBegin();
        unlistenScale();
    };
}

// `document.elementFromPoint` only sees light-DOM elements; the embed-pdf viewer
// renders inside a shadow root, so we recurse into shadow roots to find the
// deepest element at the given viewport coordinates.
function deepElementFromPoint(x: number, y: number): Element | null {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
    }
    return el;
}
