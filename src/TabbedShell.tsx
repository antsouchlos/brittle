import { useState } from 'react';
import { X } from 'lucide-react';
import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import ThreePaneLayout from './ThreePaneLayout';

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
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={closeTab} />
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                {tabs.map((t) =>
                    mountedIds.has(t.id) ? (
                        <div
                            key={t.id}
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: t.id === activeId ? 'block' : 'none',
                            }}
                        >
                            {t.kind === 'library' ? (
                                <ThreePaneLayout />
                            ) : (
                                <PDFViewer
                                    style={{ width: '100%', height: '100%' }}
                                    config={{ src: t.src, theme: { preference: 'dark' } }}
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
        <div
            style={{
                display: 'flex',
                alignItems: 'stretch',
                background: '#f3f4f6',
                borderBottom: '1px solid #e5e7eb',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: 13,
                userSelect: 'none',
            }}
        >
            {tabs.map((t) => {
                const isActive = t.id === activeId;
                const closable = t.kind !== 'library';
                return (
                    <div
                        key={t.id}
                        onClick={() => onActivate(t.id)}
                        onAuxClick={(e) => {
                            if (e.button === 1 && closable) onClose(t.id);
                        }}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '8px 12px',
                            cursor: 'pointer',
                            background: isActive ? '#ffffff' : 'transparent',
                            borderRight: '1px solid #e5e7eb',
                            borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                            color: isActive ? '#1f2937' : '#6b7280',
                            maxWidth: 220,
                        }}
                    >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {t.title}
                        </span>
                        {closable && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose(t.id);
                                }}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: 16,
                                    height: 16,
                                    border: 'none',
                                    background: 'transparent',
                                    cursor: 'pointer',
                                    color: 'inherit',
                                    padding: 0,
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
