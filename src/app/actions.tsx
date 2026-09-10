import { createContext, ReactNode, useCallback, useContext, useEffect, useRef } from 'react';
import { logger } from './logger';

export enum Action {
    SelectNextCollection,
    SelectPrevCollection,
    SelectNextPublication,
    SelectPrevPublication,
    NextTab,
    PrevTab,
    OpenSelectedPublication,
    OpenCmdLine,
    OpenFuzzyFind,
    CloseFuzzyFind,
    FocusBibEditor,
}

export const keymap: Array<[string, Action]> = [
    ["Tab", Action.SelectNextCollection],
    ["Shift+Tab", Action.SelectPrevCollection],
    ["j", Action.SelectNextPublication],
    ["k", Action.SelectPrevPublication],
    ["Ctrl+n", Action.SelectNextPublication],
    ["Ctrl+p", Action.SelectPrevPublication],
    ["gt", Action.NextTab],
    ["gT", Action.PrevTab],
    ["Enter", Action.OpenSelectedPublication],
    ["Ctrl+e", Action.FocusBibEditor],
    [":", Action.OpenCmdLine],
    [" ff", Action.OpenFuzzyFind],
    ["Escape", Action.CloseFuzzyFind],
];

type ActionHandler = () => void;

interface ActionBusContextValue {
    register: (action: Action, handler: ActionHandler) => () => void;
    dispatch: (action: Action) => boolean;
}

// The action bus is a lookup table from an action to the function that
// performs it.
//
// A component keeps its own `useState` and registers a closure over its own
// setters; `App` keeps the single global `keydown` listener and only knows
// that *some* handler claimed the action. This allows the keymap to be global
// without necessitating lifting all relevant state.
const ActionBusContext = createContext<ActionBusContextValue | null>(null);

export function ActionProvider({ children }: { children: ReactNode }) {
    const handlersRef = useRef(new Map<Action, ActionHandler[]>());

    const register = useCallback((action: Action, handler: ActionHandler) => {
        const stack = handlersRef.current.get(action) ?? [];
        handlersRef.current.set(action, [...stack, handler]);

        return () => {
            const current = handlersRef.current.get(action) ?? [];
            handlersRef.current.set(action, current.filter(h => h !== handler));
        };
    }, []);

    const dispatch = useCallback((action: Action) => {
        const stack = handlersRef.current.get(action) ?? [];
        const handler = stack[stack.length - 1];
        if (!handler) {
            logger.debug(`No handler registered for action ${Action[action]}`);
            return false;
        }

        handler();
        return true;
    }, []);

    return (
        <ActionBusContext.Provider value={{ register, dispatch }}>
            {children}
        </ActionBusContext.Provider>
    );
}

// Claims `action` for this component for as long as `enabled` holds.
export function useActionHandler(action: Action, handler: ActionHandler, enabled = true) {
    const context = useContext(ActionBusContext);
    if (!context) throw new Error('useActionHandler used outside an ActionProvider');
    const { register } = context;

    const latestRef = useRef(handler);
    latestRef.current = handler;

    useEffect(() => {
        if (!enabled) return;
        return register(action, () => latestRef.current());
    }, [action, enabled, register]);
}

// For the keymap owner: turns a resolved action into whatever component
// claimed it.
export function useActionDispatch(): (action: Action) => boolean {
    const context = useContext(ActionBusContext);
    if (!context) throw new Error('useActionDispatch used outside an ActionProvider');
    return context.dispatch;
}
