import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import DetailView, { type DetailDocument } from '../components/DetailView.tsx';
import { type Publication, type PublicationId } from './LibraryModel.tsx';
import { type PublicationChangeOrigin, type PublicationUpserted } from './libraryUpdates.ts';
import { useConfig } from './config.tsx';
import { logger } from './logger.ts';

interface PublicationTextFile {
    writeCommand: string;
    originsThatRereadFile: PublicationChangeOrigin[];
    readText: (publication: Publication) => string;
}

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

function useAutosavedPublicationText(
    publicationId: PublicationId,
    text: string,
    file: PublicationTextFile,
) {
    const [value, setValue] = useState(text);
    const { opts: { autosaveDebounceMs } } = useConfig();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const unwrittenRef = useRef<string | null>(null);
    const queueRef = useRef<Promise<void>>(Promise.resolve());

    const cancelPendingWrite = useCallback(() => {
        if (timerRef.current === null) return;

        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const writeText = useCallback(() => {
        const content = unwrittenRef.current;
        if (content === null) return;
        unwrittenRef.current = null;

        queueRef.current = queueRef.current
            .then(() => invoke(file.writeCommand, { publicationId, content }))
            .then(() => undefined)
            .catch(error => logger.error(String(error)));
    }, [publicationId, file]);

    const handleChange = useCallback((next: string) => {
        setValue(next);
        unwrittenRef.current = next;

        cancelPendingWrite();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            writeText();
        }, autosaveDebounceMs);
    }, [autosaveDebounceMs, cancelPendingWrite, writeText]);

    useEffect(() => {
        const unlisten = listen<PublicationUpserted>('publication-upserted', event => {
            if (event.payload.publicationId !== publicationId) return;
            if (!file.originsThatRereadFile.includes(event.payload.origin)) return;

            cancelPendingWrite();
            unwrittenRef.current = null;
            setValue(file.readText(event.payload.publication));
        });

        return () => { unlisten.then(stop => stop()); };
    }, [publicationId, file, cancelPendingWrite]);

    useEffect(() => () => {
        cancelPendingWrite();
        writeText();
    }, [cancelPendingWrite, writeText]);

    return { value, onChange: handleChange };
}

interface DetailViewWrapperProps {
    publicationId: PublicationId;
    publication: Publication;
    libraryReloadCount: number;
}

export default function DetailViewWrapper({
    publicationId,
    publication,
    libraryReloadCount,
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
        />
    );
}
