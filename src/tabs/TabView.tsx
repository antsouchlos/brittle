import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject, useCallback, useRef, useState, useEffect } from 'react';
import styles from './TabView.module.css';

export interface TabData {
    id: string;
    label: string;
    renderContent: () => ReactNode;
}

export interface TabViewProps {
    fixedTabs: Array<TabData>;
    variableTabs: Array<TabData>;
    selectedTabId: string;
    onSelectTab: (id: string) => void;
    onCloseTab: (id: string) => void;
    onReorderTabs: (fromIndex: number, toIndex: number) => void;
}

type Rect = { id: string; left: number; width: number };

type DragState = {
    id: string;
    startX: number;
    dX: number;
    fromIndex: number;
    toIndex: number;
    tabRects: Rect[];
    minX: number;
    maxX: number;
};

// TODO: Make this configurable
const DRAG_THRESHOLD_PX = 4;

// Tab bar gestures: drag-to-reorder and click-to-activate share the
// same pointerdown, so activation has to be deferred until we know which one
// the user meant.
//
// This function returns handlers to be called on various mouse events. It then
// calls the onSelect and onReorder callbacks accordingly.
export function useTabGestures(
    tabBarRef: RefObject<HTMLDivElement | null>,
    onSelect: (id: string) => void,
    onReorder: (fromIndex: number, toIndex: number) => void,
) {
    const [dragData, setDragData] = useState<DragState | null>(null);
    const isDraggingGesture = useRef(false);

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
        // Only consider left mouse button clicks
        if (e.button !== 0) return;

        // Discard clicks on the close button
        const target = e.target as HTMLElement;
        if (target.closest(`.${styles.tabCloseButton}`)) return;

        const tabBar = tabBarRef.current;
        if (!tabBar) {
            console.error("No tab bar found");
            return;
        };

        const tabElements = Array.from(
            tabBar.querySelectorAll<HTMLElement>(`.${styles.tabHeader}:not([data-tab-fixed])`)
        );
        const tabRects: Rect[] = tabElements.map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.tabId ?? '', left: r.left, width: r.width };
        });

        const fromIndex = tabRects.findIndex((r) => r.id === id);
        if (fromIndex < 0) {
            console.error("Unable to find tab that was clicked");
            return
        };

        isDraggingGesture.current = false;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();

        const lastTabRect = tabRects[tabRects.length - 1];
        setDragData({
            id,
            startX: e.clientX,
            dX: 0,
            fromIndex,
            toIndex: fromIndex,
            tabRects: tabRects,
            minX: tabRects[0].left,
            maxX: lastTabRect.left + lastTabRect.width,
        });
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        // When dragData is null, no tab is currently being dragged
        if (!dragData) return {};

        const draggedRect = dragData.tabRects[dragData.fromIndex];
        const maxDx = dragData.maxX - (draggedRect.left + draggedRect.width);
        const minDx = dragData.minX - draggedRect.left;

        const rawDx = e.clientX - dragData.startX;
        const dx = Math.max(minDx, Math.min(maxDx, rawDx));

        // Only if the mouse moves a certain amount do we want to register
        // a dragging gesture
        if (Math.abs(rawDx) > DRAG_THRESHOLD_PX) isDraggingGesture.current = true;

        const draggedElementMinX = draggedRect.left + dx;
        const draggedElementMaxX = draggedElementMinX + draggedRect.width;

        let toIndex = dragData.fromIndex;

        for (let i = dragData.fromIndex - 1; i >= 0; i--) {
            const mid = dragData.tabRects[i].left + dragData.tabRects[i].width / 2;
            if (draggedElementMinX < mid) toIndex = i;
            else break;
        }
        for (let i = dragData.fromIndex + 1; i < dragData.tabRects.length; i++) {
            const mid = dragData.tabRects[i].left + dragData.tabRects[i].width / 2;
            if (draggedElementMaxX > mid) toIndex = i;
            else break;
        }

        if (dx !== dragData.dX || toIndex !== dragData.toIndex) {
            setDragData({ ...dragData, dX: dx, toIndex });
        }
    };

    const endGesture = (commit: boolean, id: string) => {
        if (!dragData) {
            console.error("'dragData' is unset. This should never happen");
            return;
        };

        if (!commit) return;

        if (!isDraggingGesture.current) {
            onSelect(id);
        } else if (isDraggingGesture.current
            && dragData.toIndex !== dragData.fromIndex) {
            onReorder(dragData.fromIndex, dragData.toIndex);
        }

        isDraggingGesture.current = false;
        setDragData(null);
    };

    const onPointerUp = (_: ReactPointerEvent<HTMLDivElement>, id: string) => {
        // When dragData is null, no tab is currently being dragged
        if (!dragData) return {};

        endGesture(true, id);
    };

    const onPointerCancel = (_: ReactPointerEvent<HTMLDivElement>, id: string) => {
        // When dragData is null, no tab is currently being dragged
        if (!dragData) return {};

        endGesture(false, id);
    };

    const getTriggerHandlers = (id: string) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onPointerDown(e, id),
        onPointerMove,
        onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => onPointerUp(e, id),
        onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => onPointerCancel(e, id),
    });

    const getTriggerStyle = (id: string): CSSProperties => {
        // When dragData is null, no tab is currently being dragged
        if (!dragData) return {};

        // Element being dragged

        if (id === dragData.id) {
            return {
                transform: `translateX(${dragData.dX}px)`,
                zIndex: 2,
                position: 'relative',
            };
        }

        // Rest of the elements

        const index = dragData.tabRects.findIndex((r) => r.id === id);
        if (index < 0) {
            console.error("Unable to find tab that was clicked");
            return {};
        }

        const { fromIndex, toIndex } = dragData;
        const draggedElementWidth = dragData.tabRects[fromIndex].width;

        let shiftX = 0;
        if (fromIndex < toIndex && index > fromIndex && index <= toIndex) {
            shiftX = -draggedElementWidth;
        } else if (fromIndex > toIndex && index >= toIndex && index < fromIndex) {
            shiftX = draggedElementWidth;
        }

        return shiftX === 0
            ? { transition: 'transform 150ms ease' }
            : { transform: `translateX(${shiftX}px)`, transition: 'transform 150ms ease' };
    };

    const isDragging = (id: string) => (isDraggingGesture.current && dragData?.id === id);

    return { getTriggerHandlers, getTriggerStyle, isDragging };
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

export default function TabView({
    fixedTabs, variableTabs, selectedTabId, onSelectTab, onCloseTab, onReorderTabs
}: TabViewProps) {
    const { isVisited, markVisited, forgetVisited } = useVisitedTabs(selectedTabId);

    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const gestures = useTabGestures(tabBarRef, onSelectTab, onReorderTabs);

    useEffect(() => {
        markVisited(selectedTabId);
    }, [selectedTabId, markVisited]);

    return (
        <div className={styles.tabView}>
            <div
                className={styles.tabBar}
                ref={tabBarRef}
            >
                {fixedTabs.map((v) => {
                    return (
                        <div
                            key={v.id}
                            className={styles.tabHeader}
                            data-state={v.id == selectedTabId ? "active" : "inactive"}
                            data-tab-fixed={true}
                            onClick={() => { onSelectTab(v.id) }}
                        >
                            <span className={styles.tabLabel}>
                                {v.label}
                            </span>
                        </div>
                    );
                })}
                {variableTabs.map((v) => {
                    return (
                        <div
                            key={v.id}
                            className={styles.tabHeader}
                            data-state={v.id == selectedTabId ? "active" : "inactive"}
                            data-tab-id={v.id}
                            data-dragging={gestures.isDragging(v.id) || undefined}
                            style={gestures.getTriggerStyle(v.id)}
                            {...gestures.getTriggerHandlers(v.id)}
                        >
                            <span className={styles.tabLabel}>
                                {v.label}
                            </span>
                            <span
                                className={styles.tabCloseButton}
                                onClick={(e) => {
                                    onCloseTab(v.id);
                                    forgetVisited(v.id);
                                    e.stopPropagation();
                                    e.preventDefault();
                                }}
                            >x</span>
                        </div>
                    );
                })}
            </div>
            {variableTabs.concat(fixedTabs).map((tab) =>
                isVisited(tab.id) ? (
                    <div
                        key={tab.id}
                        className={styles.tabContent}
                        data-state={tab.id == selectedTabId ? "active" : "inactive"}
                    >
                        {tab.renderContent()}
                    </div>
                ) : null
            )}
        </div>
    );
}
