import { ReactNode } from 'react';
import { Folder, Library } from 'lucide-react';

export type PublicationId = string;
export type CollectionId = string;

export interface ParsedMetadata {
    title: string;
    authors: string;
    publisher: string;
    year: number;
}

export interface Publication {
    name: string;
    metadataFileExtension: string;
    metadataSource: string;
    metadata: ParsedMetadata | null;
    referencePreview: string | null;
    availableContentFileExtensions: string[];
    notes: string | null;
    tags: string[];
}

export interface Collection {
    name: string;
    childPublicationIds: PublicationId[];
    childCollectionIds: CollectionId[];
}

export interface LibraryState {
    rootCollectionName: string;
    rootCollectionId: CollectionId;
    rootChildPublicationIds: PublicationId[];
    rootChildCollectionIds: CollectionId[];
    collections: Record<CollectionId, Collection>;
    publications: Record<PublicationId, Publication>;
}

export interface TreeNodeData {
    id: string;
    name: string;
    count: number;
    children: TreeNodeData[];
    renderIcon: () => ReactNode;
}

// Wraps a LibraryState, providing tree/query operations. The root collection is
// not part of `collections`; it only exists as the `root*` fields, so every
// lookup goes through `getCollection`.
export class LibraryModel {
    readonly collections: Record<CollectionId, Collection>;
    readonly publications: Record<PublicationId, Publication>;
    readonly publicationParents: Record<PublicationId, CollectionId>;

    private readonly rootCollection: Collection;
    private readonly rootCollectionId: CollectionId;

    constructor(state: LibraryState) {
        this.collections = state.collections;
        this.publications = state.publications;
        this.rootCollectionId = state.rootCollectionId;
        this.rootCollection = {
            name: state.rootCollectionName,
            childPublicationIds: state.rootChildPublicationIds,
            childCollectionIds: state.rootChildCollectionIds,
        };

        this.publicationParents = {};
        for (const publicationId of state.rootChildPublicationIds) {
            this.publicationParents[publicationId] = state.rootCollectionId;
        }
        for (const [collectionId, collection] of Object.entries(state.collections)) {
            for (const publicationId of collection.childPublicationIds) {
                this.publicationParents[publicationId] = collectionId;
            }
        }
    }

    get rootId(): CollectionId {
        return this.rootCollectionId;
    }

    getCollection(collectionId: CollectionId): Collection | null {
        if (collectionId === this.rootCollectionId) return this.rootCollection;
        return this.collections[collectionId] ?? null;
    }

    collectPublicationIds(collectionId: CollectionId): PublicationId[] {
        const collection = this.getCollection(collectionId);
        if (!collection) return [];
        return [
            ...collection.childPublicationIds,
            ...collection.childCollectionIds.flatMap(childId => this.collectPublicationIds(childId)),
        ];
    }

    buildTree(collectionId: CollectionId): TreeNodeData {
        const collection = this.getCollection(collectionId);
        const isRoot = collectionId === this.rootCollectionId;

        return {
            id: collectionId,
            name: collection?.name ?? '',
            count: this.collectPublicationIds(collectionId).length,
            children: (collection?.childCollectionIds ?? []).map(childId => this.buildTree(childId)),
            renderIcon: () =>
                isRoot
                    ? <Library size={15} aria-hidden="true" />
                    : <Folder size={15} aria-hidden="true" />,
        };
    }
}
