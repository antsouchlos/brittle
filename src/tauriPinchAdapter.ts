/**
 * On Linux, Tauri's WebKitGTK webview intercepts trackpad pinch as page zoom
 * before JS sees it. The Rust side captures the gesture and emits Tauri events;
 * this adapter re-dispatches them as synthetic Ctrl+wheel events so frontend
 * code can handle pinch the same way browsers natively report it.
 */
export async function setupTauriPinchAdapter() {
    // Bail out if not running inside Tauri
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
        return;
    }

    // Dynamic import so the @tauri-apps/api code isn't even loaded in the browser
    const { listen } = await import('@tauri-apps/api/event');

    let pinchOriginX = 0;
    let pinchOriginY = 0;
    let lastScale = 1;

    await listen<[number, number]>('pinch-begin', (event) => {
        const [x, y] = event.payload;
        pinchOriginX = x;
        pinchOriginY = y;
        lastScale = 1;
    });

    await listen<number>('pinch-scale', (event) => {
        const currentScale = event.payload;
        const scaleRatio = currentScale / lastScale;
        lastScale = currentScale;

        const deltaY = -Math.log(scaleRatio) * 100;
        const target = document.elementFromPoint(pinchOriginX, pinchOriginY) ?? document.body;

        const wheelEvent = new WheelEvent('wheel', {
            deltaY,
            ctrlKey: true,
            clientX: pinchOriginX,
            clientY: pinchOriginY,
            bubbles: true,
            cancelable: true,
        });

        target.dispatchEvent(wheelEvent);
    });
}
