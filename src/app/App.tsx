import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { LibraryModel, Library, Metadata } from './LibraryModel';
import { logger } from './logger';

import styles from './App.module.css'
import './App.css';
import TabView from '../components/TabView.tsx';
import type { TabData } from '../components/TabView.tsx';
import HorizontalPanelLayout from '../components/HorizontalPanelLayout.tsx';
import TreeView from '../components/TreeView.tsx';

// import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import PublicationList from '../components/PublicationList.tsx';
import DetailView from '../components/DetailView.tsx';

import { KeymapStateMachine, normalizeKeyEvent } from './KeymapStateMachine.ts'
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import CmdLine from '../components/CmdLine.tsx';
import { ToastProvider, ToastContainer } from '../components/Toast';

// const samplePdfConfig = {
//     src: 'https://snippet.embedpdf.com/ebook.pdf',
//     theme: { preference: 'dark' as const },
// };
// const pdfStyle = { width: '100%', height: '100%' };

enum Action {
    MoveLeft,
    MoveRight,
    MoveUp,
    MoveDown,
    NextTab,
    PrevTab,
    Submit,
    OpenCmdLine,
    OpenFuzzyFind,
}

const keymap: Array<[string, Action]> = [
    ["h", Action.MoveLeft],
    ["l", Action.MoveRight],
    ["k", Action.MoveUp],
    ["j", Action.MoveDown],
    ["gt", Action.NextTab],
    ["gT", Action.PrevTab],
    ["Enter", Action.Submit],
    [":", Action.OpenCmdLine],
    [" ff", Action.OpenFuzzyFind],
];

function App() {
    const [panel1Width, setPanel1Width] = useState(0.25);
    const [panel2Width, setPanel2Width] = useState(0.4);
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [expandedNodeIds, setExpandedNodeIds] = useState<string[]>([]);
    const [selectedPublicationId, setSelectedPublicationId] = useState<string | null>(null);
    const [focusedPanelIdx, setFocusedPanelIdx] = useState(0);
    const [bibTextAreaFocused, setBibTextAreaFocused] = useState(false);

    const [lib, setLib] = useState<LibraryModel | null>(null);
    const [pubMetadata, setPubMetadata] = useState<Record<string, Metadata>>({});
    const [cmdLineVisible, setCmdLineVisible] = useState(false);
    const [fuzzyFindVisible, setFuzzyFindVisible] = useState(false);
    const [commandList, setCommandList] = useState<string[]>([]);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const historyLoadedRef = useRef(false);

    const handlePublicationSubmit = () => {
        if (!selectedPublicationId) return;
        invoke('open_publication', { pubId: selectedPublicationId })
            .catch(e => logger.error(String(e)));
    };

    const prevSelectedPubId = useRef(selectedPublicationId);
    const prevSelectedNodeId = useRef(selectedNodeId);
    const prevExpandedNodeIds = useRef(expandedNodeIds);

    useEffect(() => {
        prevSelectedPubId.current = selectedPublicationId;
        prevSelectedNodeId.current = selectedNodeId;
        prevExpandedNodeIds.current = expandedNodeIds;
    });

    const loadCommandList = useCallback(() => {
        invoke<string[]>('list_commands')
            .then(setCommandList)
            .catch(e => logger.error(`Failed to list commands: ${e}`));
    }, []);

    const loadCommandHistory = useCallback(() => {
        invoke<string[]>('load_command_history')
            .then(history => setCommandHistory(history))
            .catch(e => logger.error(`Failed to load command history: ${e}`))
            .finally(() => { historyLoadedRef.current = true; });
    }, []);

    const loadLibraryData = useCallback(async () => {
        const data = await invoke<Library>('load_library');
        const model = new LibraryModel(data);
        setLib(model);

        const rootId = model.rootId;

        const nodeId = prevSelectedNodeId.current && model.directories[prevSelectedNodeId.current]
            ? prevSelectedNodeId.current
            : rootId;
        setSelectedNodeId(nodeId);

        const expIds = prevExpandedNodeIds.current.filter(id => model.directories[id]);
        setExpandedNodeIds(expIds.length > 0 ? expIds : (rootId ? [rootId] : []));

        const ids = Object.keys(data.publications);
        const metas = await Promise.all(
            ids.map(id => invoke<Metadata>('parse_publication', { id }))
        );
        const metaMap: Record<string, Metadata> = {};
        ids.forEach((id, i) => { metaMap[id] = metas[i]; });
        setPubMetadata(metaMap);

        const pubId = prevSelectedPubId.current && data.publications[prevSelectedPubId.current]
            ? prevSelectedPubId.current
            : (ids.length > 0 ? ids[0] : null);
        setSelectedPublicationId(pubId);
    }, []);

    const libRef = useRef<LibraryModel | null>(null);

    useEffect(() => {
        libRef.current = lib;
    }, [lib]);

    const refreshPubMetadata = useCallback(async () => {
        const currentLib = libRef.current;
        if (!currentLib) return;

        const ids = Object.keys(currentLib.publications);
        const metas = await Promise.all(
            ids.map(id => invoke<Metadata>('parse_publication', { id }))
        );
        const metaMap: Record<string, Metadata> = {};

        ids.forEach((id, i) => { metaMap[id] = metas[i]; });
        setPubMetadata(metaMap);
    }, []);

    useEffect(() => {
        loadLibraryData().catch(e => logger.error(String(e)));
        loadCommandList();
        loadCommandHistory();

        const libraryChanged = listen('library-changed', () => {
            loadLibraryData().catch(e => logger.error(String(e)));
        });
        const configChanged = listen('config-changed', () => {
            loadLibraryData().catch(e => logger.error(String(e)));
            loadCommandList();
            loadCommandHistory();
        });
        const metadataChanged = listen('publication-metadata-changed', () => {
            refreshPubMetadata().catch(e => logger.error(String(e)));
        });
        const configError = listen('config-reload-error', (event) => {
            logger.error(String(event.payload));
        });

        return () => {
            libraryChanged.then(unlisten => unlisten());
            configChanged.then(unlisten => unlisten());
            metadataChanged.then(unlisten => unlisten());
            configError.then(unlisten => unlisten());
        };
    }, [loadLibraryData, loadCommandList, loadCommandHistory, refreshPubMetadata]);

    const treeRoot = useMemo(() => {
        if (!lib) return null;
        return lib.buildTree(lib.rootId);
    }, [lib]);

    const visiblePubIds = useMemo(() => {
        if (!lib || !selectedNodeId) return [];
        return lib.collectPubIds(selectedNodeId);
    }, [lib, selectedNodeId]);

    const publicationListItems = useMemo(() => {
        return visiblePubIds
            .filter(id => pubMetadata[id])
            .map(id => ({
                id,
                title: pubMetadata[id].title,
                author: pubMetadata[id].author,
                publisher: pubMetadata[id].publisher,
                date: String(pubMetadata[id].year),
            }));
    }, [visiblePubIds, pubMetadata]);

    const selectedMeta = selectedPublicationId ? pubMetadata[selectedPublicationId] ?? null : null;
    const selectedPub = selectedPublicationId && lib
        ? lib.publications[selectedPublicationId] ?? null
        : null;

    const fixedTabs: TabData[] = [
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
                                    {treeRoot && selectedNodeId && (
                                        <TreeView
                                            root={treeRoot}
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
                                    )}
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
                                        publications={publicationListItems}
                                        selectedPublicationId={selectedPublicationId ?? ''}
                                        onSelectPublication={(id) => {
                                            setFocusedPanelIdx(1);
                                            setSelectedPublicationId(id)
                                        }}
                                        fuzzyFindVisible={fuzzyFindVisible}
                                        isActive={focusedPanelIdx === 1 && selectedTabId === 'Lib'}
                                        onCloseFuzzyFind={() => setFuzzyFindVisible(false)}
                                        onSubmit={handlePublicationSubmit}
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
                                publisher={selectedMeta?.publisher ?? ''}
                                title={selectedMeta?.title ?? ''}
                                author={selectedMeta?.author ?? ''}
                                date={selectedMeta?.year ? String(selectedMeta.year) : ''}
                                collection={selectedPub ? lib!.nameOf(selectedPub.parentDirectoryId) : ''}
                                filename={selectedPub ? lib!.nameOf(selectedPub.extensionlessPath) : ''}
                                bibSource={selectedPub?.bibSource ?? ''}
                                bibTextAreaFocused={bibTextAreaFocused}
                                setBibTextAreaFocused={(val: boolean) => {
                                    setBibTextAreaFocused(val);
                                    if (val) {
                                        setFocusedPanelIdx(2);
                                    }
                                }}
                            />
                        </div>
                    )}
                />
            ),
        },
    ];

    const [selectedTabId, setSelectedTabId] = useState(fixedTabs[0].id);

    const [variableTabs, setVariableTabs] = useState<TabData[]>(() => [
        // {
        //     id: 'A', label: 'A.pdf', renderContent: () => (
        //         <PDFViewer style={pdfStyle} config={samplePdfConfig} />
        //     )
        // },
        // {
        //     id: 'B', label: 'B.pdf', renderContent: () => (
        //         <PDFViewer style={pdfStyle} config={samplePdfConfig} />
        //     )
        // },
        // {
        //     id: 'C', label: 'C.pdf', renderContent: () => (
        //         <PDFViewer style={pdfStyle} config={samplePdfConfig} />
        //     )
        // },
    ]);

    const stateMachine = useRef(new KeymapStateMachine(keymap));

    // TODO: Extract this into separate hook
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement;
            if (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable
            ) {
                return;
            }

            if (event.ctrlKey && event.key === 'c') {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            let normalized_key = normalizeKeyEvent(event);
            if (normalized_key === null) {
                return;
            }

            let action: Action | null = stateMachine.current.feed(normalized_key);

            if (action == Action.MoveDown) {
                if (focusedPanelIdx == 0) {
                    if (!lib) return;
                    const visibleIds = lib.visibleNodeIds(lib.rootId, expandedNodeIds);
                    if (visibleIds.length === 0 || !selectedNodeId) return;
                    const currentIdx = visibleIds.indexOf(selectedNodeId);
                    const nextIdx = (currentIdx + 1) % visibleIds.length;
                    setSelectedNodeId(visibleIds[nextIdx]);
                } else if (focusedPanelIdx == 1) {
                    if (publicationListItems.length === 0) return;
                    const currentIdx = publicationListItems.findIndex(p => p.id === selectedPublicationId);
                    const startIdx = currentIdx < 0 ? 0 : currentIdx;
                    const nextIdx = (startIdx + 1) % publicationListItems.length;
                    setSelectedPublicationId(publicationListItems[nextIdx].id);
                }
            } else if (action == Action.MoveUp) {
                if (focusedPanelIdx == 0) {
                    if (!lib) return;
                    const visibleIds = lib.visibleNodeIds(lib.rootId, expandedNodeIds);
                    if (visibleIds.length === 0 || !selectedNodeId) return;
                    const currentIdx = visibleIds.indexOf(selectedNodeId);
                    const prevIdx = (currentIdx - 1 + visibleIds.length) % visibleIds.length;
                    setSelectedNodeId(visibleIds[prevIdx]);
                } else if (focusedPanelIdx == 1) {
                    if (publicationListItems.length === 0) return;
                    const currentIdx = publicationListItems.findIndex(p => p.id === selectedPublicationId);
                    const startIdx = currentIdx < 0 ? 0 : currentIdx;
                    const prevIdx = (startIdx - 1 + publicationListItems.length) % publicationListItems.length;
                    setSelectedPublicationId(publicationListItems[prevIdx].id);
                }
            } else if (action == Action.MoveLeft) {
                setFocusedPanelIdx((focusedPanelIdx + 3 - 1) % 3)
            } else if (action == Action.MoveRight) {
                setFocusedPanelIdx((focusedPanelIdx + 1) % 3)
            } else if (action == Action.NextTab) {
                const allTabIds = [...fixedTabs.map(t => t.id), ...variableTabs.map(t => t.id)];
                const currentIdx = allTabIds.indexOf(selectedTabId);
                const nextIdx = (currentIdx + 1) % allTabIds.length;
                setSelectedTabId(allTabIds[nextIdx]);
            } else if (action == Action.PrevTab) {
                const allTabIds = [...fixedTabs.map(t => t.id), ...variableTabs.map(t => t.id)];
                const currentIdx = allTabIds.indexOf(selectedTabId);
                const prevIdx = (currentIdx - 1 + allTabIds.length) % allTabIds.length;
                setSelectedTabId(allTabIds[prevIdx]);
            } else if (action == Action.Submit) {
                if (focusedPanelIdx == 0) {
                    if (lib && selectedNodeId) {
                        const dir = lib.directories[selectedNodeId];
                        if (dir && dir.childDirectoryIds.length > 0) {
                            setExpandedNodeIds((prev) => (
                                prev.includes(selectedNodeId)
                                    ? prev.filter((id) => id !== selectedNodeId)
                                    : [...prev, selectedNodeId]
                            ));
                        }
                    }
                } else if (focusedPanelIdx == 1) {
                    handlePublicationSubmit();
                } else if (focusedPanelIdx == 2) {
                    setBibTextAreaFocused(true);
                }
            } else if (action == Action.OpenCmdLine) {
                stateMachine.current.abort();
                setCmdLineVisible(true);
            } else if (action == Action.OpenFuzzyFind) {
                setFuzzyFindVisible(true);
                setFocusedPanelIdx(1);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [focusedPanelIdx, selectedTabId, fixedTabs, variableTabs, lib,
        selectedNodeId, expandedNodeIds, selectedPublicationId,
        publicationListItems, pubMetadata]);

    const handleCmd = (cmdLine: string) => {
        const spaceIdx = cmdLine.indexOf(' ');
        const cmd = spaceIdx === -1 ? cmdLine : cmdLine.slice(0, spaceIdx);
        const args = spaceIdx === -1 ? '' : cmdLine.slice(spaceIdx + 1);

        invoke<string>('execute_command', { cmd, args })
            .then(message => { if (message) logger.info(message); })
            .catch(e => logger.error(String(e)));
        setCmdLineVisible(false);

        setCommandHistory(prevHistory => {
            if (prevHistory.length > 0 && prevHistory[prevHistory.length - 1] === cmdLine) return prevHistory;
            return [...prevHistory, cmdLine];
        });
    };

    useEffect(() => {
        if (!historyLoadedRef.current) return;
        invoke('save_command_history', { history: commandHistory })
            .catch(e => logger.error(`Failed to save command history: ${e}`));
    }, [commandHistory]);

    return (
        <ToastProvider>
        <div className={styles.appWrapper}>
            <div className={styles.mainContent}>
                <ToastContainer />
                <TabView
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
                            logger.error("Could not find closed tab id");
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
                />
            </div>
            <CmdLine
                visible={cmdLineVisible}
                onExecute={handleCmd}
                onCancel={() => setCmdLineVisible(false)}
                suggestions={commandList}
                commandHistory={commandHistory}
            />
        </div>
        </ToastProvider>
    );
}

export default App;
