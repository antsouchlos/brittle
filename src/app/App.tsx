import { useState } from 'react';
import { Folder, Library } from 'lucide-react';
import './App.css';
import TabView from '../components/TabView.tsx';
import HorizontalPanelLayout from '../components/HorizontalPanelLayout.tsx';
import TreeView from '../components/TreeView.tsx';

import { PDFViewer } from '@embedpdf/react-pdf-viewer';

const samplePdfConfig = {
    src: 'https://snippet.embedpdf.com/ebook.pdf',
    theme: { preference: 'dark' as const },
};
const pdfStyle = { width: '100%', height: '100%' };
const renderFolderIcon = () => <Folder size={15} aria-hidden="true" />;
const renderLibraryIcon = () => <Library size={15} aria-hidden="true" />;

// import {
//     Collection,
//     CollectionId,
//     Entry,
//     EntryId,
//     Library,
//     // libraryPanelIds,
// } from './LibraryTabContent.tsx';

// const sampleLibrary: Library = {
//     rootId: 'library',
//     entries: new Map<EntryId, Entry>([
//         ['entry-1', { id: 'entry-1', name: 'Attention Is All You Need' }],
//         ['entry-2', { id: 'entry-2', name: 'The Rust Programming Language' }],
//         ['entry-3', { id: 'entry-3', name: 'Designing Data-Intensive Applications' }],
//         ['entry-4', { id: 'entry-4', name: 'PDF Rendering Notes' }],
//     ]),
//     collections: new Map<CollectionId, Collection>([
//         ['library', {
//             id: 'library',
//             name: 'Library',
//             childCollectionIds: ['research', 'engineering', 'reading-list'],
//             entryIds: ['entry-1', 'entry-2'],
//         }],
//         ['research', {
//             id: 'research',
//             name: 'Research',
//             childCollectionIds: ['papers'],
//             entryIds: ['entry-1'],
//         }],
//         ['papers', {
//             id: 'papers',
//             name: 'Papers',
//             childCollectionIds: [],
//             entryIds: ['entry-1', 'entry-4'],
//         }],
//         ['engineering', {
//             id: 'engineering',
//             name: 'Engineering',
//             childCollectionIds: [],
//             entryIds: ['entry-2', 'entry-3'],
//         }],
//         ['reading-list', {
//             id: 'reading-list',
//             name: 'Reading List',
//             childCollectionIds: [],
//             entryIds: ['entry-1', 'entry-3'],
//         }],
//     ]),
// };

// const defaultLibraryLayout: Layout = {
//     [libraryPanelIds.collections]: 33,
//     [libraryPanelIds.viewer]: 34,
//     [libraryPanelIds.details]: 33,
// };

function App() {
    // const [library] = useState<Library>(sampleLibrary);
    // const [libraryLayout, setLibraryLayout] = useState<Layout>(defaultLibraryLayout);

    const [panel1Width, setPanel1Width] = useState(0.33);
    const [panel2Width, setPanel2Width] = useState(0.33);
    const [selectedNodeId, setSelectedNodeId] = useState('library');
    const [expandedNodeIds, setExpandedNodeIds] = useState<string[]>(['library']);

    const root = {
        id: 'library',
        name: "Library",
        count: 9,
        renderIcon: renderLibraryIcon,
        children: [
            {
                id: 'ba-thesis',
                name: "ba-thesis",
                count: 1,
                renderIcon: renderFolderIcon,
                children: [],
            },
            {
                id: 'ma-thesis',
                name: "ma-thesis",
                count: 3,
                renderIcon: renderFolderIcon,
                children: [
                    {
                        id: 'fundamentals',
                        name: "fundamentals",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                    {
                        id: 'research-gap',
                        name: "research-gap",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                    {
                        id: 'state-of-the-art',
                        name: "state-of-the-art",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                ],
            },
            {
                id: 'phd',
                name: "phd",
                count: 2,
                renderIcon: renderFolderIcon,
                children: [
                    {
                        id: 'qec',
                        name: "qec",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                    {
                        id: 'polar-codes',
                        name: "polar-codes",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                ],
            },
            {
                id: 'other',
                name: "other",
                count: 2,
                renderIcon: renderFolderIcon,
                children: [
                    {
                        id: 'electronics',
                        name: "electronics",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                    {
                        id: 'software',
                        name: "software",
                        count: 1,
                        renderIcon: renderFolderIcon,
                        children: [],
                    },
                ],
            },
        ],
    };

    const fixedTabs = [
        {
            id: 'Lib',
            label: 'Library',
            renderContent: () => (
                <HorizontalPanelLayout
                    firstPanelsData={[
                        {
                            width: panel1Width,
                            setWidth: setPanel1Width,
                            renderContent: () => (
                                <TreeView
                                    root={root}
                                    selectedNodeId={selectedNodeId}
                                    expandedNodeIds={expandedNodeIds}
                                    onToggleExpanded={(id: string) => {
                                        setExpandedNodeIds((prev) => (
                                            prev.includes(id)
                                                ? prev.filter((expandedId) => expandedId !== id)
                                                : [...prev, id]
                                        ));
                                    }}
                                    onSelectNode={setSelectedNodeId}
                                />
                            ),
                        },
                        {
                            width: panel2Width,
                            setWidth: setPanel2Width,
                            renderContent: () => <div>Panel 2</div>,
                        }
                    ]}
                    renderLastPanelContent={() => <div>Panel 4</div>}
                />
            ),
            // renderContent: () => (<LibraryTabContent
            //     library={library}
            //     panelLayout={libraryLayout}
            //     onPanelLayoutChange={setLibraryLayout}
            // />),
        },
    ];

    const [selectedTabId, setSelectedTabId] = useState(fixedTabs[0].id);

    const [variableTabs, setVariableTabs] = useState(() => [
        {
            id: 'A', label: 'A.pdf', renderContent: () => (
                <PDFViewer style={pdfStyle} config={samplePdfConfig} />
            )
        },
        {
            id: 'B', label: 'B.pdf', renderContent: () => (
                <PDFViewer style={pdfStyle} config={samplePdfConfig} />
            )
        },
        {
            id: 'C', label: 'C.pdf', renderContent: () => (
                <PDFViewer style={pdfStyle} config={samplePdfConfig} />
            )
        },
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
