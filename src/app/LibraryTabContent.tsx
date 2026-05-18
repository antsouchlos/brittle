import { CSSProperties, Dispatch, SetStateAction, useMemo, useState } from 'react';
import { selectionFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { Group, Layout, Panel, Separator } from 'react-resizable-panels';
import styles from './LibraryTabContent.module.css';

export type EntryId = string;
export type CollectionId = string;

export interface Entry {
    id: EntryId;
    name: string;
}

export interface Collection {
    id: CollectionId;
    name: string;
    childCollectionIds: CollectionId[];
    entryIds: EntryId[];
}

export interface Library {
    rootId: CollectionId;
    entries: Map<EntryId, Entry>;
    collections: Map<CollectionId, Collection>;
}

const SYNTHETIC_TREE_ROOT_ID = '__library_tree_root__';
const SYNTHETIC_TREE_ROOT_NAME = 'Library Root';
const COLLECTION_TREE_ARIA_LABEL = 'Library collections';

function isRealCollectionId(library: Library, id: string): id is CollectionId {
    return library.collections.has(id);
}

/**
 * For every collection, the set of entries reachable within its subtree
 * (its own entries plus those of all descendants, deduplicated). Memoized
 * DFS: each collection is visited once, so total work is linear in tree
 * size even when the subcollection graph is a DAG with shared descendants.
 */
function computeReachableEntriesByCollection(library: Library): Map<CollectionId, Set<EntryId>> {
    const result = new Map<CollectionId, Set<EntryId>>();
    const entriesInSubtree = (collectionId: CollectionId): Set<EntryId> => {
        const memoized = result.get(collectionId);
        if (memoized) return memoized;
        const collection = library.collections.get(collectionId)!;
        const reachable = new Set<EntryId>(collection.entryIds);
        for (const childId of collection.childCollectionIds) {
            for (const entryId of entriesInSubtree(childId)) reachable.add(entryId);
        }
        result.set(collectionId, reachable);
        return reachable;
    };
    for (const collectionId of library.collections.keys()) entriesInSubtree(collectionId);
    return result;
}

interface CollectionTreeProps {
    library: Library;
    reachableEntriesByCollection: Map<CollectionId, Set<EntryId>>;
    expandedItems: string[];
    focusedItem: string | null;
    selectedItems: string[];
    setExpandedItems: Dispatch<SetStateAction<string[]>>;
    setFocusedItem: Dispatch<SetStateAction<string | null>>;
    setSelectedItems: Dispatch<SetStateAction<string[]>>;
}

function CollectionTree({
    library,
    reachableEntriesByCollection,
    expandedItems,
    focusedItem,
    selectedItems,
    setExpandedItems,
    setFocusedItem,
    setSelectedItems,
}: CollectionTreeProps) {
    const collectionsWithSyntheticRoot = useMemo(() => {
        const map = new Map(library.collections);
        map.set(SYNTHETIC_TREE_ROOT_ID, {
            id: SYNTHETIC_TREE_ROOT_ID,
            name: SYNTHETIC_TREE_ROOT_NAME,
            childCollectionIds: [library.rootId],
            entryIds: [],
        });
        return map;
    }, [library]);

    const tree = useTree<Collection>({
        rootItemId: SYNTHETIC_TREE_ROOT_ID,
        state: { expandedItems, focusedItem, selectedItems },
        setExpandedItems,
        setFocusedItem,
        setSelectedItems,
        getItemName: (item) => item.getItemData().name,
        isItemFolder: (item) => item.getItemData().childCollectionIds.length > 0,
        dataLoader: {
            getItem: (itemId) => {
                const collection = collectionsWithSyntheticRoot.get(itemId);
                if (!collection) throw new Error(`Unknown collection: ${itemId}`);
                return collection;
            },
            getChildren: (itemId) => collectionsWithSyntheticRoot.get(itemId)?.childCollectionIds ?? [],
        },
        features: [syncDataLoaderFeature, selectionFeature],
    });

    return (
        <div {...tree.getContainerProps(COLLECTION_TREE_ARIA_LABEL)} className={styles.collectionTree}>
            {tree.getItems().map((item) => {
                const collection = item.getItemData();
                const levelStyle = {
                    '--collection-tree-level': item.getItemMeta().level,
                } as CSSProperties;

                return (
                    <button
                        {...item.getProps()}
                        key={item.getId()}
                        className={styles.collectionTreeItem}
                        data-expanded={item.isExpanded() || undefined}
                        data-focused={item.isFocused() || undefined}
                        data-selected={item.isSelected() || undefined}
                        style={levelStyle}
                        type="button"
                    >
                        <span className={styles.collectionTreeIndent} />
                        <span className={styles.collectionTreeDisclosure} aria-hidden="true">
                            {item.isFolder()
                                ? item.isExpanded() ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                                : null}
                        </span>
                        <Folder className={styles.collectionTreeIcon} size={15} aria-hidden="true" />
                        <span className={styles.collectionTreeLabel}>{collection.name}</span>
                        <span className={styles.collectionTreeCount}>{reachableEntriesByCollection.get(collection.id)?.size ?? 0}</span>
                    </button>
                );
            })}
        </div>
    );
}

export const libraryPanelIds = {
    collections: 'library-collections',
    viewer: 'library-viewer',
    details: 'library-details',
} as const;

interface LibraryTabContentProps {
    library: Library;
    panelLayout: Layout;
    onPanelLayoutChange: (layout: Layout) => void;
}

function LibraryTabContent({ library, panelLayout, onPanelLayoutChange }: LibraryTabContentProps) {
    const [expandedItems, setExpandedItems] = useState<string[]>([library.rootId]);
    const [focusedItem, setFocusedItem] = useState<string | null>(library.rootId);
    const [selectedItems, setSelectedItems] = useState<string[]>([library.rootId]);
    const reachableEntriesByCollection = useMemo(
        () => computeReachableEntriesByCollection(library),
        [library],
    );
    const firstSelected = selectedItems[0];
    const selectedCollectionId: CollectionId = firstSelected && isRealCollectionId(library, firstSelected)
        ? firstSelected
        : library.rootId;
    const selectedCollection = library.collections.get(selectedCollectionId)!;
    const selectedEntryCount = reachableEntriesByCollection.get(selectedCollectionId)?.size ?? 0;

    return (
        <Group
            className={styles.libraryGroup}
            defaultLayout={panelLayout}
            onLayoutChanged={onPanelLayoutChange}
        >
            <Panel id={libraryPanelIds.collections} minSize={15}>
                <div className={styles.libraryPane}>
                    <CollectionTree
                        library={library}
                        reachableEntriesByCollection={reachableEntriesByCollection}
                        expandedItems={expandedItems}
                        focusedItem={focusedItem}
                        selectedItems={selectedItems}
                        setExpandedItems={setExpandedItems}
                        setFocusedItem={setFocusedItem}
                        setSelectedItems={setSelectedItems}
                    />
                </div>
            </Panel>
            <Separator className={styles.panelSeparator} />
            <Panel id={libraryPanelIds.viewer} minSize={20}>
                <div className={styles.viewerPane}>
                    <div className={styles.viewerTitle}>{selectedCollection.name}</div>
                    <div className={styles.viewerMeta}>{selectedEntryCount} entries in this collection subtree</div>
                </div>
            </Panel>
            <Separator className={styles.panelSeparator} />
            <Panel id={libraryPanelIds.details} minSize={15}>
                <div className={styles.detailsPane}>Details / metadata panel</div>
            </Panel>
        </Group>
    );
}

export default LibraryTabContent;
