import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { DocumentId, Tab } from './store';
import { LIBRARY_TAB_ID, useDocument } from './store';
import styles from './TabbedShell.module.css';

interface TabbedShellProps {
    tabs: Tab[];
    activeTabId: string;
    onActivate(id: string): void;
    onClose(id: string): void;
    renderLibrary(): ReactNode;
    renderPdf(documentId: DocumentId): ReactNode;
}

/**
 * Controlled tab shell. Inactive tabs stay mounted (hidden via `display: none`)
 * so PDF state survives tab switches. `mountedIds` is a render optimization,
 * not user state — we only track which tabs have ever been activated.
 */
export default function TabbedShell({
    tabs,
    activeTabId,
    onActivate,
    onClose,
    renderLibrary,
    renderPdf,
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
                            {t.kind === 'library' ? renderLibrary() : renderPdf(t.documentId)}
                        </div>
                    ) : null,
                )}
            </div>
        </div>
    );
}

interface TabBarProps {
    tabs: Tab[];
    activeTabId: string;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
}

function TabBar({ tabs, activeTabId, onActivate, onClose }: TabBarProps) {
    return (
        <div className={styles.tabBar}>
            {tabs.map((t) => {
                const isActive = t.id === activeTabId;
                const closable = t.id !== LIBRARY_TAB_ID;
                return (
                    <TabButton
                        key={t.id}
                        tab={t}
                        isActive={isActive}
                        closable={closable}
                        onActivate={onActivate}
                        onClose={onClose}
                    />
                );
            })}
        </div>
    );
}

interface TabButtonProps {
    tab: Tab;
    isActive: boolean;
    closable: boolean;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
}

function TabButton({ tab, isActive, closable, onActivate, onClose }: TabButtonProps) {
    const doc = useDocument(tab.kind === 'pdf' ? tab.documentId : null);
    const title = tab.kind === 'library' ? 'Library' : doc?.title ?? tab.documentId;

    return (
        <div
            className={styles.tab}
            data-active={isActive}
            tabIndex={0}
            role="tab"
            aria-selected={isActive}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onActivate(tab.id);
                } else if ((e.key === 'Delete' || e.key === 'Backspace') && closable) {
                    e.preventDefault();
                    onClose(tab.id);
                }
            }}
            onAuxClick={(e) => {
                if (e.button === 1 && closable) onClose(tab.id);
            }}
        >
            <span className={styles.tabTitle}>{title}</span>
            {closable && (
                <button
                    className={styles.closeButton}
                    onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                    }}
                    aria-label={`Close ${title}`}
                >
                    <X size={12} />
                </button>
            )}
        </div>
    );
}
