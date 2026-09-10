import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { LibraryModel, LibraryState, Publication, PublicationId, CollectionId } from './LibraryModel';
import {
    applyCollectionRemoved,
    applyCollectionUpserted,
    applyPublicationRemoved,
    applyPublicationUpserted,
    CollectionRemoved,
    CollectionUpserted,
    PublicationRemoved,
    PublicationUpserted,
} from './libraryUpdates.ts';
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
import { Action, ActionProvider, keymap, useActionDispatch } from './actions.tsx';
import { ConfigProvider } from './config.tsx';
import { UiStateProvider, useRestoredState } from './uiState.tsx';

// const samplePdfConfig = {
//     src: 'https://snippet.embedpdf.com/ebook.pdf',
//     theme: { preference: 'dark' as const },
// };
// const pdfStyle = { width: '100%', height: '100%' };

const DEFAULT_LIBRARY_PANEL_WIDTHS = [0.25, 0.4];

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

function useGlobalKeymap() {
    const dispatch = useActionDispatch();
    const stateMachine = useRef(new KeymapStateMachine(keymap));

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.key === 'c') {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const normalizedKey = normalizeKeyEvent(event);
            if (normalizedKey === null) {
                return;
            }

            const action = stateMachine.current.feed(normalizedKey);
            if (action === null) {
                return;
            }

            // Opening a text surface takes over the keyboard, so drop any
            // half-typed key sequence before handing the action over.
            if (action === Action.OpenCmdLine || action === Action.OpenFuzzyFind) {
                stateMachine.current.abort();
            }

            dispatch(action);
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [dispatch]);
}

// Loads the library and keeps it in sync with the backend.
function useLibrary(): LibraryModel | null {
    const [state, setState] = useState<LibraryState | null>(null);

    const loadLibraryData = useCallback(async () => {
        setState(await invoke<LibraryState>('get_library_state'));
    }, []);

    useEffect(() => {
        loadLibraryData().catch(e => logger.error(String(e)));

        const applyEvent = <T,>(apply: (state: LibraryState, event: T) => LibraryState) =>
            (event: { payload: T }) =>
                setState(current => (current ? apply(current, event.payload) : current));

        const unlisteners = [
            listen('library-changed', () => {
                loadLibraryData().catch(e => logger.error(String(e)));
            }),
            listen<PublicationUpserted>(
                'publication-upserted',
                applyEvent(applyPublicationUpserted),
            ),
            listen<PublicationRemoved>('publication-removed', applyEvent(applyPublicationRemoved)),
            listen<CollectionUpserted>('collection-upserted', applyEvent(applyCollectionUpserted)),
            listen<CollectionRemoved>('collection-removed', applyEvent(applyCollectionRemoved)),
        ];

        return () => {
            for (const unlistener of unlisteners) {
                unlistener.then(unlisten => unlisten());
            }
        };
    }, [loadLibraryData]);

    return useMemo(() => (state ? new LibraryModel(state) : null), [state]);
}

function Workspace() {
    useGlobalKeymap();

    const lib = useLibrary();

    const [selectedCollectionId, setSelectedCollectionId] =
        useRestoredState<CollectionId | null>('selection.collection', null);
    const [selectedPublicationId, setSelectedPublicationId] =
        useRestoredState<PublicationId | null>('selection.publication', null);

    // A restored or previously selected collection can disappear when the
    // library is rescanned.
    useEffect(() => {
        if (!lib) return;
        if (selectedCollectionId && lib.getCollection(selectedCollectionId)) return;
        setSelectedCollectionId(lib.rootId);
    }, [lib, selectedCollectionId, setSelectedCollectionId]);

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
                    defaultWidths={DEFAULT_LIBRARY_PANEL_WIDTHS}
                    persistKey="panels.library.widths"
                    firstPanelsData={[
                        {
                            renderContent: () => (
                                <div className={styles.panelContainer}>
                                    {treeRoot && selectedCollectionId && (
                                        <TreeView
                                            root={treeRoot}
                                            selectedNodeId={selectedCollectionId}
                                            onSelectNode={setSelectedCollectionId}
                                            persistKey="tree.library.expanded"
                                        />
                                    )}
                                </div>
                            ),
                        },
                        {
                            renderContent: () => (
                                <div
                                    className={styles.panelContainer}
                                >
                                    <PublicationList
                                        publications={publicationListItems}
                                        selectedPublicationId={selectedPublicationId ?? ''}
                                        onSelectPublication={setSelectedPublicationId}
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
                            />
                        </div>
                    )}
                />
            ),
        },
    ];

    const [variableTabs, setVariableTabs] = useState<TabData[]>(() => [
        // {
        //     id: 'A', label: 'A.pdf', renderContent: () => (
        //         <PDFViewer style={pdfStyle} config={samplePdfConfig} />
        //     )
        // },
    ]);

    return (
        <div className={styles.appWrapper}>
            <div className={styles.mainContent}>
                <ToastContainer />
                <TabView
                    fixedTabs={fixedTabs}
                    variableTabs={variableTabs}
                    onCloseTab={(id: string) => {
                        setVariableTabs(prev => prev.filter((tab) => tab.id !== id));
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
            <CmdLine />
        </div>
    );
}

function App() {
    return (
        <ToastProvider>
            <ConfigProvider>
                <UiStateProvider>
                    <ActionProvider>
                        <Workspace />
                    </ActionProvider>
                </UiStateProvider>
            </ConfigProvider>
        </ToastProvider>
    );
}

export default App;
