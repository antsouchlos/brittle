import { createElement, Fragment, type ReactNode } from 'react';

// Lua-supplied reference previews may carry light inline formatting. The
// markup is turned into React elements rather than handed to
// dangerouslySetInnerHTML, so a compiler that emits a script tag or a stray
// angle bracket produces literal text instead of markup.
const allowedTags: Record<string, string> = {
    i: 'em',
    em: 'em',
    b: 'strong',
    strong: 'strong',
    u: 'u',
    sup: 'sup',
    sub: 'sub',
};

const tagPattern = /<\s*(\/?)\s*([a-zA-Z]+)\s*(\/?)\s*>/g;

const entityDecoder = document.createElement('textarea');

// A textarea's content is RCDATA, so the parser resolves entities without ever
// building elements out of the string, and this decoder is detached from the
// document. That buys the full named-entity table (&middot;, &ndash;, ...)
// without the risk of treating the preview as HTML.
function decodeEntities(text: string): string {
    if (!text.includes('&')) return text;

    entityDecoder.innerHTML = text;

    return entityDecoder.value;
}

interface OpenElement {
    tag: string | null;
    children: ReactNode[];
}

function pushText(frame: OpenElement, text: string) {
    if (text.length > 0) frame.children.push(decodeEntities(text));
}

function closeFrame(stack: OpenElement[], keyCounter: { next: number }) {
    const frame = stack.pop();
    if (!frame || frame.tag === null) return;

    const parent = stack[stack.length - 1];
    parent.children.push(
        createElement(frame.tag, { key: keyCounter.next++ }, ...frame.children),
    );
}

// Unknown tags and unbalanced closing tags are emitted verbatim, so nothing
// is silently dropped.
export function parseInlineMarkup(source: string): ReactNode {
    const stack: OpenElement[] = [{ tag: null, children: [] }];
    const keyCounter = { next: 0 };

    let cursor = 0;
    let match: RegExpExecArray | null;

    tagPattern.lastIndex = 0;

    while ((match = tagPattern.exec(source)) !== null) {
        const [raw, closing, name, selfClosing] = match;
        const frame = stack[stack.length - 1];

        pushText(frame, source.slice(cursor, match.index));
        cursor = match.index + raw.length;

        const lowerName = name.toLowerCase();

        if (lowerName === 'br' && !closing) {
            frame.children.push(createElement('br', { key: keyCounter.next++ }));
            continue;
        }

        const mappedTag = allowedTags[lowerName];
        if (!mappedTag) {
            frame.children.push(raw);
            continue;
        }

        if (closing) {
            // Searched from the top, so `<em>a<em>b</em>c</em>` closes the inner
            // element first rather than collapsing both at once.
            let openIndex = -1;
            for (let index = stack.length - 1; index > 0; index--) {
                if (stack[index].tag === mappedTag) {
                    openIndex = index;
                    break;
                }
            }
            if (openIndex === -1) {
                frame.children.push(raw);
                continue;
            }

            while (stack.length > openIndex) {
                closeFrame(stack, keyCounter);
            }

            continue;
        }

        if (selfClosing) continue;

        stack.push({ tag: mappedTag, children: [] });
    }

    pushText(stack[stack.length - 1], source.slice(cursor));

    while (stack.length > 1) {
        closeFrame(stack, keyCounter);
    }

    return createElement(Fragment, null, ...stack[0].children);
}
