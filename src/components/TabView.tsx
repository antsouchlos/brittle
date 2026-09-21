import { createContext, CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject, useCallback, useContext, useRef, useState, useEffect } from 'react';
import styles from './TabView.module.css';
import { logger } from '../app/logger';
import { Action, ActionScope, useActionHandler } from '../app/actions';

const TabActiveContext = createContext(true);

export function useTabActive(): boolean {
    return useContext(TabActiveContext);
}

export interface TabData {
    id: string;
    label: string;
    renderContent: () => ReactNode;
}

export interface TabViewProps {
    fixedTabs: Array<TabData>;
    variableTabs: Array<TabData>;
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
            logger.error("No tab bar found");
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
            logger.error("Unable to find tab that was clicked");
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
            logger.error("'dragData' is unset. This should never happen");
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
            logger.error("Unable to find tab that was clicked");
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

// Tracks which tabs the user has actually visited, in first-visit order, so we
// can lazy-mount their content. A tab's content panel is only rendered once its
// id enters the list; closing a tab forgets it so reopening starts fresh.
//
// The order is preserved (rather than using a Set) so the content panels can be
// rendered in a DOM order independent of the tab bar order. Reordering the tab
// bar must not move the content `<div>`s in the DOM, otherwise embedded iframes
// (e.g. the PDF viewer) detach and reload from scratch.
function useVisitedTabs(initialId: string) {
    const [visitedOrder, setVisitedOrder] = useState<string[]>(() => [initialId]);

    const markVisited = useCallback((id: string) => {
        setVisitedOrder(prev => prev.includes(id) ? prev : [...prev, id]);
    }, []);
    const forgetVisited = useCallback((id: string) => {
        setVisitedOrder(prev => prev.includes(id) ? prev.filter(x => x !== id) : prev);
    }, []);

    return { visitedOrder, markVisited, forgetVisited };
}

export default function TabView({
    fixedTabs, variableTabs, onCloseTab, onReorderTabs
}: TabViewProps) {
    const [selectedTabId, setSelectedTabId] = useState(fixedTabs[0].id);
    const { visitedOrder, markVisited, forgetVisited } = useVisitedTabs(selectedTabId);

    const allTabs = fixedTabs.concat(variableTabs);
    const tabsById = new Map(allTabs.map(t => [t.id, t]));

    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const gestures = useTabGestures(tabBarRef, setSelectedTabId, onReorderTabs);

    useEffect(() => {
        markVisited(selectedTabId);
    }, [selectedTabId, markVisited]);

    const cycleTab = (delta: 1 | -1) => {
        const tabIds = allTabs.map(t => t.id);
        const currentIdx = tabIds.indexOf(selectedTabId);
        const nextIdx = (currentIdx + delta + tabIds.length) % tabIds.length;
        setSelectedTabId(tabIds[nextIdx]);
    };

    useActionHandler(Action.NextTab, () => cycleTab(1));
    useActionHandler(Action.PrevTab, () => cycleTab(-1));

    // Selects a neighbour when the tab being closed is the one in front.
    const closeTab = (id: string) => {
        forgetVisited(id);
        onCloseTab(id);

        if (id !== selectedTabId) return;

        const closedIdx = allTabs.findIndex(tab => tab.id === id);
        if (closedIdx < 0) {
            logger.error("Could not find closed tab id");
            return;
        }

        const neighbour = allTabs[closedIdx + 1] ?? allTabs[closedIdx - 1];
        if (neighbour) setSelectedTabId(neighbour.id);
    };

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
                            onClick={() => { setSelectedTabId(v.id) }}
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
                                    closeTab(v.id);
                                    e.stopPropagation();
                                    e.preventDefault();
                                }}
                            >x</span>
                        </div>
                    );
                })}
            </div>
            {
                // Display the tabs in the order they were visited. This
                // ensures the UI states of the contents persist even when
                // reordering the tabs
                visitedOrder.map((id) => {
                    const tab = tabsById.get(id);
                    if (!tab) {
                        logger.error("Visited tab not found");
                        return null
                    };
                    return (
                        <div
                            key={id}
                            className={styles.tabContent}
                            data-state={id == selectedTabId ? "active" : "inactive"}
                        >
                            <ActionScope active={id === selectedTabId}>
                                <TabActiveContext.Provider value={id === selectedTabId}>
                                    {tab.renderContent()}
                                </TabActiveContext.Provider>
                            </ActionScope>
                        </div>
                    );
                })
            }
        </div>
    );
}
