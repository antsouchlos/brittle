import { ReactNode } from 'react';
import { Folder, Library } from 'lucide-react';

export interface DirectoryEntry {
    path: string;
    childDirectoryIds: string[];
    publicationIds: string[];
}

export interface PublicationEntry {
    extensionlessPath: string;
    parentDirectoryId: string;
    bibSource: string;
}

export interface Library {
    directories: Record<string, DirectoryEntry>;
    publications: Record<string, PublicationEntry>;
}

export interface Metadata {
    title: string;
    author: string;
    year: number;
    publisher: string;
}

export interface TreeNodeData {
    id: string;
    name: string;
    count: number;
    children: TreeNodeData[];
    renderIcon: () => ReactNode;
}

// Wraps flat directories + publications maps, providing tree/query operations
export class LibraryModel {
    readonly directories: Record<string, DirectoryEntry>;
    readonly publications: Record<string, PublicationEntry>;

    constructor(data: Library) {
        this.directories = data.directories;
        this.publications = data.publications;
    }

    get rootId(): string {
        return Object.keys(this.directories).find(id => !id.includes('/')) ?? '';
    }

    nameOf(id: string): string {
        return id.split('/').pop() ?? id;
    }

    collectPubIds(folderId: string): string[] {
        const dir = this.directories[folderId];
        if (!dir) return [];
        return [
            ...dir.publicationIds,
            ...dir.childDirectoryIds.flatMap(cid => this.collectPubIds(cid)),
        ];
    }

    visibleNodeIds(folderId: string, expanded: string[]): string[] {
        const result = [folderId];
        if (expanded.includes(folderId) && this.directories[folderId]) {
            for (const cid of this.directories[folderId].childDirectoryIds) {
                result.push(...this.visibleNodeIds(cid, expanded));
            }
        }
        return result;
    }

    buildTree(id: string): TreeNodeData {
        const dir = this.directories[id];
        return {
            id,
            name: this.nameOf(id),
            count: this.collectPubIds(id).length,
            children: dir.childDirectoryIds.map(cid => this.buildTree(cid)),
            renderIcon: () =>
                id.includes('/')
                    ? <Folder size={15} aria-hidden="true" />
                    : <Library size={15} aria-hidden="true" />,
        };
    }
}
