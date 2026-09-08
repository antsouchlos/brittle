import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Fzf, extendedMatch } from 'fzf';
import { FaFilePdf } from 'react-icons/fa';
import { Globe } from 'lucide-react';
import styles from './PublicationList.module.css';

interface Publication {
    pathStem: string;
    title: string;
    author: string;
    publisher: string;
    date: string;
    filename: string;
    contentFiles: string[];
}

interface PublicationListProps {
    publications: Array<Publication>
    selectedPublicationPathStem: string;
    onSelectPublication: (pathStem: string) => void;
    fuzzyFindVisible: boolean;
    isActive: boolean;
    publicationNavRequest: { delta: 1 | -1 } | null;
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

function isTextProducingKey(event: KeyboardEvent): boolean {
    if (event.isComposing) return true;
    const key = event.key;
    if (key.length === 1 && !event.metaKey && !(event.ctrlKey && !event.altKey)) return true;
    if (key === 'Backspace' || key === 'Delete' || key === 'Home' || key === 'End') return true;
    if (key.startsWith('Arrow')) return true;
    const mod = event.ctrlKey || event.metaKey;
    return mod && (key === 'a' || key === 'c' || key === 'v' || key === 'x');
}

function useFuzzyInputFocus(
    fuzzyFindVisible: boolean,
    isActive: boolean,
): {
    inputRef: RefObject<HTMLInputElement | null>;
    onContainerMouseDown: (e: React.MouseEvent) => void;
} {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!fuzzyFindVisible || !inputRef.current) return;
        if (isActive) {
            inputRef.current.focus();
        } else {
            inputRef.current.blur();
        }
    }, [isActive, fuzzyFindVisible]);

    // The fuzzy bar is the default key owner while it is open: whenever DOM
    // focus lands outside it and outside another editable surface (the bib
    // editor, the command line), pull focus back into the input. This covers
    // releases the other hook cannot see, like the bib editor blurring after
    // 'Escape' or a pointer click on a collection or list card.
    useEffect(() => {
        if (!fuzzyFindVisible || !isActive) return;

        const refocusIfUnclaimed = (event: FocusEvent) => {
            const input = inputRef.current;
            if (!input || !input.isConnected || input.offsetParent === null) return;

            const nextTarget = event.relatedTarget as HTMLElement | null;
            const focusOnOtherTextArea = nextTarget instanceof HTMLElement
                && nextTarget !== input
                && (nextTarget instanceof HTMLInputElement
                    || nextTarget instanceof HTMLTextAreaElement
                    || nextTarget.isContentEditable);
            if (focusOnOtherTextArea) return;

            // Defer a frame so the refocus never fights the click or a tab
            // switch that blurred the input in the first place.
            requestAnimationFrame(() => {
                if (input.isConnected && document.activeElement !== input) {
                    input.focus();
                }
            });
        };

        document.addEventListener('focusout', refocusIfUnclaimed);
        return () => document.removeEventListener('focusout', refocusIfUnclaimed);
    }, [fuzzyFindVisible, isActive]);

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
    selectedPathStem: string,
    displayedPublications: Publication[],
) {
    // The displayed list is a dependency on purpose: switching the selected
    // collection can change the list while leaving the selection id untouched,
    // and an unchanged id alone would never re-scroll the selection into view.
    useLayoutEffect(() => {
        containerRef.current
            ?.querySelector<HTMLElement>('[data-selected="true"]')
            ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }, [selectedPathStem, displayedPublications]);
}

function usePublicationNavigation(
    fuzzyFindVisible: boolean,
    navigateFuzzyList: (delta: number) => void,
    publications: Publication[],
    selectedPublicationPathStem: string,
    onSelectPublication: (pathStem: string) => void,
    publicationNavRequest: { delta: 1 | -1 } | null,
) {
    useEffect(() => {
        if (publicationNavRequest === null) return;
        const delta = publicationNavRequest.delta;

        if (fuzzyFindVisible) {
            navigateFuzzyList(delta);
            return;
        } else {
            if (publications.length === 0) return;
            const currentIdx = publications.findIndex(p => p.pathStem === selectedPublicationPathStem);
            const startIdx = currentIdx < 0 ? 0 : currentIdx;
            const nextIdx = (startIdx + delta + publications.length) % publications.length;
            onSelectPublication(publications[nextIdx].pathStem);
        }
    }, [publicationNavRequest]);
}

function useFuzzySearch(
    fuzzyFindVisible: boolean,
    publications: Publication[],
    onSelectPublication: (pathStem: string) => void,
    listRef: RefObject<HTMLDivElement | null>,
) {
    const [query, setQuery] = useState('');
    const [selectedIdx, setSelectedIdx] = useState(-1);
    // Incremented on each fuzzy-bar close to trigger a scroll effect that
    // fires reliably after the full list DOM has been committed.
    const [scrollVersion, setScrollVersion] = useState(0);

    const fzf = useMemo(
        () => new Fzf(publications, {
            selector: (pub: Publication) => pub.title + pub.author + pub.publisher + pub.date + pub.filename,
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
                onSelectPublication(displayItems[idx].pub.pathStem);
            }
            setSelectedIdx(-1);
            setQuery('');
            setScrollVersion(v => v + 1);
            return;
        }
        setSelectedIdx(0);
        if (publications.length > 0) {
            onSelectPublication(publications[0].pathStem);
        }
        listRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    }, [fuzzyFindVisible]);

    useEffect(() => {
        if (!fuzzyFindVisible || displayItems.length === 0) return;
        const idx = Math.max(0, Math.min(selectedIdx, displayItems.length - 1));
        onSelectPublication(displayItems[idx].pub.pathStem);
    }, [query]);

    useEffect(() => {
        if (!fuzzyFindVisible || displayItems.length === 0) return;
        const idx = Math.max(0, Math.min(selectedIdx, displayItems.length - 1));
        onSelectPublication(displayItems[idx].pub.pathStem);
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
        onSelectPublication(displayItems[nextIdx].pub.pathStem);
    };

    const selectByClick = (idx: number, pathStem: string) => {
        setSelectedIdx(idx);
        onSelectPublication(pathStem);
    };

    return { query, setQuery, displayItems, effectiveIdx, navigate, selectByClick };
}

function PublicationList({
    publications,
    selectedPublicationPathStem,
    onSelectPublication,
    fuzzyFindVisible,
    isActive,
    publicationNavRequest,
}: PublicationListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    useScrollToSelected(listRef, selectedPublicationPathStem, publications);

    const { query, setQuery, displayItems, effectiveIdx, navigate, selectByClick } =
        useFuzzySearch(
            fuzzyFindVisible,
            publications,
            onSelectPublication,
            listRef,
        );
    const { inputRef: fuzzyInputRef, onContainerMouseDown } =
        useFuzzyInputFocus(fuzzyFindVisible, isActive);

    usePublicationNavigation(
        fuzzyFindVisible,
        navigate,
        publications,
        selectedPublicationPathStem,
        onSelectPublication,
        publicationNavRequest,
    );

    return (
        <div className={styles.publicationList}
            onMouseDown={onContainerMouseDown}
        >
            {fuzzyFindVisible && (
                <div className={styles.fuzzyBar}>
                    <span className={styles.fuzzyPrompt}>&gt;</span>
                    <input
                        ref={fuzzyInputRef}
                        className={styles.fuzzyInput}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="publisher · title · author · year"
                        onKeyDown={(e) => {
                            if (isTextProducingKey(e.nativeEvent)) e.stopPropagation();
                        }}
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>
            )}
            <div className={styles.listContainer} ref={listRef}>
                <div className={styles.list}>
                    {displayItems.map(({ pub, titlePositions, authorPositions, publisherPositions: publisherPositions, datePositions, filenamePositions }, idx) => (
                        <div
                            key={pub.pathStem}
                            className={styles.card}
                            data-selected={
                                fuzzyFindVisible
                                    ? (idx === effectiveIdx ? 'true' : 'false')
                                    : (selectedPublicationPathStem === pub.pathStem ? 'true' : 'false')
                            }
                            onClick={() => selectByClick(idx, pub.pathStem)}
                        >
                            <div className={styles.cardTopRow}>
                                <span className={styles.publisher}>
                                    <HighlightedText text={pub.publisher} matchPositions={publisherPositions} />
                                </span>
                                <span className={styles.dateBadge}>
                                    <ContentIndicators contentFiles={pub.contentFiles} />
                                    <HighlightedText text={pub.date} matchPositions={datePositions} />
                                </span>
                            </div>
                            <span className={styles.cardTitle}>
                                <HighlightedText text={pub.title} matchPositions={titlePositions} />
                            </span>
                            <div className={styles.cardBottomRow}>
                                <span className={styles.author}>
                                    <HighlightedText text={pub.author} matchPositions={authorPositions} />
                                </span>
                                <span className={styles.filenameBadge}>
                                    <HighlightedText text={pub.filename} matchPositions={filenamePositions} />
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default PublicationList;
