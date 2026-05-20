import { PointerEvent as ReactPointerEvent, Fragment, ReactNode, RefObject, useRef, useState } from 'react';
import styles from './HorizontalPanelLayout.module.css';

interface DragData {
    // Index of the panel on the left side of the separator being dragged
    panelIdx: number;
    startX: number;
    startWidths: number[];
}

// TODO: Make this configurable
const MIN_PANEL_WIDTH = 0.05;

function usePanelResize(
    panelLayoutRef: RefObject<HTMLDivElement | null>,
    panelWidthSetters: Array<(width: number) => void>
) {
    const [dragData, setDragData] = useState<DragData | null>(null);

    const onPointerDown =
        (e: ReactPointerEvent<HTMLDivElement>, panelIdx: number) => {
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
                panelIdx,
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
        let dragDiffPercent = (e.clientX - dragData.startX) / containerWidth;

        const i = dragData.panelIdx;
        dragDiffPercent = Math.max(
            MIN_PANEL_WIDTH - dragData.startWidths[i],
            Math.min(
                dragData.startWidths[i + 1] - MIN_PANEL_WIDTH,
                dragDiffPercent
            )
        );

        panelWidthSetters[i](dragData.startWidths[i] + dragDiffPercent);
        panelWidthSetters[i + 1](dragData.startWidths[i + 1] - dragDiffPercent);
    };

    const onPointerUp = () => { setDragData(null); };
    const onPointerCancel = () => { setDragData(null); };

    const getTriggerHandlers = (panelIdx: number) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onPointerDown(e, panelIdx),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    });

    const isDragging = () => (dragData != null);

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
                ${isDragging() ? styles.isDragging : ''}`}
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
                        className={styles.separator}
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
