export interface FocusAdapter {
    isAvailable: () => boolean;
    contains: (element: unknown) => boolean;
    focus: () => void;
    blur: () => void;
}

interface FocusEnvironment {
    getActiveElement: () => unknown;
    hasTextFocus: () => boolean;
    hasWindowFocus: () => boolean;
    schedule: (callback: () => void) => () => void;
}

interface FocusRegistration {
    adapter: FocusAdapter;
}

interface FocusEntry {
    target: symbol;
    mounted: boolean;
}

export class FocusController {
    private targets = new Map<symbol, FocusRegistration>();
    private listeners = new Set<() => void>();
    private stack: FocusEntry[] = [];
    private owner: symbol | null = null;
    private pending: symbol | null = null;
    private cancelScheduled: (() => void) | null = null;
    private generation = 0;

    constructor(private environment: FocusEnvironment) {}

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);

        return () => { this.listeners.delete(listener); };
    };

    isFocused = (target: symbol) => this.owner === target;

    register(target: symbol, adapter: FocusAdapter) {
        const registration = { adapter };
        this.targets.set(target, registration);
        this.reconcileFocus();

        return () => {
            if (this.targets.get(target) !== registration) return;

            this.targets.delete(target);
            this.releaseFocus(target, adapter);
        };
    }

    requestFocus(target: symbol) {
        if (!this.targets.has(target)) return;

        this.promoteTarget(target);
        this.pending = target;
        this.setOwner(target);
        this.reconcileFocus();
    }

    releaseFocus(target: symbol, adapter = this.targets.get(target)?.adapter) {
        const wasTop = this.stack[this.stack.length - 1]?.target === target;
        this.stack = this.stack.filter(entry => entry.target !== target);
        if (this.pending === target) this.pending = null;
        if (!wasTop) return;

        if (adapter?.contains(this.environment.getActiveElement())) adapter.blur();
        this.pruneTargets();
        this.setOwner(this.stack[this.stack.length - 1]?.target ?? null);
        this.reconcileFocus();
    }

    observeFocus() {
        const target = this.findTarget(this.environment.getActiveElement());
        if (this.pending !== null && this.pending !== target) {
            this.stack = this.stack.filter(entry => entry.target !== this.pending);
        }
        this.pending = null;
        if (target !== null) this.promoteTarget(target);
        this.setOwner(target);
        this.reconcileFocus();
    }

    private promoteTarget(target: symbol) {
        const entry = this.stack.find(entry => entry.target === target)
            ?? { target, mounted: false };
        entry.mounted ||= this.targets.get(target)?.adapter.isAvailable() ?? false;
        this.stack = this.stack.filter(entry => entry.target !== target);
        this.stack.push(entry);
    }

    private pruneTargets() {
        this.stack = this.stack.filter(entry => {
            const adapter = this.targets.get(entry.target)?.adapter;
            if (!adapter) return false;
            if (adapter.isAvailable()) {
                entry.mounted = true;

                return true;
            }

            return !entry.mounted && entry.target === this.pending;
        });
        if (!this.stack.some(entry => entry.target === this.pending)) this.pending = null;
    }

    reconcileFocus = () => {
        this.cancelWork();
        const generation = this.generation;
        this.cancelScheduled = this.environment.schedule(() => {
            if (generation !== this.generation) return;

            this.cancelScheduled = null;
            this.applyFocus();
        });
    };

    cancelWork = () => {
        this.generation += 1;
        this.cancelScheduled?.();
        this.cancelScheduled = null;
    };

    private setOwner(target: symbol | null) {
        if (this.owner === target) return;

        this.owner = target;
        for (const listener of this.listeners) listener();
    }

    private findTarget(element: unknown): symbol | null {
        for (const [target, { adapter }] of this.targets) {
            if (adapter.isAvailable() && adapter.contains(element)) return target;
        }

        return null;
    }

    private applyFocus() {
        if (!this.environment.hasWindowFocus()) return;

        this.pruneTargets();
        const target = this.stack[this.stack.length - 1]?.target ?? null;
        const activeElement = this.environment.getActiveElement();
        if (this.pending === null
            && this.findTarget(activeElement) === null
            && this.environment.hasTextFocus()) {
            this.setOwner(null);

            return;
        }

        this.setOwner(target);
        if (target === null) return;
        const adapter = this.targets.get(target)?.adapter;
        if (!adapter?.isAvailable()) return;

        this.pending = null;
        if (!adapter.contains(activeElement)) adapter.focus();
    }
}
