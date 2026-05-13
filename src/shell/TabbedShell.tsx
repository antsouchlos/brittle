import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './TabbedShell.module.css';

export interface ShellTab {
    id: string;
    title: string;
    closable: boolean;
    render(): ReactNode;
}

interface TabbedShellProps {
    tabs: ShellTab[];
    activeTabId: string;
    onActivate(id: string): void;
    onClose(id: string): void;
}

/**
 * Controlled tab shell. Inactive tabs stay mounted (hidden via `display: none`)
 * so per-tab state (e.g. PDF scroll/zoom) survives tab switches. `mountedIds`
 * is a render optimization, not user state — we only track which tabs have
 * ever been activated.
 *
 * The shell is intentionally ignorant of what each tab renders; callers pass
 * a `render()` closure per tab.
 */
export default function TabbedShell({
    tabs,
    activeTabId,
    onActivate,
    onClose,
}: TabbedShellProps) {
    const mountedIdsRef = useRef<Set<string>>(new Set([activeTabId]));
    if (!mountedIdsRef.current.has(activeTabId)) {
        mountedIdsRef.current.add(activeTabId);
    }
    useEffect(() => {
        const open = new Set(tabs.map((t) => t.id));
        for (const id of mountedIdsRef.current) {
            if (!open.has(id)) mountedIdsRef.current.delete(id);
        }
    }, [tabs]);

    return (
        <div className={styles.root}>
            <TabBar
                tabs={tabs}
                activeTabId={activeTabId}
                onActivate={onActivate}
                onClose={onClose}
            />
            <div className={styles.body}>
                {tabs.map((t) =>
                    mountedIdsRef.current.has(t.id) ? (
                        <div
                            key={t.id}
                            className={`${styles.pane} ${t.id === activeTabId ? '' : styles.paneHidden}`}
                        >
                            {t.render()}
                        </div>
                    ) : null,
                )}
            </div>
        </div>
    );
}

interface TabBarProps {
    tabs: ShellTab[];
    activeTabId: string;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
}

function TabBar({ tabs, activeTabId, onActivate, onClose }: TabBarProps) {
    return (
        <div className={styles.tabBar}>
            {tabs.map((t) => (
                <TabButton
                    key={t.id}
                    tab={t}
                    isActive={t.id === activeTabId}
                    onActivate={onActivate}
                    onClose={onClose}
                />
            ))}
        </div>
    );
}

interface TabButtonProps {
    tab: ShellTab;
    isActive: boolean;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
}

function TabButton({ tab, isActive, onActivate, onClose }: TabButtonProps) {
    const { id, title, closable } = tab;

    return (
        <div
            className={styles.tab}
            data-active={isActive}
            tabIndex={0}
            role="tab"
            aria-selected={isActive}
            onClick={() => onActivate(id)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(id);
                } else if ((e.key === 'Delete' || e.key === 'Backspace') && closable) {
                    e.preventDefault();
                    onClose(id);
                }
            }}
            onAuxClick={(e) => {
                if (e.button === 1 && closable) onClose(id);
            }}
        >
            <span className={styles.tabTitle}>{title}</span>
            {closable && (
                <button
                    className={styles.closeButton}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose(id);
                    }}
                    aria-label={`Close ${title}`}
                >
                    <X size={12} />
                </button>
            )}
        </div>
    );
}
