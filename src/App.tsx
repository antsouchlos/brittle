import { useEffect, useState } from 'react';
import './App.css';
import TabbedShell from './TabbedShell';
import LibraryView from './LibraryView';
import PdfTab from './PdfTab';
import { useActiveTabId, useStore, useTabs } from './store';
import { loadInitialState, subscribeAndSave } from './persistence';

function App() {
    const hydrated = useHydration();
    if (!hydrated) return null;
    return <Shell />;
}

function Shell() {
    const tabs = useTabs();
    const activeTabId = useActiveTabId();
    const activateTab = useStore((s) => s.activateTab);
    const closeTab = useStore((s) => s.closeTab);

    return (
        <TabbedShell
            tabs={tabs}
            activeTabId={activeTabId}
            onActivate={activateTab}
            onClose={closeTab}
            renderLibrary={() => <LibraryView />}
            renderPdf={(id) => <PdfTab documentId={id} />}
        />
    );
}

/**
 * Loads library + persisted UI state from Rust and hydrates the store before
 * first render of the shell. Wires save-on-change subscription, with HMR-safe
 * teardown to avoid stacking subscribers across module reloads.
 */
function useHydration(): boolean {
    const [ready, setReady] = useState(false);
    const hydrate = useStore((s) => s.hydrate);

    useEffect(() => {
        let teardown: (() => void) | undefined;
        let cancelled = false;
        loadInitialState()
            .then(({ libraryDto, uiDto }) => {
                if (cancelled) return;
                hydrate(libraryDto, uiDto);
                teardown = subscribeAndSave();
                setReady(true);
            })
            .catch((err) => {
                console.error('initial state load failed', err);
                if (!cancelled) setReady(true); // still render; store has defaults
            });
        return () => {
            cancelled = true;
            teardown?.();
        };
    }, [hydrate]);

    return ready;
}

export default App;
