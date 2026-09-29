import { PointerEvent as ReactPointerEvent, Fragment, ReactNode, RefObject, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import styles from './HorizontalPanelLayout.module.css';
import { logger } from '../app/logger';
import { useRestoredState } from '../app/uiState';

type CollapseSide = 'left' | 'right';

interface CollapsedOuterPanels {
    first: boolean;
    last: boolean;
}

interface ArmableCollapseSides {
    left: boolean;
    right: boolean;
}

interface DragData {
    separatorIdx: number;
    startX: number;
    startWidths: number[];
}

// TODO: Make this configurable
const MIN_PANEL_WIDTH = 0.15;

const COLLAPSE_BAND_WIDTH_PX = 16;

const NO_ARMABLE_SIDES: ArmableCollapseSides = { left: false, right: false };

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

function replaceVisibleWidths(
    widths: Array<number>, dragWidths: Array<number>, visiblePanelIndices: Array<number>
) {
    const updated = [...widths];
    visiblePanelIndices.forEach((panelIndex, visibleIndex) => {
        updated[panelIndex] = dragWidths[visibleIndex];
    });

    return updated;
}

// The bases sum to 100%, so the line overflows by the separators and the
// collapse band, which only the panels that are not pinned shrink to absorb.
function computePanelFlex(weights: Array<number>, minWidth: number) {
    const shares = [...weights];
    const pinned = shares.map(() => false);

    for (let pass = 0; pass < shares.length; pass += 1) {
        const pinnedTotal = shares.reduce(
            (total, share, i) => pinned[i] ? total + share : total, 0);
        const flexibleTotal = shares.reduce(
            (total, share, i) => pinned[i] ? total : total + share, 0);
        const scale = (1 - pinnedTotal) / flexibleTotal;

        const tooNarrow = shares.findIndex((share, i) => !pinned[i] && share * scale < minWidth);
        if (tooNarrow === -1) {
            return shares.map((share, i) => ({
                flexBasis: `${(pinned[i] ? share : share * scale) * 100}%`,
                flexShrink: pinned[i] ? 0 : 1,
            }));
        }

        shares[tooNarrow] = minWidth;
        pinned[tooNarrow] = true;
    }

    return shares.map(share => ({ flexBasis: `${share * 100}%`, flexShrink: 0 }));
}

function findArmableCollapseSides(
    visiblePanelIndices: Array<number>, panelCount: number, separatorIdx: number
): ArmableCollapseSides {
    return {
        left: separatorIdx === 0 && visiblePanelIndices[0] === 0,
        right: separatorIdx === visiblePanelIndices.length - 2
            && visiblePanelIndices[separatorIdx + 1] === panelCount - 1,
    };
}

function findArmedCollapseSide(
    armableSides: ArmableCollapseSides, layoutRect: DOMRect, pointerX: number
): CollapseSide | null {
    if (armableSides.left && pointerX - layoutRect.left < COLLAPSE_BAND_WIDTH_PX) return 'left';
    if (armableSides.right && layoutRect.right - pointerX < COLLAPSE_BAND_WIDTH_PX) return 'right';

    return null;
}

function usePanelResize(
    panelLayoutRef: RefObject<HTMLDivElement | null>,
    visiblePanelIndices: Array<number>,
    panelCount: number,
    setWidths: (widths: (previous: Array<number>) => Array<number>) => void,
    collapsePanel: (side: CollapseSide) => void,
) {
    const [dragData, setDragData] = useState<DragData | null>(null);
    const [dragWidths, setDragWidths] = useState<Array<number> | null>(null);
    const [armedCollapseSide, setArmedCollapseSide] = useState<CollapseSide | null>(null);

    const armableCollapseSides = dragData
        ? findArmableCollapseSides(visiblePanelIndices, panelCount, dragData.separatorIdx)
        : NO_ARMABLE_SIDES;

    const onPointerDown =
        (e: ReactPointerEvent<HTMLDivElement>, separatorIdx: number) => {
            if (e.button !== 0) return;

            const panelLayout = panelLayoutRef.current;
            if (!panelLayout) {
                logger.error("No panel layout found");
                return;
            }

            const containerWidth = panelLayout.getBoundingClientRect().width;
            const panelElements = Array.from(
                panelLayout.querySelectorAll<HTMLElement>(
                    `.${styles.panel}:not(.${styles.hiddenPanel})`)
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
            logger.error("No panel layout found");
            return;
        }

        const layoutRect = panelLayout.getBoundingClientRect();
        const dragDiffPercent = (e.clientX - dragData.startX) / layoutRect.width;

        const newWidths = computeNewWidths(
            dragData.startWidths, dragDiffPercent, MIN_PANEL_WIDTH, dragData.separatorIdx
        );

        setDragWidths(newWidths);
        setArmedCollapseSide(findArmedCollapseSide(armableCollapseSides, layoutRect, e.clientX));
    };

    const onPointerUp = () => {
        if (armedCollapseSide) {
            collapsePanel(armedCollapseSide);
        } else if (dragWidths) {
            setWidths(previous =>
                replaceVisibleWidths(previous, dragWidths, visiblePanelIndices));
        }

        setDragWidths(null);
        setArmedCollapseSide(null);
        setDragData(null);
    };

    const onPointerCancel = () => {
        setDragWidths(null);
        setArmedCollapseSide(null);
        setDragData(null);
    };

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

    return { getTriggerHandlers, isDragging, dragWidths, armableCollapseSides, armedCollapseSide };
}

// The separator holds the pointer capture for the whole drag, so this band is
// told whether it is hit rather than tracking the pointer itself.
function CollapseDropZone({ side, armed }: { side: CollapseSide, armed: boolean }) {
    return (
        <div
            className={`${styles.collapseBand} ${styles.collapseDropZone}
                ${side === 'left' ? styles.leftEdge : styles.rightEdge}
                ${armed ? styles.armedDropZone : ''}`}
            style={{ width: COLLAPSE_BAND_WIDTH_PX }}
        >
            {armed && (side === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />)}
        </div>
    );
}

function CollapsedPanelHandle(
    { side, label, onExpand }: {
        side: CollapseSide, label?: string, onExpand: (side: CollapseSide) => void
    }
) {
    return (
        <button
            type="button"
            className={`${styles.collapseBand} ${styles.collapsedPanelHandle}`}
            style={{ width: COLLAPSE_BAND_WIDTH_PX }}
            aria-label={label ?? (side === 'left' ? 'Show left panel' : 'Show right panel')}
            onClick={() => onExpand(side)}
        >
            {label && <span className={styles.collapsedPanelLabel}>{label}</span>}
            {side === 'left' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
    );
}

interface PanelData {
    renderContent: () => ReactNode;
    // Hiding a collapsed panel rather than unmounting it keeps the keymap
    // actions it claims alive. Only the outer panels can be collapsed at all.
    collapsedBehaviour?: 'unmount' | 'hide';
    // Shown on the band the panel leaves behind while collapsed.
    collapsedLabel?: string;
}

interface HorizontalPanelLayoutProps {
    panelsData: Array<PanelData>,
    // Relative weights, one per panel; only the ratios between them matter.
    defaultWidths: Array<number>,
    widthsPersistKey: string,
    collapsePersistKey: string,
}

export default function HorizontalPanelLayout(
    { panelsData, defaultWidths, widthsPersistKey, collapsePersistKey }: HorizontalPanelLayoutProps
) {
    const panelLayoutRef = useRef<HTMLDivElement | null>(null);
    const [widths, setWidths] = useRestoredState(widthsPersistKey, defaultWidths);
    const [collapsedPanels, setCollapsedPanels] = useRestoredState<CollapsedOuterPanels>(
        collapsePersistKey, { first: false, last: false }
    );

    const panelCount = panelsData.length;
    const panelIndices = Array.from({ length: panelCount }, (_, index) => index);
    const visiblePanelIndices = panelIndices
        .filter(index => !(index === 0 && collapsedPanels.first))
        .filter(index => !(index === panelCount - 1 && collapsedPanels.last));

    const setPanelCollapsed = (side: CollapseSide, collapsed: boolean) => {
        setCollapsedPanels(previous => side === 'left'
            ? { ...previous, first: collapsed }
            : { ...previous, last: collapsed });
    };

    const { getTriggerHandlers, isDragging, dragWidths, armableCollapseSides, armedCollapseSide }
        = usePanelResize(
            panelLayoutRef,
            visiblePanelIndices,
            panelCount,
            setWidths,
            side => setPanelCollapsed(side, true),
        );

    const shownWidths = dragWidths ?? visiblePanelIndices.map(index => widths[index]);
    const shownFlex = computePanelFlex(shownWidths, MIN_PANEL_WIDTH);

    return (
        <div
            className={`${styles.horizontalPanelLayout}
                ${isDragging(null) ? styles.isDragging : ''}`}
            ref={panelLayoutRef}
        >
            {collapsedPanels.first && (
                <CollapsedPanelHandle
                    side="left"
                    label={panelsData[0].collapsedLabel}
                    onExpand={side => setPanelCollapsed(side, false)}
                />
            )}
            {panelIndices.map(panelIndex => {
                const panelData = panelsData[panelIndex];
                const visibleIndex = visiblePanelIndices.indexOf(panelIndex);
                const hidden = visibleIndex === -1;
                const hasSeparator = !hidden && visibleIndex < visiblePanelIndices.length - 1;

                if (hidden && panelData.collapsedBehaviour !== 'hide') return null;

                return (
                    <Fragment key={panelIndex}>
                        <div
                            className={`${styles.panel}
                                ${hidden ? styles.hiddenPanel : ''}`}
                            style={hidden ? undefined : shownFlex[visibleIndex]}
                        >
                            {panelData.renderContent()}
                        </div>
                        {hasSeparator && (
                            <div
                                className={`${styles.separator}
                                    ${isDragging(visibleIndex) ? styles.activeSeparator : ''}`}
                                {...getTriggerHandlers(visibleIndex)}
                            ></div>
                        )}
                    </Fragment>
                );
            })}
            {collapsedPanels.last && (
                <CollapsedPanelHandle
                    side="right"
                    label={panelsData[panelCount - 1].collapsedLabel}
                    onExpand={side => setPanelCollapsed(side, false)}
                />
            )}
            {armableCollapseSides.left && (
                <CollapseDropZone side="left" armed={armedCollapseSide === 'left'} />
            )}
            {armableCollapseSides.right && (
                <CollapseDropZone side="right" armed={armedCollapseSide === 'right'} />
            )}
        </div>
    );
}
