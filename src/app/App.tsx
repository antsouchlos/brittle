import { useMemo } from 'react';
import './App.css';
import TabbedShell, { type ShellTab } from '../shell/TabbedShell';
import LibraryView from '../library/LibraryView';
import PdfTab from '../pdf/PdfTab';
import {
    useActiveTabId,
    useLibrary,
    useStore,
    useTabs,
    type Library,
    type TabDescriptor,
} from '../store';
import { useHydration } from '../ipc/persistence';

function toShellTab(tab: TabDescriptor, library: Library | null): ShellTab {
    if (tab.kind === 'library') {
        return {
            id: tab.id,
            title: 'Library',
            closable: false,
            render: () => <LibraryView />,
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

function Shell() {
    const tabs = useTabs();
    const library = useLibrary();
    const activeTabId = useActiveTabId();
    const activateTab = useStore((s) => s.activateTab);
    const closeTab = useStore((s) => s.closeTab);

    const shellTabs = useMemo(
        () => tabs.map((t) => toShellTab(t, library)),
        [tabs, library],
    );

    return (
        <TabbedShell
            tabs={shellTabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
        />
    );
}

function App() {
    const hydrated = useHydration();
    if (!hydrated) return null;

    return <Shell />;
}

export default App;
