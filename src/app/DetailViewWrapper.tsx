import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

import DetailView, { type DetailDocument } from '../components/DetailView.tsx';
import { type EditorMode } from '../components/TextEditor.tsx';
import { type Publication, type PublicationId } from './LibraryModel.tsx';
import { useAutosavedPublicationText, type PublicationTextFile } from './useAutosavedPublicationText.ts';
import { logger } from './logger.ts';

const NOTES_FILE: PublicationTextFile = {
    writeCommand: 'write_publication_notes',
    originsThatRereadFile: ['disk', 'notes'],
    readText: publication => publication.notes ?? '',
};

const METADATA_SOURCE_FILE: PublicationTextFile = {
    writeCommand: 'write_publication_source',
    originsThatRereadFile: ['disk'],
    readText: publication => publication.metadataSource,
};

interface DetailViewWrapperProps {
    publicationId: PublicationId;
    publication: Publication;
    libraryReloadCount: number;
    editorMode: EditorMode;
    onEditorModeChange: (mode: EditorMode) => void;
}

export default function DetailViewWrapper({
    publicationId,
    publication,
    libraryReloadCount,
    editorMode,
    onEditorModeChange,
}: DetailViewWrapperProps) {
    const notes = useAutosavedPublicationText(
        publicationId,
        publication.notes ?? '',
        NOTES_FILE,
    );
    const metadataSource = useAutosavedPublicationText(
        publicationId,
        publication.metadataSource,
        METADATA_SOURCE_FILE,
    );

    useEffect(() => {
        invoke('request_reference_preview', { publicationId })
            .catch(error => logger.error(String(error)));
    }, [publicationId, libraryReloadCount]);

    const document: DetailDocument = {
        id: publicationId,
        title: publication.metadata?.title ?? null,
        authors: publication.metadata?.authors ?? null,
        notes: notes.value,
        metadataSource: metadataSource.value,
        referencePreview: publication.referencePreview,
    };

    return (
        <DetailView
            document={document}
            onNotesChange={notes.onChange}
            onMetadataSourceChange={metadataSource.onChange}
            editorMode={editorMode}
            onEditorModeChange={onEditorModeChange}
        />
    );
}
