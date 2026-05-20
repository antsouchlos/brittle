import { useState } from 'react';
import { Layout } from 'react-resizable-panels';
import './App.css';
import TabView from '../tabs/TabView.tsx';

import LibraryTabContent, {
    Collection,
    CollectionId,
    Entry,
    EntryId,
    Library,
    libraryPanelIds,
} from './LibraryTabContent.tsx';

const sampleLibrary: Library = {
    rootId: 'library',
    entries: new Map<EntryId, Entry>([
        ['entry-1', { id: 'entry-1', name: 'Attention Is All You Need' }],
        ['entry-2', { id: 'entry-2', name: 'The Rust Programming Language' }],
        ['entry-3', { id: 'entry-3', name: 'Designing Data-Intensive Applications' }],
        ['entry-4', { id: 'entry-4', name: 'PDF Rendering Notes' }],
    ]),
    collections: new Map<CollectionId, Collection>([
        ['library', {
            id: 'library',
            name: 'Library',
            childCollectionIds: ['research', 'engineering', 'reading-list'],
            entryIds: ['entry-1', 'entry-2'],
        }],
        ['research', {
            id: 'research',
            name: 'Research',
            childCollectionIds: ['papers'],
            entryIds: ['entry-1'],
        }],
        ['papers', {
            id: 'papers',
            name: 'Papers',
            childCollectionIds: [],
            entryIds: ['entry-1', 'entry-4'],
        }],
        ['engineering', {
            id: 'engineering',
            name: 'Engineering',
            childCollectionIds: [],
            entryIds: ['entry-2', 'entry-3'],
        }],
        ['reading-list', {
            id: 'reading-list',
            name: 'Reading List',
            childCollectionIds: [],
            entryIds: ['entry-1', 'entry-3'],
        }],
    ]),
};

const defaultLibraryLayout: Layout = {
    [libraryPanelIds.collections]: 33,
    [libraryPanelIds.viewer]: 34,
    [libraryPanelIds.details]: 33,
};

function App() {
    const [library] = useState<Library>(sampleLibrary);
    const [libraryLayout, setLibraryLayout] = useState<Layout>(defaultLibraryLayout);
    const fixedTabs = [
        {
            id: 'Lib',
            label: 'Library',
            renderContent: () => (<LibraryTabContent
                library={library}
                panelLayout={libraryLayout}
                onPanelLayoutChange={setLibraryLayout}
            />),
        },
    ];

    const [selectedTabId, setSelectedTabId] = useState(fixedTabs[0].id);

    const [variableTabs, setVariableTabs] = useState(() => [
        { id: 'A', label: 'A.pdf', renderContent: () => (<div>Content 2</div>) },
        { id: 'B', label: 'B.pdf', renderContent: () => (<div>Content 3</div>) },
        { id: 'C', label: 'C.pdf', renderContent: () => (<div>Content 4</div>) },
    ]);

    return <TabView
        fixedTabs={fixedTabs}
        variableTabs={variableTabs}
        selectedTabId={selectedTabId}
        onSelectTab={setSelectedTabId}
        onCloseTab={(id: string) => {
            // Remove closed tab

            setVariableTabs(variableTabs.filter((tab) => (tab.id != id)));
            if (id != selectedTabId) return;

            // Select other tab if the selected one was closed

            const allTabs = fixedTabs.concat(variableTabs);

            const selectedIdx = allTabs.findIndex(
                (tab) => tab.id == selectedTabId);

            if (!selectedIdx) {
                console.error("Could not find closed tab id");
                return;
            }

            if (selectedIdx + 1 < allTabs.length) {
                setSelectedTabId(allTabs[selectedIdx + 1].id);
            } else {
                setSelectedTabId(allTabs[allTabs.length - 2].id);
            }
        }}
        onReorderTabs={(from: number, to: number) => {
            setVariableTabs(prev => {
                const newTabs = [...prev];
                const [moved] = newTabs.splice(from, 1);
                newTabs.splice(to, 0, moved);
                return newTabs;
            });
        }}
    />;
}

export default App;
