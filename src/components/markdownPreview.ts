import {
    defineLanguageFacet,
    ensureSyntaxTree,
    HighlightStyle,
    indentNodeProp,
    Language,
    languageDataProp,
    syntaxHighlighting,
    syntaxTree,
} from '@codemirror/language';
import { GFM, parser as commonmarkParser } from '@lezer/markdown';
import { EditorState, Extension, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { SyntaxNode } from '@lezer/common';

const markdownLanguageData = defineLanguageFacet({
    commentTokens: { block: { open: '<!--', close: '-->' } },
});

const markdownLanguage = new Language(
    markdownLanguageData,
    commonmarkParser.configure([
        GFM,
        {
            props: [
                languageDataProp.add({ Document: markdownLanguageData }),
                indentNodeProp.add({ Document: () => null }),
            ],
        },
    ]),
    [],
    'markdown',
);

const headingStyles = [
    { tag: tags.heading1, fontSize: '1.45em' },
    { tag: tags.heading2, fontSize: '1.3em' },
    { tag: tags.heading3, fontSize: '1.17em' },
    { tag: tags.heading4, fontSize: '1.05em' },
    { tag: tags.heading5, fontSize: '1em' },
    { tag: tags.heading6, fontSize: '1em' },
].map(style => ({ ...style, fontWeight: '700', color: 'var(--accent1)', lineHeight: '1.4' }));

const markdownHighlightStyle = HighlightStyle.define([
    ...headingStyles,
    { tag: tags.strong, fontWeight: '700', color: 'var(--fg0)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--fg4)' },
    { tag: tags.quote, color: 'var(--fg2)', fontStyle: 'italic' },
    { tag: tags.monospace, color: 'var(--accent4)' },
    { tag: tags.link, color: 'var(--accent3)' },
    { tag: tags.url, color: 'var(--fg4)' },
    { tag: tags.processingInstruction, color: 'var(--fg4)' },
]);

class BulletWidget extends WidgetType {
    eq() {
        return true;
    }

    toDOM() {
        const bullet = document.createElement('span');
        bullet.className = 'cm-md-bullet';
        bullet.textContent = '•';
        return bullet;
    }
}

// Occupies exactly the one column the `>` did, so hiding the mark never shifts
// the quoted text out of line with the source.
class QuoteBarWidget extends WidgetType {
    eq() {
        return true;
    }

    toDOM() {
        const bar = document.createElement('span');
        bar.className = 'cm-md-quote-bar';
        return bar;
    }
}

const bulletWidget = new BulletWidget();
const quoteBarWidget = new QuoteBarWidget();

type CellAlignment = 'left' | 'center' | 'right';

interface CellSegment {
    text: string;
    className: string;
}

interface TableRowModel {
    header: boolean;
    cells: CellSegment[][];
}

const INLINE_CLASS_BY_NODE: Record<string, string> = {
    StrongEmphasis: 'cm-md-strong',
    Emphasis: 'cm-md-em',
    InlineCode: 'cm-md-code',
    Strikethrough: 'cm-md-strike',
};

function textWithoutMarks(state: EditorState, node: SyntaxNode): string {
    let text = '';
    let pos = node.from;

    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (!child.name.endsWith('Mark')) continue;
        text += state.sliceDoc(pos, child.from);
        pos = child.to;
    }

    return text + state.sliceDoc(pos, node.to);
}

function cellSegments(state: EditorState, cell: SyntaxNode): CellSegment[] {
    const segments: CellSegment[] = [];
    let pos = cell.from;

    for (let child = cell.firstChild; child; child = child.nextSibling) {
        const className = INLINE_CLASS_BY_NODE[child.name];
        if (!className) continue;

        if (child.from > pos) {
            segments.push({ text: state.sliceDoc(pos, child.from), className: '' });
        }
        segments.push({ text: textWithoutMarks(state, child), className });
        pos = child.to;
    }

    if (pos < cell.to) segments.push({ text: state.sliceDoc(pos, cell.to), className: '' });

    return segments;
}

function cellAlignments(state: EditorState, table: SyntaxNode): CellAlignment[] {
    for (let child = table.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'TableDelimiter') continue;

        const spec = state.sliceDoc(child.from, child.to);
        if (!spec.includes('-')) continue;

        return spec
            .replace(/^\s*\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map(column => {
                const trimmed = column.trim();
                if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
                if (trimmed.endsWith(':')) return 'right';
                return 'left';
            });
    }

    return [];
}

function tableRows(state: EditorState, table: SyntaxNode): TableRowModel[] {
    const rows: TableRowModel[] = [];

    for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;

        const cells: CellSegment[][] = [];
        for (let cell = row.firstChild; cell; cell = cell.nextSibling) {
            if (cell.name === 'TableCell') cells.push(cellSegments(state, cell));
        }

        rows.push({ header: row.name === 'TableHeader', cells });
    }

    return rows;
}

class TableWidget extends WidgetType {
    constructor(
        private readonly rows: TableRowModel[],
        private readonly alignments: CellAlignment[],
        private readonly source: string,
    ) {
        super();
    }

    eq(other: TableWidget) {
        return other.source === this.source;
    }

    // Let clicks through, so clicking a rendered table puts the cursor inside it
    // and the same selection test that hid the source brings it back.
    ignoreEvent() {
        return false;
    }

    toDOM() {
        const table = document.createElement('table');
        table.className = 'cm-md-table';

        for (const row of this.rows) {
            const tr = document.createElement('tr');

            row.cells.forEach((segments, column) => {
                const cell = document.createElement(row.header ? 'th' : 'td');
                cell.style.textAlign = this.alignments[column] ?? 'left';

                for (const segment of segments) {
                    const span = document.createElement('span');
                    if (segment.className) span.className = segment.className;
                    span.textContent = segment.text;
                    cell.appendChild(span);
                }

                tr.appendChild(cell);
            });

            table.appendChild(tr);
        }

        return table;
    }
}

interface MarkdownDecorations {
    decorations: DecorationSet;
    atomic: DecorationSet;
}

const hiddenDecoration = Decoration.replace({});
const bulletDecoration = Decoration.replace({ widget: bulletWidget });
const quoteBarDecoration = Decoration.replace({ widget: quoteBarWidget });

const HIDDEN_MARK_NODES = new Set([
    'HeaderMark',
    'EmphasisMark',
    'StrikethroughMark',
    'HardBreak',
]);

function revealedLineNumbers(state: EditorState): Set<number> {
    const lines = new Set<number>();

    for (const range of state.selection.ranges) {
        const first = state.doc.lineAt(range.from).number;
        const last = state.doc.lineAt(range.to).number;
        for (let line = first; line <= last; line++) lines.add(line);
    }

    return lines;
}

// Parsing lags behind the document for large inputs, and a stale tree would
// leave the tail of a note undecorated until the next keystroke.
function completeTree(state: EditorState) {
    return ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
}

function skipTrailingSpaces(state: EditorState, from: number, to: number): number {
    const lineEnd = state.doc.lineAt(from).to;
    let end = to;

    while (end < lineEnd && state.sliceDoc(end, end + 1) === ' ') end++;

    return end;
}

const indentDecorations = new Map<number, Decoration>();

function indentDecoration(columns: number): Decoration {
    let decoration = indentDecorations.get(columns);

    if (!decoration) {
        decoration = Decoration.line({
            attributes: { style: `margin-left:${columns}ch;text-indent:-${columns}ch` },
        });
        indentDecorations.set(columns, decoration);
    }

    return decoration;
}

function buildDecorations(state: EditorState): MarkdownDecorations {
    const revealed = revealedLineNumbers(state);
    const inline: Range<Decoration>[] = [];
    const blocks: Range<Decoration>[] = [];
    const lines: Range<Decoration>[] = [];
    const indentedLines = new Set<number>();

    // A quoted list would otherwise be indented twice. The outer block, which is
    // entered first, wins.
    const addHangingIndent = (pos: number, columns: number) => {
        const line = state.doc.lineAt(pos);
        if (columns <= 0 || indentedLines.has(line.number)) return;
        indentedLines.add(line.number);
        lines.push(indentDecoration(columns).range(line.from));
    };

    const isRevealed = (pos: number) => revealed.has(state.doc.lineAt(pos).number);

    completeTree(state).iterate({
        enter: node => {
            if (node.name === 'Table') {
                const intersectsSelection = state.selection.ranges.some(
                    range => range.to >= node.from && range.from <= node.to,
                );
                if (intersectsSelection) return true;

                blocks.push(
                    Decoration.replace({
                        widget: new TableWidget(
                            tableRows(state, node.node),
                            cellAlignments(state, node.node),
                            state.sliceDoc(node.from, node.to),
                        ),
                        block: true,
                    }).range(node.from, node.to),
                );
                return false;
            }

            if (node.name === 'ListItem') {
                const mark = node.node.firstChild;
                if (mark?.name === 'ListMark') {
                    const contentStart = skipTrailingSpaces(state, mark.from, mark.to);
                    addHangingIndent(node.from, contentStart - state.doc.lineAt(node.from).from);
                }
                return true;
            }

            if (node.name === 'Blockquote') {
                for (let pos = node.from; pos <= node.to;) {
                    const line = state.doc.lineAt(pos);
                    addHangingIndent(line.from, /^[>\s]*/.exec(line.text)?.[0].length ?? 0);
                    pos = line.to + 1;
                }
                return true;
            }

            if (isRevealed(node.from)) return true;

            if (node.name === 'Link') {
                const marks: SyntaxNode[] = [];
                for (let child = node.node.firstChild; child; child = child.nextSibling) {
                    if (child.name === 'LinkMark') marks.push(child);
                }
                if (marks.length < 2) return true;

                // Hides the brackets and everything after the label, leaving the
                // link text alone. Emphasis inside the label is not decorated.
                inline.push(hiddenDecoration.range(node.from, marks[0].to));
                inline.push(hiddenDecoration.range(marks[1].from, node.to));
                return false;
            }

            if (node.name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
                inline.push(hiddenDecoration.range(node.from, node.to));
                return false;
            }

            if (node.name === 'QuoteMark') {
                inline.push(quoteBarDecoration.range(node.from, node.to));
                return false;
            }

            if (node.name === 'ListMark') {
                if (node.node.parent?.parent?.name === 'BulletList') {
                    inline.push(bulletDecoration.range(node.from, node.to));
                }
                return false;
            }

            if (HIDDEN_MARK_NODES.has(node.name)) {
                const to = node.name === 'HeaderMark'
                    ? skipTrailingSpaces(state, node.from, node.to)
                    : node.to;
                inline.push(hiddenDecoration.range(node.from, to));
                return false;
            }

            return true;
        },
    });

    return {
        decorations: Decoration.set(lines.concat(inline, blocks), true),
        // The table block is deliberately left out: making it atomic would put
        // the cursor past it rather than in it, and entering it is what reveals
        // the source.
        atomic: Decoration.set(inline, true),
    };
}

const markdownDecorationField = StateField.define<MarkdownDecorations>({
    create: buildDecorations,
    update: (value, tr) =>
        tr.docChanged || tr.selection ? buildDecorations(tr.state) : value,
    provide: field => [
        EditorView.decorations.from(field, value => value.decorations),
        EditorView.atomicRanges.of(view => view.state.field(field).atomic),
    ],
});

const markdownPreviewTheme = EditorView.theme({
    '.cm-md-bullet': { color: 'var(--accent1)' },
    '.cm-md-quote-bar': {
        display: 'inline-block',
        boxSizing: 'border-box',
        width: '1ch',
        borderLeft: '2px solid var(--accent3)',
    },
    '.cm-md-table': {
        borderCollapse: 'collapse',
        margin: '2px 0',
    },
    '.cm-md-table th, .cm-md-table td': {
        border: '1px solid var(--bg3)',
        padding: '1px 6px',
    },
    '.cm-md-table th': {
        background: 'var(--bg2)',
        color: 'var(--fg0)',
        fontWeight: '700',
    },
    '.cm-md-strong': { fontWeight: '700', color: 'var(--fg0)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-code': { color: 'var(--accent4)' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--fg4)' },
});

export const MARKDOWN_PREVIEW_EXTENSIONS: Extension[] = [
    markdownLanguage,
    syntaxHighlighting(markdownHighlightStyle),
    markdownDecorationField,
    markdownPreviewTheme,
];
