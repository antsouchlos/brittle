import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type Publication, type PublicationId } from './LibraryModel.tsx';
import { type PublicationChangeOrigin, type PublicationUpserted } from './libraryUpdates.ts';
import { useConfig } from './config.tsx';
import { logger } from './logger.ts';

export interface PublicationTextFile {
    writeCommand: string;
    originsThatRereadFile: PublicationChangeOrigin[];
    readText: (publication: Publication) => string;
    isValid?: (text: string) => boolean;
}

export function useAutosavedPublicationText(
    publicationId: PublicationId,
    text: string,
    file: PublicationTextFile,
) {
    const [value, setValue] = useState(text);
    const { opts: { autosaveDebounceMs } } = useConfig();
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const unwrittenRef = useRef<string | null>(null);
    const queueRef = useRef<Promise<void>>(Promise.resolve());
    const diskRevisionRef = useRef(0);

    const cancelPendingWrite = useCallback(() => {
        if (timerRef.current === null) return;

        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const writeText = useCallback(() => {
        const content = unwrittenRef.current;
        if (content === null) return;
        unwrittenRef.current = null;
        const diskRevision = diskRevisionRef.current;

        queueRef.current = queueRef.current
            .then(() => {
                if (diskRevision !== diskRevisionRef.current) return;

                return invoke(file.writeCommand, { publicationId, content });
            })
            .then(() => undefined)
            .catch(error => logger.error(String(error)));
    }, [publicationId, file]);

    const handleChange = useCallback((next: string) => {
        setValue(next);
        if (file.isValid && !file.isValid(next)) return;
        unwrittenRef.current = next;

        cancelPendingWrite();
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            writeText();
        }, autosaveDebounceMs);
    }, [autosaveDebounceMs, cancelPendingWrite, writeText, file]);

    useEffect(() => {
        const unlisten = listen<PublicationUpserted>('publication-upserted', event => {
            if (event.payload.publicationId !== publicationId) return;
            if (!file.originsThatRereadFile.includes(event.payload.origin)) return;

            diskRevisionRef.current += 1;
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
