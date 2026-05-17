import { ReactNode, useCallback, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';

interface TabData {
    id: string;
    label: string;
    closeable: boolean;
    content: ReactNode;
}

interface TabViewProps {
    tabs: Array<TabData>;
    onCloseTab: (id: string) => void;
}

function TabView({ tabs, onCloseTab }: TabViewProps) {
    const [activeTabId, setActiveTabId] = useState(tabs[0].id);

    // Lazy tab loading (Only render a tab once visited)
    const [visited, setVisited] = useState<Set<string>>(() => new Set([tabs[0].id]));
    const isVisited = useCallback((id: string) => visited.has(id), [visited]);
    const markVisited = useCallback((id: string) => {
        setVisited(prev => prev.has(id) ? prev : new Set(prev).add(id));
    }, []);

    const closeTab = useCallback((closingId: string) => {
        onCloseTab(closingId);
        setVisited(prev => {
            const next = new Set(prev);
            next.delete(closingId);
            return next;
        });
        if (activeTabId === closingId) {
            const remaining = tabs.filter(t => t.id !== closingId);
            setActiveTabId(remaining[0]?.id ?? '');
        }
    }, [activeTabId, tabs]);

    return (
        <Tabs.Root value={activeTabId} onValueChange={(v) => { setActiveTabId(v); markVisited(v); }}>
            <Tabs.List>
                {tabs.map((t) => (
                    <Tabs.Trigger key={t.id} value={t.id}>
                        <span className="tab-label">{t.label}</span>
                        {t.closeable && (
                            <span
                                className="tab-close"
                                role="button"
                                tabIndex={0}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    closeTab(t.id);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.stopPropagation();
                                        closeTab(t.id);
                                    }
                                }}
                                aria-label={`Close ${t.label}`}
                            >×</span>
                        )}
                    </Tabs.Trigger>
                ))}
            </Tabs.List>
            {tabs.map((t) =>
                isVisited(t.id) ? (
                    <Tabs.Content key={t.id} value={t.id} forceMount>
                        {t.content}
                    </Tabs.Content>
                ) : null
            )}
        </Tabs.Root>
    );
}

export default TabView;
