import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { logger } from './logger';

export enum Action {
    CycleNext,
    CyclePrev,
    SelectNext,
    SelectPrev,
    HistoryPrev,
    HistoryNext,
    NextTab,
    PrevTab,
    Submit,
    Cancel,
    OpenCmdLine,
    OpenFuzzyFind,
    FocusMetadataEditor,
    ToggleMetadataEditor,
    FocusNotesEditor,
    FocusTagsEditor,
}

export const keymap: Array<[string, Action]> = [
    ["Tab", Action.CycleNext],
    ["Shift+Tab", Action.CyclePrev],
    ["j", Action.SelectNext],
    ["k", Action.SelectPrev],
    ["Ctrl+n", Action.SelectNext],
    ["Ctrl+p", Action.SelectPrev],
    ["ArrowUp", Action.HistoryPrev],
    ["ArrowDown", Action.HistoryNext],
    ["gt", Action.NextTab],
    ["gT", Action.PrevTab],
    ["Enter", Action.Submit],
    ["Ctrl+e", Action.FocusNotesEditor],
    ['Ctrl+g', Action.FocusTagsEditor],
    ["Ctrl+m", Action.FocusMetadataEditor],
    ["Ctrl+t", Action.ToggleMetadataEditor],
    [":", Action.OpenCmdLine],
    [" ff", Action.OpenFuzzyFind],
    ["Escape", Action.Cancel],
];

const LEADER_KEY_GLYPH = '\u2423';

export function findKeybindingForAction(action: Action): string | null {
    const keySequence = keymap.find(([, boundAction]) => boundAction === action)?.[0];
    if (keySequence === undefined) return null;

    return keySequence.replace(/^ /, LEADER_KEY_GLYPH);
}

// Whether a key press belongs to the focused text surface rather than to the
// global keymap. A text surface stops propagation for these and lets the rest
// bubble to the document listener, which is what keeps the keymap global
// without swallowing typing.
export function isTextProducingKey(event: KeyboardEvent): boolean {
    if (event.isComposing) return true;
    const key = event.key;
    if (key.length === 1 && !event.metaKey && !(event.ctrlKey && !event.altKey)) return true;
    if (key === 'Backspace' || key === 'Delete' || key === 'Home' || key === 'End') return true;
    if (key === 'ArrowLeft' || key === 'ArrowRight') return true;
    const mod = event.ctrlKey || event.metaKey;
    return mod && (key === 'a' || key === 'c' || key === 'v' || key === 'x');
}

type ActionHandler = () => void;

interface ActionRegistry {
    register: (action: Action, handler: ActionHandler) => () => void;
    getHandler: (action: Action) => ActionHandler | undefined;
}

function createActionRegistry(): ActionRegistry {
    const handlers = new Map<Action, ActionHandler[]>();

    return {
        register: (action, handler) => {
            const stack = handlers.get(action) ?? [];
            handlers.set(action, [...stack, handler]);

            return () => {
                const current = handlers.get(action) ?? [];
                handlers.set(action, current.filter(registered => registered !== handler));
            };
        },
        getHandler: action => {
            const stack = handlers.get(action);

            return stack?.[stack.length - 1];
        },
    };
}

interface ActionBusContextValue {
    globalRegistry: ActionRegistry;
    activateScope: (scope: ActionRegistry) => () => void;
    dispatch: (action: Action) => boolean;
}

const ActionBusContext = createContext<ActionBusContextValue | null>(null);
const ActionScopeContext = createContext<ActionRegistry | null>(null);

export function ActionProvider({ children }: { children: ReactNode }) {
    const [globalRegistry] = useState(createActionRegistry);
    const activeScopeRef = useRef<ActionRegistry | null>(null);

    const activateScope = useCallback((scope: ActionRegistry) => {
        activeScopeRef.current = scope;

        return () => {
            if (activeScopeRef.current === scope) activeScopeRef.current = null;
        };
    }, []);

    const dispatch = useCallback((action: Action) => {
        const handler = globalRegistry.getHandler(action)
            ?? activeScopeRef.current?.getHandler(action);
        if (!handler) {
            logger.debug(`No handler registered for action ${Action[action]}`);
            return false;
        }

        handler();
        return true;
    }, [globalRegistry]);

    return (
        <ActionBusContext.Provider value={{ globalRegistry, activateScope, dispatch }}>
            {children}
        </ActionBusContext.Provider>
    );
}

export function ActionScope({ active, children }: { active: boolean; children: ReactNode }) {
    const context = useContext(ActionBusContext);
    if (!context) throw new Error('ActionScope used outside an ActionProvider');

    const [registry] = useState(createActionRegistry);
    const { activateScope } = context;

    useLayoutEffect(() => {
        if (!active) return;
        return activateScope(registry);
    }, [active, registry, activateScope]);

    return (
        <ActionScopeContext.Provider value={registry}>
            {children}
        </ActionScopeContext.Provider>
    );
}

// Claims `action` for this component for as long as `enabled` holds.
export function useActionHandler(action: Action, handler: ActionHandler, enabled = true) {
    const context = useContext(ActionBusContext);
    if (!context) throw new Error('useActionHandler used outside an ActionProvider');
    const scope = useContext(ActionScopeContext);
    const register = (scope ?? context.globalRegistry).register;

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
