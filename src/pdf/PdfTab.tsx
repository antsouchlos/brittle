import { PDFViewer } from '@embedpdf/react-pdf-viewer';
import { useDocument, type DocumentId, type PdfViewerState } from '../store';

interface PdfTabProps {
    documentId: DocumentId;
    // Reserved for build-order step 6 (embed-pdf scroll/zoom/page plumbing).
    // Accepted now so the surrounding wiring is stable; unused this iteration.
    initialViewerState?: PdfViewerState;
    onViewerStateChange?(state: PdfViewerState): void;
}

const DISABLED_COMMAND_CATEGORIES = [
    'zoom',
    'tools',
    'document',
    'panel',
    'page',
    'selection',
    'history',
];

export default function PdfTab({ documentId }: PdfTabProps) {
    const doc = useDocument(documentId);
    if (!doc) return null;

    return (
        <PDFViewer
            style={{ width: '100%', height: '100%' }}
            config={{
                src: doc.path,
                theme: { preference: 'dark' },
                commands: { disabledCategories: DISABLED_COMMAND_CATEGORIES },
            }}
        />
    );
}
