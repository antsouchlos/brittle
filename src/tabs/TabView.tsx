import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject, useCallback, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import styles from './TabView.module.css';

interface TabData {
    id: string;
    label: string;
    closeable: boolean;
    content: ReactNode;
}

interface TabViewProps {
    tabs: Array<TabData>;
    onCloseTab: (id: string) => void;
    onReorderTabs: (fromIndex: number, toIndex: number) => void;
}

// Tracks which tabs the user has actually visited so we can lazy-mount their
// content. A tab's `<Tabs.Content>` is only rendered once its id enters the
// visited set; closing a tab forgets it so reopening starts fresh.
function useVisitedTabs(initialId: string) {
    const [visited, setVisited] = useState<Set<string>>(() => new Set([initialId]));

    const isVisited = useCallback((id: string) => visited.has(id), [visited]);
    const markVisited = useCallback((id: string) => {
        setVisited(prev => prev.has(id) ? prev : new Set(prev).add(id));
    }, []);
    const forgetVisited = useCallback((id: string) => {
        setVisited(prev => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    }, []);

    return { isVisited, markVisited, forgetVisited };
}

interface DragState {
    id: string;
    pointerId: number;
    startX: number;
    fromIndex: number;
    toIndex: number;
    dx: number;
    rects: Array<{ id: string; left: number; width: number }>;
    listLeft: number;
    listRight: number;
}

// Implements pointer-driven drag-to-reorder for the tab strip. Snapshots
// trigger rects on pointerdown, slides the dragged tab via inline transform,
// shifts siblings to open a gap, and calls `onReorder` on release. Returns
// per-trigger handlers and an inline style fn the renderer spreads onto each.
function useTabDrag(
    listRef: RefObject<HTMLDivElement | null>,
    onReorder: (fromIndex: number, toIndex: number) => void,
) {
    const [drag, setDrag] = useState<DragState | null>(null);

    const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest(`.${styles.tabClose}`)) return;
        const list = listRef.current;
        if (!list) return;

        const triggers = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
        const rects = triggers.map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.tabId ?? '', left: r.left, width: r.width };
        });
        const fromIndex = rects.findIndex(r => r.id === id);
        if (fromIndex < 0) return;
        const last = rects[rects.length - 1];

        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({
            id,
            pointerId: e.pointerId,
            startX: e.clientX,
            fromIndex,
            toIndex: fromIndex,
            dx: 0,
            rects,
            listLeft: rects[0].left,
            listRight: last.left + last.width,
        });
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        const draggedRect = drag.rects[drag.fromIndex];
        const maxDx = drag.listRight - (draggedRect.left + draggedRect.width);
        const minDx = drag.listLeft - draggedRect.left;
        const rawDx = e.clientX - drag.startX;
        const dx = Math.max(minDx, Math.min(maxDx, rawDx));
        const draggedLeft = draggedRect.left + dx;
        const draggedRight = draggedLeft + draggedRect.width;

        let toIndex = drag.fromIndex;
        for (let i = drag.fromIndex - 1; i >= 0; i--) {
            const mid = drag.rects[i].left + drag.rects[i].width / 2;
            if (draggedLeft < mid) toIndex = i;
            else break;
        }
        for (let i = drag.fromIndex + 1; i < drag.rects.length; i++) {
            const mid = drag.rects[i].left + drag.rects[i].width / 2;
            if (draggedRight > mid) toIndex = i;
            else break;
        }

        if (dx !== drag.dx || toIndex !== drag.toIndex) {
            setDrag({ ...drag, dx, toIndex });
        }
    };

    const finishDrag = (commit: boolean) => {
        if (!drag) return;
        if (commit && drag.toIndex !== drag.fromIndex) {
            onReorder(drag.fromIndex, drag.toIndex);
        }
        setDrag(null);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        finishDrag(true);
    };

    const onPointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        finishDrag(false);
    };

    const getTriggerHandlers = (id: string) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => onPointerDown(e, id),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    });

    const getTriggerStyle = (id: string, index: number): CSSProperties => {
        if (!drag) return {};
        if (id === drag.id) {
            return {
                transform: `translateX(${drag.dx}px)`,
                transition: 'none',
                zIndex: 2,
                position: 'relative',
            };
        }
        const { fromIndex, toIndex } = drag;
        const draggedWidth = drag.rects[fromIndex].width;
        let shift = 0;
        if (fromIndex < toIndex && index > fromIndex && index <= toIndex) {
            shift = -draggedWidth;
        } else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) {
            shift = draggedWidth;
        }
        return shift === 0
            ? { transition: 'transform 150ms ease' }
            : { transform: `translateX(${shift}px)`, transition: 'transform 150ms ease' };
    };

    const isDragging = (id: string) => drag?.id === id;

    return { getTriggerHandlers, getTriggerStyle, isDragging };
}

// Tab strip + content area built on Radix Tabs. The `tabs` array is the
// single source of truth for both contents and order; the parent owns it
// and handles closes/reorders via the callback props. Tab content is
// lazy-mounted on first visit and kept mounted thereafter, so switching
// tabs preserves per-tab state (scroll position, viewer state, etc.).
function TabView({ tabs, onCloseTab, onReorderTabs }: TabViewProps) {
    const [activeTabId, setActiveTabId] = useState(tabs[0].id);
    const { isVisited, markVisited, forgetVisited } = useVisitedTabs(tabs[0].id);
    const listRef = useRef<HTMLDivElement | null>(null);
    const drag = useTabDrag(listRef, onReorderTabs);

    const closeTab = useCallback((closingId: string) => {
        onCloseTab(closingId);
        forgetVisited(closingId);
        if (activeTabId === closingId) {
            const closingIndex = tabs.findIndex(t => t.id === closingId);
            const nextTab = tabs[closingIndex + 1] ?? tabs[closingIndex - 1];
            if (!nextTab) return;
            setActiveTabId(nextTab.id);
            markVisited(nextTab.id);
        }
    }, [activeTabId, tabs, onCloseTab, forgetVisited, markVisited]);

    return (
        <Tabs.Root
            className={styles.root}
            value={activeTabId}
            onValueChange={(v) => { setActiveTabId(v); markVisited(v); }}
        >
            <Tabs.List className={styles.list} ref={listRef}>
                {tabs.map((t, idx) => (
                    <Tabs.Trigger
                        key={t.id}
                        value={t.id}
                        data-tab-id={t.id}
                        data-dragging={drag.isDragging(t.id) || undefined}
                        style={drag.getTriggerStyle(t.id, idx)}
                        {...drag.getTriggerHandlers(t.id)}
                    >
                        <span className={styles.tabLabel}>{t.label}</span>
                        {t.closeable && (
                            <span
                                className={styles.tabClose}
                                role="button"
                                tabIndex={0}
                                onPointerDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    closeTab(t.id);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.stopPropagation();
                                        closeTab(t.id);
                                    }
                                }}
                                aria-label={`Close ${t.label}`}
                            >×</span>
                        )}
                    </Tabs.Trigger>
                ))}
            </Tabs.List>
            {tabs.map((t) =>
                isVisited(t.id) ? (
                    <Tabs.Content className={styles.content} key={t.id} value={t.id} forceMount>
                        {t.content}
                    </Tabs.Content>
                ) : null
            )}
        </Tabs.Root>
    );
}

export default TabView;
