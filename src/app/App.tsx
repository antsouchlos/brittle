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
    const [tabs, setTabs] = useState(() => [
        {
            id: 'tab1',
            label: 'Library',
            closeable: false,
            content: (
                <LibraryTabContent
                    library={library}
                    panelLayout={libraryLayout}
                    onPanelLayoutChange={setLibraryLayout}
                />
            ),
        },
        { id: 'tab2', label: 'A.pdf', closeable: true, content: <div>Content 2</div> },
        { id: 'tab3', label: 'B.pdf', closeable: true, content: <div>Content 3</div> },
        { id: 'tab4', label: 'C.pdf', closeable: true, content: <div>Content 4</div> },
    ]);

    return <TabView
        tabs={tabs}
        onCloseTab={(id: string) => (setTabs(prev => prev.filter(t => t.id !== id)))}
        onReorderTabs={(from: number, to: number) => setTabs(prev => {
            const next = prev.slice();
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
        })}
    />;
}

export default App;
