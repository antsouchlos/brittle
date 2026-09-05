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
    onCloseFuzzyFind: () => void;
    onSubmit?: () => void;
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
    onCloseFuzzyFind,
    onSubmit,
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
                            if (e.key === 'Enter') {
                                onSubmit?.();
                            } else if (e.key === 'Escape') {
                                onCloseFuzzyFind();
                            } else if ((e.key === 'n' && e.ctrlKey) || (e.key === 'p' && e.ctrlKey)) {
                                navigate(e.key === 'n' ? 1 : -1);
                            } else if (e.key === 'Tab') {
                                e.preventDefault();
                                navigate(e.shiftKey ? -1 : 1);
                            }
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
