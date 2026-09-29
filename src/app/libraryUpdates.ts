import {
    Collection,
    CollectionId,
    LibraryState,
    Publication,
    PublicationId,
} from './LibraryModel.tsx';

export type PublicationChangeOrigin =
    | 'metadataEditor'
    | 'disk'
    | 'referencePreviewCompiler'
    | 'notes'
    | 'notesEditor'
    | 'tags';

export interface PublicationUpserted {
    publicationId: PublicationId;
    parentCollectionId: CollectionId;
    publication: Publication;
    origin: PublicationChangeOrigin;
}

export interface PublicationRemoved {
    publicationId: PublicationId;
}

// `subtree` is a scan of one directory: its `root*` fields describe the
// collection itself, its maps hold everything below it.
export interface CollectionUpserted {
    parentCollectionId: CollectionId;
    subtree: LibraryState;
}

export interface CollectionRemoved {
    collectionId: CollectionId;
}

// The root collection lives in the `root*` fields rather than in `collections`,
// so every child-list edit goes through here to stay agnostic of which it is.
function updateCollection(
    state: LibraryState,
    collectionId: CollectionId,
    update: (collection: Collection) => Collection,
): LibraryState {
    if (collectionId === state.rootCollectionId) {
        const updated = update({
            name: state.rootCollectionName,
            childPublicationIds: state.rootChildPublicationIds,
            childCollectionIds: state.rootChildCollectionIds,
        });

        return {
            ...state,
            rootChildPublicationIds: updated.childPublicationIds,
            rootChildCollectionIds: updated.childCollectionIds,
        };
    }

    const collection = state.collections[collectionId];
    if (!collection) return state;

    return {
        ...state,
        collections: { ...state.collections, [collectionId]: update(collection) },
    };
}

function findPublicationParent(
    state: LibraryState,
    publicationId: PublicationId,
): CollectionId | null {
    if (state.rootChildPublicationIds.includes(publicationId)) return state.rootCollectionId;

    for (const [collectionId, collection] of Object.entries(state.collections)) {
        if (collection.childPublicationIds.includes(publicationId)) return collectionId;
    }

    return null;
}

function findCollectionParent(
    state: LibraryState,
    collectionId: CollectionId,
): CollectionId | null {
    if (state.rootChildCollectionIds.includes(collectionId)) return state.rootCollectionId;

    for (const [candidateId, collection] of Object.entries(state.collections)) {
        if (collection.childCollectionIds.includes(collectionId)) return candidateId;
    }

    return null;
}

function omitKeys<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
    const remaining = { ...record };
    for (const key of keys) {
        delete remaining[key];
    }

    return remaining;
}

// Walks the collection and everything below it, so a removal takes its
// descendants with it instead of orphaning them in the maps.
function collectSubtreeIds(
    state: LibraryState,
    collectionId: CollectionId,
): { collectionIds: CollectionId[]; publicationIds: PublicationId[] } {
    const collectionIds: CollectionId[] = [];
    const publicationIds: PublicationId[] = [];
    const pending: CollectionId[] = [collectionId];

    while (pending.length > 0) {
        const id = pending.pop()!;
        const collection = state.collections[id];
        if (!collection) continue;

        collectionIds.push(id);
        publicationIds.push(...collection.childPublicationIds);
        pending.push(...collection.childCollectionIds);
    }

    return { collectionIds, publicationIds };
}

function removeCollectionSubtree(
    state: LibraryState,
    collectionId: CollectionId,
): LibraryState {
    if (!state.collections[collectionId]) return state;

    const { collectionIds, publicationIds } = collectSubtreeIds(state, collectionId);
    const parentCollectionId = findCollectionParent(state, collectionId);

    const unlinked = parentCollectionId
        ? updateCollection(state, parentCollectionId, collection => ({
            ...collection,
            childCollectionIds: collection.childCollectionIds.filter(id => id !== collectionId),
        }))
        : state;

    return {
        ...unlinked,
        collections: omitKeys(unlinked.collections, collectionIds),
        publications: omitKeys(unlinked.publications, publicationIds),
    };
}

export function applyPublicationUpserted(
    state: LibraryState,
    event: PublicationUpserted,
): LibraryState {
    const withPublication: LibraryState = {
        ...state,
        publications: { ...state.publications, [event.publicationId]: event.publication },
    };

    return updateCollection(withPublication, event.parentCollectionId, collection =>
        collection.childPublicationIds.includes(event.publicationId)
            ? collection
            : {
                ...collection,
                childPublicationIds: [...collection.childPublicationIds, event.publicationId],
            },
    );
}

export function applyPublicationRemoved(
    state: LibraryState,
    event: PublicationRemoved,
): LibraryState {
    if (!state.publications[event.publicationId]) return state;

    const parentCollectionId = findPublicationParent(state, event.publicationId);

    const unlinked = parentCollectionId
        ? updateCollection(state, parentCollectionId, collection => ({
            ...collection,
            childPublicationIds: collection.childPublicationIds.filter(
                id => id !== event.publicationId,
            ),
        }))
        : state;

    return {
        ...unlinked,
        publications: omitKeys(unlinked.publications, [event.publicationId]),
    };
}

export function applyCollectionUpserted(
    state: LibraryState,
    event: CollectionUpserted,
): LibraryState {
    const { subtree } = event;
    const withoutOldSubtree = removeCollectionSubtree(state, subtree.rootCollectionId);

    const withSubtree: LibraryState = {
        ...withoutOldSubtree,
        collections: {
            ...withoutOldSubtree.collections,
            ...subtree.collections,
            [subtree.rootCollectionId]: {
                name: subtree.rootCollectionName,
                childPublicationIds: subtree.rootChildPublicationIds,
                childCollectionIds: subtree.rootChildCollectionIds,
            },
        },
        publications: { ...withoutOldSubtree.publications, ...subtree.publications },
    };

    return updateCollection(withSubtree, event.parentCollectionId, collection =>
        collection.childCollectionIds.includes(subtree.rootCollectionId)
            ? collection
            : {
                ...collection,
                childCollectionIds: [
                    ...collection.childCollectionIds,
                    subtree.rootCollectionId,
                ],
            },
    );
}

export function applyCollectionRemoved(
    state: LibraryState,
    event: CollectionRemoved,
): LibraryState {
    return removeCollectionSubtree(state, event.collectionId);
}
