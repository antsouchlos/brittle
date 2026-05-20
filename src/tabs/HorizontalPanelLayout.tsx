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
        const dragDiffPercent = (e.clientX - dragData.startX) / containerWidth;

        const i = dragData.panelIdx;
        const newWidths = [...dragData.startWidths];
        newWidths[i] = dragData.startWidths[i] + dragDiffPercent;
        newWidths[i + 1] = dragData.startWidths[i + 1] - dragDiffPercent;

        // Clamp to minimum width and keep total of the two panels constant
        const total = newWidths[i] + newWidths[i + 1];
        let left = Math.max(MIN_PANEL_WIDTH, newWidths[i]);
        let right = Math.max(MIN_PANEL_WIDTH, newWidths[i + 1]);
        // If clamping pushed one side over the total, readjust the other side
        if (left + right > total) {
            const overflow = left + right - total;
            if (left > right) {
                left -= overflow;
            } else {
                right -= overflow;
            }
        }
        newWidths[i] = left;
        newWidths[i + 1] = right;

        // Apply the new fractions to the panels that have setters (all but the implicit last panel)
        for (let idx = 0; idx < panelWidthSetters.length; idx++) {
            panelWidthSetters[idx](newWidths[idx]);
        }
    };

    // TODO: Do we need these?

    const onPointerUp = () => { setDragData(null); };
    const onPointerCancel = () => { setDragData(null); };

    const getTriggerHandlers = (panelIdx: number) => ({
        onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => onPointerDown(e, panelIdx),
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    });

    return { getTriggerHandlers };
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
    const { getTriggerHandlers }
        = usePanelResize(panelLayoutRef,
            firstPanelsData.map((data) => data.setWidth));

    return (
        <div
            className={styles.horizontalPanelLayout}
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
