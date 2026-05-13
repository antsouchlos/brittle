import { useState } from 'react';
import { X } from 'lucide-react';
import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import ThreePaneLayout from './ThreePaneLayout';
import styles from './TabbedShell.module.css';

type Tab =
    | { id: 'library'; kind: 'library'; title: string }
    | { id: string; kind: 'pdf'; title: string; src: string };

const LIBRARY_TAB: Tab = { id: 'library', kind: 'library', title: 'Library' };

export default function TabbedShell() {
    const [tabs, setTabs] = useState<Tab[]>([LIBRARY_TAB]);
    const [activeId, setActiveId] = useState<string>(LIBRARY_TAB.id);
    const [mountedIds, setMountedIds] = useState<Set<string>>(new Set([LIBRARY_TAB.id]));

    const activate = (id: string) => {
        setActiveId(id);
        setMountedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    };

    const closeTab = (id: string) => {
        if (id === LIBRARY_TAB.id) return;
        setTabs((prev) => {
            const idx = prev.findIndex((t) => t.id === id);
            if (idx === -1) return prev;
            const next = prev.filter((t) => t.id !== id);
            if (id === activeId) {
                const fallback = next[idx] ?? next[idx - 1] ?? LIBRARY_TAB;
                setActiveId(fallback.id);
            }
            return next;
        });
        setMountedIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    return (
        <div className={styles.root}>
            <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={closeTab} />
            <div className={styles.body}>
                {tabs.map((t) =>
                    mountedIds.has(t.id) ? (
                        <div
                            key={t.id}
                            className={`${styles.pane} ${t.id === activeId ? '' : styles.paneHidden}`}
                        >
                            {t.kind === 'library' ? (
                                <ThreePaneLayout />
                            ) : (
                                <PDFViewer
                                    style={{ width: '100%', height: '100%' }}
                                    config={{
                                        src: t.src,
                                        theme: { preference: 'dark' },
                                        commands: {
                                            disabledCategories: [
                                                'zoom',
                                                'tools',
                                                'document',
                                                'panel',
                                                'page',
                                                'selection',
                                                'history',
                                            ],
                                        },
                                    }}
                                />
                            )}
                        </div>
                    ) : null,
                )}
            </div>
        </div>
    );
}

interface TabBarProps {
    tabs: Tab[];
    activeId: string;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
}

function TabBar({ tabs, activeId, onActivate, onClose }: TabBarProps) {
    return (
        <div className={styles.tabBar}>
            {tabs.map((t) => {
                const isActive = t.id === activeId;
                const closable = t.kind !== 'library';
                return (
                    <div
                        key={t.id}
                        className={styles.tab}
                        data-active={isActive}
                        tabIndex={0}
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => onActivate(t.id)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onActivate(t.id);
                            } else if ((e.key === 'Delete' || e.key === 'Backspace') && closable) {
                                e.preventDefault();
                                onClose(t.id);
                            }
                        }}
                        onAuxClick={(e) => {
                            if (e.button === 1 && closable) onClose(t.id);
                        }}
                    >
                        <span className={styles.tabTitle}>{t.title}</span>
                        {closable && (
                            <button
                                className={styles.closeButton}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose(t.id);
                                }}
                                aria-label={`Close ${t.title}`}
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
