import { useState } from 'react';
import { Folder, Library } from 'lucide-react';
import styles from './App.module.css'
import './App.css';
import TabView from '../components/TabView.tsx';
import HorizontalPanelLayout from '../components/HorizontalPanelLayout.tsx';
import TreeView from '../components/TreeView.tsx';

import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import PublicationList from '../components/PublicationList.tsx';
import DetailView from '../components/DetailView.tsx';

const samplePdfConfig = {
    src: 'https://snippet.embedpdf.com/ebook.pdf',
    theme: { preference: 'dark' as const },
};
const pdfStyle = { width: '100%', height: '100%' };
const renderFolderIcon = () => <Folder size={15} aria-hidden="true" />;
const renderLibraryIcon = () => <Library size={15} aria-hidden="true" />;


const publications = [
    {
        id: "vaswani-attention-2017",
        title: "Attention Is All You Need",
        author: "Ashish Vaswani et al.",
        journal: "NeurIPS",
        date: "2017",
    },
    {
        id: "klabnik-rust-2023",
        title: "The Rust Programming Language",
        author: "Steve Klabnik, Carol Nichols",
        journal: "No Starch Press",
        date: "2023",
    },
    {
        id: "kleppmann-data-2017",
        title: "Designing Data-Intensive Applications",
        author: "Martin Kleppmann",
        journal: "O'Reilly Media",
        date: "2017",
    },
    {
        id: "macwilliams-theory-1977",
        title: "The Theory of Error-Correcting Codes",
        author: "F. Jessie MacWilliams, Neil J. A. Sloane",
        journal: "North-Holland",
        date: "1977",
    },
    {
        id: "gottesman-quantum-2009",
        title: "Quantum Error Correction for Beginners",
        author: "Daniel Gottesman",
        journal: "Lecture Notes",
        date: "2009",
    },
    {
        id: "arikan-channel-2009",
        title: "Channel Polarization: A Method for Constructing Capacity-Achieving Codes",
        author: "Erdal Arikan",
        journal: "IEEE Transactions on Information Theory",
        date: "2009",
    },
    {
        id: "vangala-survey-2015",
        title: "A Survey of Polar Coding Schemes",
        author: "Harish Vangala, Emanuele Viterbo, Yi Hong",
        journal: "IEEE Communications Surveys & Tutorials",
        date: "2015",
    },
    {
        id: "manning-foundations-1999",
        title: "Foundations of Statistical Natural Language Processing",
        author: "Christopher D. Manning, Hinrich Schutze",
        journal: "MIT Press",
        date: "1999",
    },
    {
        id: "lee-research-2024",
        title: "Research Gaps in Human-AI Collaboration",
        author: "Mina Lee, Percy Liang",
        journal: "CHI Workshop Proceedings",
        date: "2024",
    },
    {
        id: "lewis-state-2024",
        title: "State of the Art in Retrieval-Augmented Generation",
        author: "Patrick Lewis et al.",
        journal: "arXiv",
        date: "2024",
    },
    {
        id: "scherz-practical-2016",
        title: "Practical Electronics for Inventors",
        author: "Paul Scherz, Simon Monk",
        journal: "McGraw-Hill",
        date: "2016",
    },
    {
        id: "abelson-structure-1996",
        title: "Structure and Interpretation of Computer Programs",
        author: "Harold Abelson, Gerald Jay Sussman",
        journal: "MIT Press",
        date: "1996",
    },
];

const library = {
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

function App() {
    const [panel1Width, setPanel1Width] = useState(0.33);
    const [panel2Width, setPanel2Width] = useState(0.33);
    const [selectedNodeId, setSelectedNodeId] = useState('library');
    const [expandedNodeIds, setExpandedNodeIds] = useState<string[]>(['library']);
    const [selectedPublicationId, setSelectedPublicationId] = useState<string>(publications[0].id);
    const [focusedPanelIdx, setFocusedPanelIdx] = useState(0);

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
                                <div className={styles.panelContainer}
                                    data-selected={focusedPanelIdx == 0}
                                >
                                    <TreeView
                                        root={library}
                                        selectedNodeId={selectedNodeId}
                                        expandedNodeIds={expandedNodeIds}
                                        onToggleExpanded={(id: string) => {
                                            setExpandedNodeIds((prev) => (
                                                prev.includes(id)
                                                    ? prev.filter((expandedId) => expandedId !== id)
                                                    : [...prev, id]
                                            ));
                                        }}
                                        onSelectNode={(id) => {
                                            setFocusedPanelIdx(0);
                                            setSelectedNodeId(id);
                                        }}
                                    />
                                </div>
                            ),
                        },
                        {
                            width: panel2Width,
                            setWidth: setPanel2Width,
                            renderContent: () => (
                                <div
                                    className={styles.panelContainer}
                                    data-selected={focusedPanelIdx == 1}
                                >
                                    <PublicationList
                                        publications={publications}
                                        selectedPublicationId={selectedPublicationId}
                                        onSelectPublication={(id) => {
                                            setFocusedPanelIdx(1);
                                            setSelectedPublicationId(id)
                                        }}
                                    />
                                </div>
                            ),
                        }
                    ]}
                    renderLastPanelContent={() => (
                        <div
                            className={styles.panelContainer}
                            data-selected={focusedPanelIdx == 2}
                        >
                            <DetailView
                                journal={publications.find((pub) => pub.id === selectedPublicationId)?.journal || ''}
                                author={publications.find((pub) => pub.id === selectedPublicationId)?.author || ''}
                                date={publications.find((pub) => pub.id === selectedPublicationId)?.date || ''}
                                collection={publications.find((pub) => pub.id === selectedPublicationId)?.journal || ''}
                                filename={publications.find((pub) => pub.id === selectedPublicationId)?.title || ''}
                            />
                        </div>
                    )}
                />
            ),
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
