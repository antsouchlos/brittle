import {
    createContext,
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';

import { FocusController, type FocusAdapter } from './FocusController.ts';

const FocusContext = createContext<FocusController | null>(null);

function hasTextFocus() {
    const element = document.activeElement;

    return element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || (element instanceof HTMLElement && element.isContentEditable);
}

export function FocusProvider({ children }: { children: ReactNode }) {
    const [controller] = useState(() => new FocusController({
        getActiveElement: () => document.activeElement,
        hasTextFocus,
        hasWindowFocus: () => document.hasFocus(),
        schedule: callback => {
            const frame = requestAnimationFrame(callback);

            return () => cancelAnimationFrame(frame);
        },
    }));

    useLayoutEffect(() => {
        const observeFocus = () => controller.observeFocus();
        document.addEventListener('focusin', observeFocus);
        document.addEventListener('focusout', controller.reconcileFocus);
        window.addEventListener('focus', controller.reconcileFocus);
        window.addEventListener('blur', controller.cancelWork);

        return () => {
            document.removeEventListener('focusin', observeFocus);
            document.removeEventListener('focusout', controller.reconcileFocus);
            window.removeEventListener('focus', controller.reconcileFocus);
            window.removeEventListener('blur', controller.cancelWork);
            controller.cancelWork();
        };
    }, [controller]);

    return <FocusContext.Provider value={controller}>{children}</FocusContext.Provider>;
}

export interface FocusTarget {
    ref: (element: HTMLElement | null) => void;
    requestFocus: () => void;
    releaseFocus: () => void;
    focused: boolean;
}

interface FocusTargetOptions {
    available?: boolean;
    identity?: unknown;
}

export function useFocusTarget({
    available = true,
    identity,
}: FocusTargetOptions = {}): FocusTarget {
    const controller = useContext(FocusContext);
    if (!controller) throw new Error('useFocusTarget used outside a FocusProvider');

    const target = useMemo(() => Symbol('focusTarget'), [identity]);
    const elementRef = useRef<HTMLElement | null>(null);
    const adapter = useMemo<FocusAdapter>(() => ({
        isAvailable: () => {
            const element = elementRef.current;

            return !!element?.isConnected && element.getClientRects().length > 0;
        },
        contains: element => element instanceof Node && !!elementRef.current?.contains(element),
        focus: () => elementRef.current?.focus(),
        blur: () => elementRef.current?.blur(),
    }), []);

    useLayoutEffect(() => {
        if (!available) return;

        return controller.register(target, adapter);
    }, [controller, target, adapter, available]);

    const ref = useCallback((element: HTMLElement | null) => {
        elementRef.current = element;
        controller.reconcileFocus();
    }, [controller, target]);
    const requestFocus = useCallback(() => controller.requestFocus(target), [controller, target]);
    const releaseFocus = useCallback(() => controller.releaseFocus(target), [controller, target]);
    const getSnapshot = useCallback(() => controller.isFocused(target), [controller, target]);
    const focused = useSyncExternalStore(controller.subscribe, getSnapshot);

    return useMemo(() => ({ ref, requestFocus, releaseFocus, focused }), [ref, requestFocus, releaseFocus, focused]);
}
