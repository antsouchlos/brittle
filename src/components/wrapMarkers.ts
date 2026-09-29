import type { Extension } from '@codemirror/state';
import { EditorView, layer, type LayerMarker } from '@codemirror/view';

const WRAP_GLYPH = '↩';

// Rough width of the glyph, used only to keep it from being clipped by the
// right edge of the content box.
const GLYPH_WIDTH = 12;

class WrapMarker implements LayerMarker {
    constructor(
        private readonly left: number,
        private readonly top: number,
        private readonly height: number,
    ) { }

    eq(other: LayerMarker): boolean {
        return other instanceof WrapMarker
            && other.left === this.left
            && other.top === this.top
            && other.height === this.height;
    }

    draw() {
        const marker = document.createElement('div');
        marker.className = 'cm-wrapMarker';
        marker.textContent = WRAP_GLYPH;
        this.adjust(marker);
        return marker;
    }

    update(dom: HTMLElement) {
        this.adjust(dom);
        return true;
    }

    private adjust(marker: HTMLElement) {
        marker.style.left = `${this.left}px`;
        marker.style.top = `${this.top}px`;
        marker.style.height = `${this.height}px`;
    }
}

interface VisualRow {
    top: number;
    bottom: number;
    right: number;
}

interface VerticalSpan {
    top: number;
    bottom: number;
}

function holdsCenterOf(outer: VerticalSpan, inner: VerticalSpan): boolean {
    const center = (inner.top + inner.bottom) / 2;
    return center > outer.top && center < outer.bottom;
}

// A decorated line yields several rects per rendered row (bullet widgets, quote
// bars, emphasis spans, and the zero-width `cm-widgetBuffer` around every
// replaced range), so they have to be grouped back into rows.
function visualRows(range: Range): VisualRow[] {
    // A zero-width rect cannot mark where a row's text ends, and the buffers
    // sit at their own `text-top` offset, which would look like extra rows.
    const rects = [...range.getClientRects()]
        .filter(rect => rect.width > 0)
        .sort((a, b) => a.top - b.top);

    const rows: VisualRow[] = [];

    for (const rect of rects) {
        const row = rows[rows.length - 1];

        // Boxes of different font sizes share a baseline but not a top edge, so
        // rows are merged by vertical overlap rather than by exact position.
        if (row && (holdsCenterOf(row, rect) || holdsCenterOf(rect, row))) {
            row.top = Math.min(row.top, rect.top);
            row.bottom = Math.max(row.bottom, rect.bottom);
            row.right = Math.max(row.right, rect.right);
        } else {
            rows.push({ top: rect.top, bottom: rect.bottom, right: rect.right });
        }
    }

    return rows;
}

// Returns null for anything not rendered as a line, which is what keeps block
// widgets such as the rendered markdown table out of the measurement.
function lineElementAt(view: EditorView, pos: number): HTMLElement | null {
    try {
        const { node } = view.domAtPos(pos);
        const element = node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : node as HTMLElement;

        return element?.closest('.cm-line') ?? null;
    } catch {
        return null;
    }
}

// Layer markers are positioned relative to the document while client rects are
// relative to the viewport. This mirrors CodeMirror's own unexported `getBase`.
function layerBase(view: EditorView) {
    const rect = view.scrollDOM.getBoundingClientRect();

    return {
        left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
        top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
    };
}

function wrapMarkersFor(view: EditorView): WrapMarker[] {
    const base = layerBase(view);
    const maxLeft = view.contentDOM.getBoundingClientRect().right - GLYPH_WIDTH;
    const range = document.createRange();
    const markers: WrapMarker[] = [];

    for (const visible of view.visibleRanges) {
        for (let pos = visible.from; pos <= visible.to;) {
            const line = view.state.doc.lineAt(pos);
            const element = lineElementAt(view, line.from);

            if (element) {
                range.selectNodeContents(element);
                const rows = visualRows(range);

                // The last row is where the line genuinely ends, not a wrap.
                for (const row of rows.slice(0, -1)) {
                    markers.push(new WrapMarker(
                        Math.min(row.right, maxLeft) - base.left,
                        row.top - base.top,
                        row.bottom - row.top,
                    ));
                }
            }

            pos = line.to + 1;
        }
    }

    return markers;
}

const wrapMarkerTheme = EditorView.theme({
    '.cm-wrapMarker': {
        display: 'flex',
        alignItems: 'center',
        color: 'var(--fg4)',
        fontSize: '0.8em',
        lineHeight: '1',
        pointerEvents: 'none',
    },
});

export const WRAP_MARKERS: Extension = [
    layer({
        above: true,
        class: 'cm-wrapMarkerLayer',
        update: update => update.docChanged || update.viewportChanged || update.geometryChanged,
        markers: wrapMarkersFor,
    }),
    wrapMarkerTheme,
];
