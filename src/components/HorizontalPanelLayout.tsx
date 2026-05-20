import { PointerEvent as ReactPointerEvent, Fragment, ReactNode, RefObject, useRef, useState } from 'react';
import styles from './HorizontalPanelLayout.module.css';

interface DragData {
    separatorIdx: number;
    startX: number;
    startWidths: number[];
}

// TODO: Make this configurable
const MIN_PANEL_WIDTH = 0.1;

function computeNewWidths(
    startWidths: Array<number>, widthDiff: number, minWidth: number,
    dragIndex: number
) {
    let widths = [...startWidths];

    let diffBudget = widthDiff;

    if (widthDiff < 0) {
        let i = dragIndex;
        while (i >= 0 && diffBudget < 0) {
            const dWi = Math.max(diffBudget, minWidth - startWidths[i]);

            widths[i] = widths[i] + dWi;
            diffBudget -= dWi;

            i -= 1;
        }

        widths[dragIndex + 1] -= widthDiff - diffBudget;
    } else {
        let i = dragIndex + 1;
        while (i < widths.length && diffBudget >= 0) {
            const dWi = Math.min(diffBudget, startWidths[i] - minWidth);

            widths[i] = widths[i] - dWi;
            diffBudget -= dWi;

            i += 1;
        }

        widths[dragIndex] += widthDiff - diffBudget;
    }

    return widths;
}


function usePanelResize(
    panelLayoutRef: RefObject<HTMLDivElement | null>,
    panelWidthSetters: Array<(width: number) => void>
) {
    const [dragData, setDragData] = useState<DragData | null>(null);

    const onPointerDown =
        (e: ReactPointerEvent<HTMLDivElement>, separatorIdx: number) => {
            // Only consider left mouse button clicks
            if (e.button !== 0) return;

            const panelLayout = panelLayoutRef.current;
            if (!panelLayout) {
                console.error("No panel layout found");
                return;
            }

            const containerWidth = panelLayout.getBoundingClientRect().width;
            const panelElements = Array.from(
                panelLayout.querySelectorAll<HTMLElement>(`.${styles.panel}`)
            );
            const startWidths = panelElements.map(
                el => el.getBoundingClientRect().width / containerWidth);

            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();

            setDragData({
                separatorIdx: separatorIdx,
                startX: e.clientX,
                startWidths,
            });
        };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!dragData) return;

        const panelLayout = panelLayoutRef.current;
        if (!panelLayout) {
            console.error("No panel layout found");
            return;
        }

        const containerWidth = panelLayout.getBoundingClientRect().width;
        const dragDiffPercent = (e.clientX - dragData.startX) / containerWidth;

        const newWidths = computeNewWidths(
            dragData.startWidths, dragDiffPercent, MIN_PANEL_WIDTH, dragData.separatorIdx
        );

        for (let i = 0; i < newWidths.length; i++) {
            panelWidthSetters[i](newWidths[i]);
        }
    };

    const onPointerUp = () => { setDragData(null); };
    const onPointerCancel = () => { setDragData(null); };

    const getTriggerHandlers = (separatorIdx: number) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onPointerDown(e, separatorIdx),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    });

    const isDragging = (separatorIdx: number | null) => {
        if (separatorIdx === null) {
            return dragData != null;
        } else {
            return (dragData != null) && (separatorIdx == dragData.separatorIdx);
        }
    };

    return { getTriggerHandlers, isDragging };
}

interface PanelData {
    width: number,
    setWidth: (width: number) => void;
    renderContent: () => ReactNode;
}

interface HorizontalPanelLayoutProps {
    firstPanelsData: Array<PanelData>,
    renderLastPanelContent: () => ReactNode,
}

export default function HorizontalPanelLayout(
    { firstPanelsData, renderLastPanelContent }: HorizontalPanelLayoutProps
) {
    const panelLayoutRef = useRef<HTMLDivElement | null>(null);

    // Aditional empty handler for last panel
    const panelResizeHandlers
        = firstPanelsData.map((data) => data.setWidth).concat([() => { }]);

    const { getTriggerHandlers, isDragging }
        = usePanelResize(panelLayoutRef, panelResizeHandlers);

    return (
        <div
            className={`${styles.horizontalPanelLayout}
                ${isDragging(null) ? styles.isDragging : ''}`}
            ref={panelLayoutRef}
        >
            {firstPanelsData.map((data, index) => (
                <Fragment key={index}>
                    <div
                        className={styles.panel}
                        style={{ width: `${data.width * 100}%` }}
                    >
                        {data.renderContent()}
                    </div>
                    <div
                        className={`${styles.separator}
                            ${isDragging(index) ? styles.activeSeparator : ''}`}
                        {...getTriggerHandlers(index)}
                    ></div>
                </Fragment>
            ))}
            <div className={styles.panel}>
                {renderLastPanelContent()}
            </div>
        </div>
    );
}
