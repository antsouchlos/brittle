import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { LibraryModel, LibraryState, Publication, PublicationId, CollectionId } from './LibraryModel';
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
    SelectNextCollection,
    SelectPrevCollection,
    SelectNextPublication,
    SelectPrevPublication,
    NextTab,
    PrevTab,
    OpenSelectedPublication,
    OpenCmdLine,
    OpenFuzzyFind,
    CloseFuzzyFind,
    FocusBibEditor,
}

const keymap: Array<[string, Action]> = [
    ["Tab", Action.SelectNextCollection],
    ["Shift+Tab", Action.SelectPrevCollection],
    ["j", Action.SelectNextPublication],
    ["k", Action.SelectPrevPublication],
    ["Ctrl+n", Action.SelectNextPublication],
    ["Ctrl+p", Action.SelectPrevPublication],
    ["gt", Action.NextTab],
    ["gT", Action.PrevTab],
    ["Enter", Action.OpenSelectedPublication],
    ["Ctrl+e", Action.FocusBibEditor],
    [":", Action.OpenCmdLine],
    [" ff", Action.OpenFuzzyFind],
    ["Escape", Action.CloseFuzzyFind],
];

// Selects the first visible publication whenever the current selection is no
// longer part of the collection shown in the publication list.
function useNewPublicationSelectOnHidden(
    selectedPublicationId: PublicationId | null,
    visiblePublicationIds: PublicationId[],
    onSelectPublication: (publicationId: PublicationId | null) => void,
) {
    useEffect(() => {
        if (selectedPublicationId && visiblePublicationIds.includes(selectedPublicationId)) return;
        onSelectPublication(visiblePublicationIds[0] ?? null);
    }, [selectedPublicationId, visiblePublicationIds, onSelectPublication]);
}

function App() {
    const [panel1Width, setPanel1Width] = useState(0.25);
    const [panel2Width, setPanel2Width] = useState(0.4);
    const [selectedCollectionId, setSelectedCollectionId] = useState<CollectionId | null>(null);
    const [expandedCollectionIds, setExpandedCollectionIds] = useState<CollectionId[]>([]);
    const [selectedPublicationId, setSelectedPublicationId] = useState<PublicationId | null>(null);
    const [bibEditorFocused, setBibEditorFocused] = useState(false);

    const [lib, setLib] = useState<LibraryModel | null>(null);
    const [autosaveDebounceMs, setAutosaveDebounceMs] = useState(250);
    const [cmdLineVisible, setCmdLineVisible] = useState(false);
    const [fuzzyFindVisible, setFuzzyFindVisible] = useState(false);
    const [publicationNavRequest, setPublicationNavRequest] = useState<{ delta: 1 | -1 } | null>(null);
    const [commandList, setCommandList] = useState<string[]>([]);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const historyLoadedRef = useRef(false);

    const handlePublicationSubmit = () => {
        if (!selectedPublicationId) return;
        invoke('open_publication', { publicationId: selectedPublicationId })
            .catch(e => logger.error(String(e)));
    };

    const prevSelectedPublicationId = useRef(selectedPublicationId);
    const prevSelectedCollectionId = useRef(selectedCollectionId);
    const prevExpandedCollectionIds = useRef(expandedCollectionIds);

    useEffect(() => {
        prevSelectedPublicationId.current = selectedPublicationId;
        prevSelectedCollectionId.current = selectedCollectionId;
        prevExpandedCollectionIds.current = expandedCollectionIds;
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

    const loadConfig = useCallback(() => {
        invoke<{ opts: { autosaveDebounceMs: number } }>('get_config')
            .then(config => setAutosaveDebounceMs(config.opts.autosaveDebounceMs))
            .catch(e => logger.error(`Failed to load config: ${e}`));
    }, []);

    const loadLibraryData = useCallback(async () => {
        const state = await invoke<LibraryState>('get_library_state');

        const model = new LibraryModel(state);
        setLib(model);

        const rootId = model.rootId;

        const collectionId = prevSelectedCollectionId.current && model.getCollection(prevSelectedCollectionId.current)
            ? prevSelectedCollectionId.current
            : rootId;
        setSelectedCollectionId(collectionId);

        const expandedIds = prevExpandedCollectionIds.current.filter(id => model.getCollection(id));
        setExpandedCollectionIds(expandedIds.length > 0 ? expandedIds : (rootId ? [rootId] : []));

        const publicationIds = Object.keys(state.publications);
        const publicationId = prevSelectedPublicationId.current && state.publications[prevSelectedPublicationId.current]
            ? prevSelectedPublicationId.current
            : (publicationIds.length > 0 ? publicationIds[0] : null);
        setSelectedPublicationId(publicationId);
    }, []);

    useEffect(() => {
        loadLibraryData().catch(e => logger.error(String(e)));
        loadCommandList();
        loadCommandHistory();
        loadConfig();

        const libraryChanged = listen('library-changed', () => {
            loadLibraryData().catch(e => logger.error(String(e)));
        });
        const configChanged = listen('config-changed', () => {
            loadLibraryData().catch(e => logger.error(String(e)));
            loadCommandList();
            loadCommandHistory();
            loadConfig();
        });
        const metadataChanged = listen('publication-metadata-changed', () => {
            loadLibraryData().catch(e => logger.error(String(e)));
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
    }, [loadLibraryData, loadCommandList, loadCommandHistory, loadConfig]);

    const treeRoot = useMemo(() => {
        if (!lib) return null;
        return lib.buildTree(lib.rootId);
    }, [lib]);

    const visiblePublicationIds = useMemo(() => {
        if (!lib || !selectedCollectionId) return [];
        return lib.collectPublicationIds(selectedCollectionId);
    }, [lib, selectedCollectionId]);

    useNewPublicationSelectOnHidden(
        selectedPublicationId,
        visiblePublicationIds,
        setSelectedPublicationId,
    );

    const publicationListItems = useMemo(() => {
        if (!lib) return [];
        return visiblePublicationIds
            .map(publicationId => ({ publicationId, publication: lib.publications[publicationId] }))
            .filter(({ publication }) => publication?.metadata)
            .map(({ publicationId, publication }) => ({
                id: publicationId,
                title: publication.metadata!.title,
                author: publication.metadata!.authors,
                publisher: publication.metadata!.publisher,
                date: String(publication.metadata!.year),
                filename: publication.name,
                contentFiles: publication.availableContentFileExtensions,
            }));
    }, [visiblePublicationIds, lib]);

    const selectedPublication: Publication | null = selectedPublicationId && lib
        ? lib.publications[selectedPublicationId] ?? null
        : null;
    const selectedPublicationCollectionName = selectedPublicationId && lib
        ? lib.getCollection(lib.publicationParents[selectedPublicationId])?.name ?? ''
        : '';

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
                                <div className={styles.panelContainer}>
                                    {treeRoot && selectedCollectionId && (
                                        <TreeView
                                            root={treeRoot}
                                            selectedNodeId={selectedCollectionId}
                                            expandedNodeIds={expandedCollectionIds}
                                            onToggleExpanded={(id: string) => {
                                                setExpandedCollectionIds((prev) => (
                                                    prev.includes(id)
                                                        ? prev.filter((expandedId) => expandedId !== id)
                                                        : [...prev, id]
                                                ));
                                            }}
                                            onSelectNode={(id) => {
                                                setSelectedCollectionId(id);
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
                                >
                                    <PublicationList
                                        publications={publicationListItems}
                                        selectedPublicationId={selectedPublicationId ?? ''}
                                        onSelectPublication={(publicationId) => {
                                            setSelectedPublicationId(publicationId)
                                        }}
                                        fuzzyFindVisible={fuzzyFindVisible}
                                        isActive={selectedTabId === 'Lib'}
                                        publicationNavRequest={publicationNavRequest}
                                    />
                                </div>
                            ),
                        }
                    ]}
                    renderLastPanelContent={() => (
                        <div
                            className={styles.panelContainer}
                        >
                            <DetailView
                                publicationId={selectedPublicationId}
                                publication={selectedPublication}
                                collectionName={selectedPublicationCollectionName}
                                bibEditorFocused={bibEditorFocused}
                                onBibEditorFocusedChange={setBibEditorFocused}
                                autosaveDebounceMs={autosaveDebounceMs}
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
            if (action == null) {
                return;
            }

            if (action == Action.SelectNextCollection) {
                if (selectedTabId !== 'Lib' || !lib) return;
                const visibleIds = lib.visibleNodeIds(lib.rootId, expandedCollectionIds);
                if (visibleIds.length === 0 || !selectedCollectionId) return;
                const currentIdx = visibleIds.indexOf(selectedCollectionId);
                const nextIdx = (currentIdx + 1) % visibleIds.length;
                setSelectedCollectionId(visibleIds[nextIdx]);
            } else if (action == Action.SelectPrevCollection) {
                if (selectedTabId !== 'Lib' || !lib) return;
                const visibleIds = lib.visibleNodeIds(lib.rootId, expandedCollectionIds);
                if (visibleIds.length === 0 || !selectedCollectionId) return;
                const currentIdx = visibleIds.indexOf(selectedCollectionId);
                const prevIdx = (currentIdx - 1 + visibleIds.length) % visibleIds.length;
                setSelectedCollectionId(visibleIds[prevIdx]);
            } else if (action == Action.SelectNextPublication) {
                if (selectedTabId !== 'Lib') return;
                setPublicationNavRequest({ delta: 1 });
            } else if (action == Action.SelectPrevPublication) {
                if (selectedTabId !== 'Lib') return;
                setPublicationNavRequest({ delta: -1 });
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
            } else if (action == Action.OpenSelectedPublication) {
                if (selectedTabId !== 'Lib') return;
                handlePublicationSubmit();
            } else if (action == Action.OpenCmdLine) {
                stateMachine.current.abort();
                setCmdLineVisible(true);
            } else if (action == Action.OpenFuzzyFind) {
                if (selectedTabId !== 'Lib') return;
                stateMachine.current.abort();
                setFuzzyFindVisible(true);
            } else if (action == Action.CloseFuzzyFind) {
                if (selectedTabId !== 'Lib' || !fuzzyFindVisible) return;
                setFuzzyFindVisible(false);
            } else if (action == Action.FocusBibEditor) {
                if (selectedTabId !== 'Lib') return;
                setBibEditorFocused(true);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [selectedTabId, fixedTabs, variableTabs, lib,
        selectedCollectionId, expandedCollectionIds, fuzzyFindVisible, handlePublicationSubmit]);

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
