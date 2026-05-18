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

const DRAG_THRESHOLD_PX = 4;

interface TabGestureCallbacks {
    onActivate: (id: string) => void;
    onReorder: (fromIndex: number, toIndex: number) => void;
}

// Tab strip pointer gestures: drag-to-reorder and click-to-activate share the
// same pointerdown, so activation has to be deferred until we know which one
// the user meant. Radix raises `onValueChange` on mousedown; we route it
// through `onValueChange` here, stash it as pending while a pointer gesture
// is in progress, and on pointerup commit it as an activation (no movement)
// or discard it in favor of a reorder (movement past the drag threshold).
// Keyboard/Enter/Space activations skip the deferral because no pointer
// gesture is active when they fire.
function useTabGestures(
    listRef: RefObject<HTMLDivElement | null>,
    { onActivate, onReorder }: TabGestureCallbacks,
) {
    const [drag, setDrag] = useState<DragState | null>(null);
    const gestureRef = useRef({
        active: false,
        moved: false,
        pendingActivation: null as string | null,
    });

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

        gestureRef.current = { active: true, moved: false, pendingActivation: null };
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
        if (Math.abs(rawDx) > DRAG_THRESHOLD_PX) gestureRef.current.moved = true;
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

    const endGesture = (commit: boolean) => {
        if (!drag) return;
        const { moved, pendingActivation } = gestureRef.current;
        if (commit && moved && drag.toIndex !== drag.fromIndex) {
            onReorder(drag.fromIndex, drag.toIndex);
        }
        if (commit && !moved && pendingActivation !== null) {
            onActivate(pendingActivation);
        }
        gestureRef.current = { active: false, moved: false, pendingActivation: null };
        setDrag(null);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        endGesture(true);
    };

    const onPointerCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        endGesture(false);
    };

    const getTriggerHandlers = (id: string) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => onPointerDown(e, id),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    });

    const onValueChange = (id: string) => {
        if (gestureRef.current.active) {
            gestureRef.current.pendingActivation = id;
        } else {
            onActivate(id);
        }
    };

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

    return { getTriggerHandlers, getTriggerStyle, isDragging, onValueChange };
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

    const activate = useCallback((id: string) => {
        setActiveTabId(id);
        markVisited(id);
    }, [markVisited]);

    const gestures = useTabGestures(listRef, { onActivate: activate, onReorder: onReorderTabs });

    const closeTab = useCallback((closingId: string) => {
        onCloseTab(closingId);
        forgetVisited(closingId);
        if (activeTabId === closingId) {
            const closingIndex = tabs.findIndex(t => t.id === closingId);
            const nextTab = tabs[closingIndex + 1] ?? tabs[closingIndex - 1];
            if (nextTab) activate(nextTab.id);
        }
    }, [activeTabId, tabs, onCloseTab, forgetVisited, activate]);

    return (
        <Tabs.Root
            className={styles.root}
            value={activeTabId}
            onValueChange={gestures.onValueChange}
        >
            <Tabs.List className={styles.list} ref={listRef}>
                {tabs.map((t, idx) => (
                    <Tabs.Trigger
                        key={t.id}
                        value={t.id}
                        data-tab-id={t.id}
                        data-dragging={gestures.isDragging(t.id) || undefined}
                        style={gestures.getTriggerStyle(t.id, idx)}
                        {...gestures.getTriggerHandlers(t.id)}
                    >
                        <span className={styles.tabLabel}>{t.label}</span>
                        {t.closeable && (
                            <span
                                className={styles.tabClose}
                                role="button"
                                tabIndex={0}
                                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
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
