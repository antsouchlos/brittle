import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Fzf, extendedMatch } from 'fzf';
import { FaFilePdf } from 'react-icons/fa';
import { Globe, Pencil, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import styles from './PublicationList.module.css';
import {
    Action,
    findKeybindingForAction,
    isTextProducingKey,
    useActionHandler,
} from '../app/actions';
import { logger } from '../app/logger';
import { useFocusTarget } from '../app/focus.tsx';
import { useConfig, type TagColors } from '../app/config';
import TextEditor, { type EditorMode } from './TextEditor.tsx';

interface PublicationListItem {
    id: string;
    title: string;
    author: string;
    publisher: string;
    date: string;
    filename: string;
    contentFiles: string[];
    tags: string[];
}

interface PublicationListProps {
    publications: Array<PublicationListItem>
    selectedPublicationId: string;
    onSelectPublication: (publicationId: string) => void;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
}

interface HighlightPart {
    text: string;
    matched: boolean;
}

function convertMatchPositionsToHighlightSegments(text: string, matchPositions: Set<number>): HighlightPart[] {
    const parts: HighlightPart[] = [];
    let currentMatched = false;
    let start = 0;

    for (let i = 0; i < text.length; i++) {
        const isMatched = matchPositions.has(i);
        if (isMatched !== currentMatched) {
            if (i > start) {
                parts.push({ text: text.slice(start, i), matched: currentMatched });
            }
            currentMatched = isMatched;
            start = i;
        }
    }
    if (start < text.length) {
        parts.push({ text: text.slice(start), matched: currentMatched });
    }

    return parts;
}

function splitMatchPositionsByField(
    matchPositions: Set<number>,
    titleLen: number,
    authorLen: number,
    publisherLen: number,
    dateLen: number,
    filenameLen: number,
) {
    const titlePositions = new Set(
        Array.from(matchPositions).filter(p => p < titleLen),
    );
    const authorPositions = new Set(
        Array.from(matchPositions)
            .filter(p => p >= titleLen && p < titleLen + authorLen)
            .map(p => p - titleLen),
    );
    const publisherPositions = new Set(
        Array.from(matchPositions)
            .filter(p => p >= titleLen + authorLen && p < titleLen + authorLen + publisherLen)
            .map(p => p - titleLen - authorLen),
    );
    const dateStart = titleLen + authorLen + publisherLen;
    const dateEnd = dateStart + dateLen;
    const datePositions = new Set(
        Array.from(matchPositions)
            .filter(p => p >= dateStart && p < dateEnd)
            .map(p => p - dateStart),
    );
    const filenamePositions = new Set(
        Array.from(matchPositions)
            .filter(p => p >= dateEnd && p < dateEnd + filenameLen)
            .map(p => p - dateEnd),
    );

    return { titlePositions, authorPositions, publisherPositions, datePositions, filenamePositions };
}

function HighlightedText({ text, matchPositions }: { text: string; matchPositions: Set<number> }) {
    return convertMatchPositionsToHighlightSegments(text, matchPositions).map((part, i) =>
        part.matched
            ? <span key={i} className={styles.highlight}>{part.text}</span>
            : part.text,
    );
}

function ContentIndicators({ contentFiles }: { contentFiles: string[] }) {
    const hasPdf = contentFiles.includes('pdf');
    const hasHtml = contentFiles.includes('html');
    const formats = [
        hasPdf ? 'PDF' : null,
        hasHtml ? 'HTML' : null,
    ].filter(Boolean).join(', ');

    return (
        <span className={styles.contentIndicators} aria-label={`Available as ${formats}`}>
            {hasPdf && <FaFilePdf className={styles.pdfBadge} aria-hidden="true" />}
            {hasHtml && <Globe aria-hidden="true" />}
        </span>
    );
}

function tagChipStyle(colors: TagColors | undefined): CSSProperties | undefined {
    if (!colors) return undefined;

    return {
        color: colors.foreground ?? undefined,
        backgroundColor: colors.background ?? undefined,
    };
}

function TagChips({ tags, tagColors }: { tags: string[]; tagColors: Record<string, TagColors> }) {
    if (tags.length === 0) return null;

    return (
        <span className={styles.tagChips}>
            {tags.map(tag => (
                <span
                    className={styles.tag}
                    key={tag}
                    title={tag}
                    style={tagChipStyle(tagColors[tag])}
                >{tag}</span>
            ))}
        </span>
    );
}

interface PublicationTagsProps {
    publicationId: string;
    selected: boolean;
    editing: boolean;
    tags: string[];
    tagColors: Record<string, TagColors>;
    onAnchorChange: (publicationId: string, element: HTMLDivElement | null) => void;
    onOpen: (publicationId: string) => void;
}

interface TagEditorTarget {
    publicationId: string;
    anchor: HTMLDivElement;
}

interface TagEditorPosition {
    left: number;
    top: number;
}

interface FloatingTagEditorProps {
    anchor: HTMLDivElement;
    overlayContainer: HTMLDivElement;
    scrollContainer: HTMLDivElement;
    tagEditorText: string;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
    editorElementRef: (element: HTMLElement | null) => void;
    onClose: () => void;
    onTagEditorTextChange: (source: string) => void;
}

function useFloatingTagEditorPosition(
    anchor: HTMLDivElement,
    editorRef: RefObject<HTMLDivElement | null>,
    overlayContainer: HTMLDivElement,
    scrollContainer: HTMLDivElement,
) {
    const [position, setPosition] = useState<TagEditorPosition | null>(null);

    useLayoutEffect(() => {
        const editor = editorRef.current;
        if (!editor) return;

        const updatePosition = () => {
            const anchorRect = anchor.getBoundingClientRect();
            const containerRect = overlayContainer.getBoundingClientRect();
            const horizontalInset = 8;
            const minimumLeft = horizontalInset;
            const maximumLeft = overlayContainer.clientWidth - editor.offsetWidth - horizontalInset;
            const alignedLeft = anchorRect.right - containerRect.left
                - editor.offsetWidth;
            const left = Math.max(minimumLeft, Math.min(alignedLeft, maximumLeft));
            const top = anchorRect.top - containerRect.top
                + (anchorRect.height - editor.offsetHeight) / 2;

            setPosition(current => current?.left === left && current.top === top
                ? current
                : { left, top });
        };

        updatePosition();
        const resizeObserver = new ResizeObserver(updatePosition);
        resizeObserver.observe(anchor);
        resizeObserver.observe(editor);
        resizeObserver.observe(overlayContainer);
        resizeObserver.observe(scrollContainer);
        scrollContainer.addEventListener('scroll', updatePosition, { passive: true });
        window.addEventListener('resize', updatePosition);

        return () => {
            resizeObserver.disconnect();
            scrollContainer.removeEventListener('scroll', updatePosition);
            window.removeEventListener('resize', updatePosition);
        };
    }, [anchor, editorRef, overlayContainer, scrollContainer]);

    return position;
}

function scrollContainerByWheelEvent(
    scrollContainer: HTMLDivElement,
    event: React.WheelEvent<HTMLDivElement>,
) {
    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 22
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scrollContainer.clientHeight
            : 1;

    event.preventDefault();
    scrollContainer.scrollBy({
        left: event.deltaX * deltaScale,
        top: event.deltaY * deltaScale,
    });
}

function FloatingTagEditor({
    anchor,
    overlayContainer,
    scrollContainer,
    tagEditorText,
    editorMode,
    onEditorModeChange,
    editorElementRef,
    onClose,
    onTagEditorTextChange,
}: FloatingTagEditorProps) {
    const editorRef = useRef<HTMLDivElement>(null);
    const position = useFloatingTagEditorPosition(
        anchor,
        editorRef,
        overlayContainer,
        scrollContainer,
    );

    return createPortal(
        <div
            ref={editorRef}
            className={styles.floatingTagEditor}
            data-positioned={position !== null}
            style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
            onBlur={onClose}
            onKeyDown={event => event.stopPropagation()}
            onWheel={event => scrollContainerByWheelEvent(scrollContainer, event)}
        >
            <TextEditor
                value={tagEditorText}
                onChange={onTagEditorTextChange}
                mode={editorMode}
                onModeChange={onEditorModeChange}
                onLeaveRequest={onClose}
                editorElementRef={editorElementRef}
                singleLine={true}
            />
            <button
                type="button"
                className={styles.closeTagEditorButton}
                onMouseDown={event => event.preventDefault()}
                onClick={onClose}
            >
                <X />
                <span className={styles.closeTagEditorShortcut}>Esc</span>
            </button>
        </div>,
        overlayContainer,
    );
}

function PublicationTags({
    publicationId,
    selected,
    editing,
    tags,
    tagColors,
    onAnchorChange,
    onOpen,
}: PublicationTagsProps) {
    const shortcut = findKeybindingForAction(Action.FocusTagsEditor);
    const registerAnchor = useCallback(
        (element: HTMLDivElement | null) => onAnchorChange(publicationId, element),
        [publicationId, onAnchorChange],
    );

    const openEditor = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onOpen(publicationId);
    };

    return (
        <div
            className={styles.publicationTags}
            data-editing={editing}
            data-selected={selected}
        >
            <div ref={registerAnchor} className={styles.publicationTagsPlaceholder}>
                <button
                    type="button"
                    className={styles.tagEditButton}
                    onMouseDown={event => event.preventDefault()}
                    onClick={openEditor}
                >
                    <span className={styles.tagEditIcon}>
                        <Pencil />
                    </span>
                    <span className={styles.tagEditShortcut}>{shortcut}</span>
                </button>
                <TagChips tags={tags} tagColors={tagColors} />
            </div>
        </div>
    );
}

// Coordinates a single floating tag editor shared by all publication rows.
function useTagEditor(
    publications: PublicationListItem[],
    visiblePublicationIds: string[],
    selectedPublicationId: string,
    onSelectPublication: (publicationId: string) => void,
) {
    const {
        ref: registerEditorElement,
        requestFocus,
        releaseFocus,
    } = useFocusTarget();
    const anchors = useRef(new Map<string, HTMLDivElement>());
    const [tagEditorTarget, setTagEditorTarget] = useState<TagEditorTarget | null>(null);
    const [tagEditorText, setTagEditorText] = useState('');
    const visibleTagEditorTarget = tagEditorTarget
        && tagEditorTarget.publicationId === selectedPublicationId
        && visiblePublicationIds.includes(tagEditorTarget.publicationId)
        ? tagEditorTarget
        : null;

    const registerAnchor = useCallback((publicationId: string, element: HTMLDivElement | null) => {
        if (element) {
            anchors.current.set(publicationId, element);
        } else {
            anchors.current.delete(publicationId);
        }
    }, []);

    const close = useCallback(() => {
        setTagEditorTarget(null);
        releaseFocus();
    }, [releaseFocus]);

    const open = (publicationId: string) => {
        const publication = publications.find(candidate => candidate.id === publicationId);
        const anchor = anchors.current.get(publicationId);
        if (!publication || !anchor) return;

        onSelectPublication(publicationId);
        if (tagEditorTarget?.publicationId === publicationId) {
            requestFocus();
            return;
        }

        setTagEditorText(JSON.stringify(publication.tags));
        setTagEditorTarget({ publicationId, anchor });
        requestFocus();
    };

    useEffect(() => {
        if (!tagEditorTarget || visibleTagEditorTarget) return;

        close();
    }, [tagEditorTarget, visibleTagEditorTarget, close]);

    useActionHandler(
        Action.FocusTagsEditor,
        () => open(selectedPublicationId),
        selectedPublicationId !== '',
    );

    return {
        registerAnchor,
        registerEditorElement,
        tagEditorTarget: visibleTagEditorTarget,
        tagEditorText,
        setTagEditorText,
        open,
        close,
    };
}

function useFuzzyInputFocus(
    fuzzyFindVisible: boolean,
) {
    const inputRef = useRef<HTMLInputElement>(null);
    const focusTarget = useFocusTarget({ available: fuzzyFindVisible });
    const { ref: registerElement, requestFocus } = focusTarget;

    useLayoutEffect(() => {
        registerElement(inputRef.current);

        return () => registerElement(null);
    }, [registerElement, fuzzyFindVisible]);

    useLayoutEffect(() => {
        if (!fuzzyFindVisible) return;
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLInputElement
            || activeElement instanceof HTMLTextAreaElement
            || (activeElement instanceof HTMLElement && activeElement.isContentEditable)) return;

        requestFocus();
    }, [fuzzyFindVisible, requestFocus]);

    const onContainerMouseDown = (e: React.MouseEvent) => {
        if (fuzzyFindVisible && inputRef.current) {
            e.preventDefault();
            inputRef.current.focus();
        }
    };

    return { inputRef, onContainerMouseDown };
}

function useScrollToSelected(
    containerRef: RefObject<HTMLDivElement | null>,
    selectedPublicationId: string,
    displayedPublications: PublicationListItem[],
) {
    // The displayed list is a dependency on purpose: switching the selected
    // collection can change the list while leaving the selection id untouched,
    // and an unchanged id alone would never re-scroll the selection into view.
    useLayoutEffect(() => {
        containerRef.current
            ?.querySelector<HTMLElement>('[data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, [selectedPublicationId, displayedPublications]);
}

function useFuzzySearch(
    fuzzyFindVisible: boolean,
    publications: PublicationListItem[],
    onSelectPublication: (publicationId: string) => void,
    listRef: RefObject<HTMLDivElement | null>,
) {
    const [query, setQuery] = useState('');
    const [selectedIdx, setSelectedIdx] = useState(-1);
    // Incremented on each fuzzy-bar close to trigger a scroll effect that
    // fires reliably after the full list DOM has been committed.
    const [scrollVersion, setScrollVersion] = useState(0);

    const fzf = useMemo(
        () => new Fzf(publications, {
            selector: (pub: PublicationListItem) => pub.title + pub.author + pub.publisher + pub.date + pub.filename,
            match: extendedMatch,
        }),
        [publications],
    );

    const displayItems = query.length === 0
        ? publications.map(pub => ({
            pub,
            titlePositions: new Set<number>(),
            authorPositions: new Set<number>(),
            publisherPositions: new Set<number>(),
            datePositions: new Set<number>(),
            filenamePositions: new Set<number>(),
        }))
        : fzf.find(query).map(r => ({
            pub: r.item,
            ...splitMatchPositionsByField(r.positions, r.item.title.length, r.item.author.length, r.item.publisher.length, r.item.date.length, r.item.filename.length),
        }));

    const effectiveIdx = fuzzyFindVisible && displayItems.length > 0
        ? Math.min(selectedIdx, displayItems.length - 1)
        : -1;

    useEffect(() => {
        if (!fuzzyFindVisible) {
            // Sync the App-level selection to the currently highlighted
            // publication before clearing the filtered view. At this point
            // selectedIdx and displayItems still reflect the last fuzzy-find
            // state, so the ID we pick here is the one the user saw as selected.
            if (displayItems.length > 0) {
                const idx = Math.max(0, Math.min(selectedIdx, displayItems.length - 1));
                onSelectPublication(displayItems[idx].pub.id);
            }
            setSelectedIdx(-1);
            setQuery('');
            setScrollVersion(v => v + 1);
            return;
        }
        setSelectedIdx(0);
        if (publications.length > 0) {
            onSelectPublication(publications[0].id);
        }
        listRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, [fuzzyFindVisible]);

    useEffect(() => {
        if (!fuzzyFindVisible || displayItems.length === 0) return;
        const idx = Math.max(0, Math.min(selectedIdx, displayItems.length - 1));
        onSelectPublication(displayItems[idx].pub.id);
    }, [query]);

    useEffect(() => {
        if (!fuzzyFindVisible || displayItems.length === 0) return;
        const idx = Math.max(0, Math.min(selectedIdx, displayItems.length - 1));
        onSelectPublication(displayItems[idx].pub.id);
    }, [publications]);

    // After closing the fuzzy bar the full list is committed to the DOM
    // (query reset above triggers that render).  Scroll to the selected
    // publication once the new DOM is in place.
    useEffect(() => {
        if (scrollVersion === 0) return;
        listRef.current
            ?.querySelector<HTMLElement>('[data-selected="true"]')
            ?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }, [scrollVersion]);

    const navigate = (delta: number) => {
        if (displayItems.length === 0) return;
        const nextIdx = Math.max(0, Math.min(displayItems.length - 1, selectedIdx + delta));
        setSelectedIdx(nextIdx);
        onSelectPublication(displayItems[nextIdx].pub.id);
    };

    const selectByClick = (idx: number, publicationId: string) => {
        setSelectedIdx(idx);
        onSelectPublication(publicationId);
    };

    return { query, setQuery, displayItems, effectiveIdx, navigate, selectByClick };
}

function PublicationList({
    publications,
    selectedPublicationId,
    onSelectPublication,
    editorMode,
    onEditorModeChange,
}: PublicationListProps) {
    const publicationListRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [fuzzyFindVisible, setFuzzyFindVisible] = useState(false);
    const { opts: { tagColors } } = useConfig();

    useScrollToSelected(listRef, selectedPublicationId, publications);

    const { query, setQuery, displayItems, effectiveIdx, navigate, selectByClick } =
        useFuzzySearch(
            fuzzyFindVisible,
            publications,
            onSelectPublication,
            listRef,
        );
    const visiblePublicationIds = displayItems.map(({ pub }) => pub.id);
    const tagEditor = useTagEditor(
        publications,
        visiblePublicationIds,
        selectedPublicationId,
        onSelectPublication,
    );
    const { inputRef: fuzzyInputRef, onContainerMouseDown } =
        useFuzzyInputFocus(fuzzyFindVisible);

    // While the fuzzy bar is open the highlight moves within the filtered
    // view. Otherwise the selection moves through the full list.
    const selectAdjacentPublication = (delta: 1 | -1) => {
        if (fuzzyFindVisible) {
            navigate(delta);
            return;
        }

        if (publications.length === 0) return;
        const currentIdx = publications.findIndex(p => p.id === selectedPublicationId);
        const startIdx = currentIdx < 0 ? 0 : currentIdx;
        const nextIdx = (startIdx + delta + publications.length) % publications.length;
        onSelectPublication(publications[nextIdx].id);
    };

    const openSelectedPublication = () => {
        if (!selectedPublicationId) return;
        invoke('open_publication', { publicationId: selectedPublicationId })
            .catch(e => logger.error(String(e)));
    };

    useActionHandler(Action.SelectNext, () => selectAdjacentPublication(1));
    useActionHandler(Action.SelectPrev, () => selectAdjacentPublication(-1));
    useActionHandler(Action.Submit, openSelectedPublication);
    useActionHandler(Action.OpenFuzzyFind, () => setFuzzyFindVisible(true));
    // Escape is only claimed while the bar is actually open, so it stays free
    // for anything else when it is not.
    useActionHandler(Action.Cancel, () => setFuzzyFindVisible(false), fuzzyFindVisible);

    return (
        <div ref={publicationListRef} className={styles.publicationList}>
            {fuzzyFindVisible && (
                <div className={styles.fuzzyBar}>
                    <div className={styles.fuzzyField} onMouseDown={onContainerMouseDown}>
                        <span className={styles.fuzzyPrompt}>&gt;</span>
                        <input
                            ref={fuzzyInputRef}
                            className={styles.fuzzyInput}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            aria-label="Search publications"
                            placeholder="publisher · title · author · year"
                            onKeyDown={(e) => {
                                if (isTextProducingKey(e.nativeEvent)) e.stopPropagation();
                            }}
                            spellCheck={false}
                            autoComplete="off"
                        />
                    </div>
                    <button
                        type="button"
                        className={styles.closeSearchButton}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setFuzzyFindVisible(false)}
                        aria-label="Close publication search"
                    >
                        <X aria-hidden="true" />
                        <span className={styles.closeSearchShortcut}>Esc</span>
                    </button>
                </div>
            )}
            <div className={styles.listContainer} ref={listRef} onMouseDown={onContainerMouseDown}>
                <div className={styles.list}>
                    {displayItems.map(({ pub, titlePositions, authorPositions, publisherPositions: publisherPositions, datePositions, filenamePositions }, idx) => (
                        <div
                            key={pub.id}
                            className={styles.card}
                            data-selected={
                                fuzzyFindVisible
                                    ? (idx === effectiveIdx ? 'true' : 'false')
                                    : (selectedPublicationId === pub.id ? 'true' : 'false')
                            }
                            onClick={() => selectByClick(idx, pub.id)}
                        >
                            <div className={styles.cardBody}>
                                <div className={styles.cardTopRow}>
                                    <span className={styles.publisher}>
                                        <HighlightedText text={pub.publisher} matchPositions={publisherPositions} />
                                    </span>
                                    <div className={styles.dateBadge}>
                                        <PublicationTags
                                            publicationId={pub.id}
                                            selected={selectedPublicationId === pub.id}
                                            editing={tagEditor.tagEditorTarget?.publicationId === pub.id}
                                            tags={pub.tags}
                                            tagColors={tagColors}
                                            onAnchorChange={tagEditor.registerAnchor}
                                            onOpen={tagEditor.open}
                                        />
                                        <span className={styles.year}>
                                            <HighlightedText text={pub.date} matchPositions={datePositions} />
                                        </span>
                                    </div>
                                </div>
                                <span className={styles.cardTitle}>
                                    <HighlightedText text={pub.title} matchPositions={titlePositions} />
                                </span>
                                <div className={styles.cardBottomRow}>
                                    <span className={styles.author}>
                                        <HighlightedText text={pub.author} matchPositions={authorPositions} />
                                    </span>
                                    <span className={styles.filenameBadge}>
                                        <ContentIndicators contentFiles={pub.contentFiles} />
                                        <HighlightedText text={pub.filename} matchPositions={filenamePositions} />
                                    </span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            {tagEditor.tagEditorTarget && publicationListRef.current && listRef.current ? (
                <FloatingTagEditor
                    anchor={tagEditor.tagEditorTarget.anchor}
                    overlayContainer={publicationListRef.current}
                    scrollContainer={listRef.current}
                    tagEditorText={tagEditor.tagEditorText}
                    editorMode={editorMode}
                    onEditorModeChange={onEditorModeChange}
                    editorElementRef={tagEditor.registerEditorElement}
                    onClose={tagEditor.close}
                    onTagEditorTextChange={tagEditor.setTagEditorText}
                />
            ) : null}
        </div>
    );
}

export default PublicationList;
