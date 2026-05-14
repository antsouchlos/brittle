import { useMemo } from 'react';
import './App.css';
import TabView, { type TabItem } from '../tabs/TabView';
import LibraryPage from '../library/LibraryPage';
import PdfTab from '../pdf/PdfTab';
import {
    useActiveTabId,
    useLibrary,
    useStore,
    useTabs,
    type Library,
    type TabState,
} from '../store';
import { useInitialLoad } from '../ipc/persistence';

function toTabItem(tab: TabState, library: Library | null): TabItem {
    if (tab.kind === 'library') {
        return {
            id: tab.id,
            title: 'Library',
            closable: false,
            render: () => <LibraryPage />,
        };
    }
    const doc = library?.documents[tab.documentId];
    return {
        id: tab.id,
        title: doc?.title ?? tab.documentId,
        closable: true,
        render: () => <PdfTab documentId={tab.documentId} />,
    };
}

function AppTabs() {
    const tabs = useTabs();
    const library = useLibrary();
    const activeTabId = useActiveTabId();
    const activateTab = useStore((s) => s.activateTab);
    const closeTab = useStore((s) => s.closeTab);

    const tabItems = useMemo(
        () => tabs.map((t) => toTabItem(t, library)),
        [tabs, library],
    );

    return (
        <TabView
            tabs={tabItems}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
        />
    );
}

function App() {
    const isReady = useInitialLoad();
    if (!isReady) return null;

    return <AppTabs />;
}

export default App;
