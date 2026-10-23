import { lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../hooks/useTheme';
import type { ObjectEditRequest } from './objectEditRequest';

// The editor is large and only an admin who opens it needs it, so it loads on first use.
const ImageEditorModal = lazy(() => import('../ImageEditorModal').then(m => ({ default: m.ImageEditorModal })));

interface Props {
  request: ObjectEditRequest | null;
  onClose: () => void;
  /** Runs after a save, so the page behind can show the new or replaced picture. */
  onSaved: () => void;
}

export function ObjectImageEditor({ request, onClose, onSaved }: Props) {
  const { isDark } = useTheme();
  const queryClient = useQueryClient();
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ImageEditorModal
        imageUrl={request.url}
        imageName={request.name}
        objectId={request.objectId}
        date={request.date}
        isDark={isDark}
        sourceKind={request.sourceKind}
        overwriteTarget={request.overwriteTarget}
        onClose={onClose}
        onSaved={() => {
          void queryClient.invalidateQueries({ queryKey: ['processed-images-all', request.objectId] });
          void queryClient.invalidateQueries({ queryKey: ['processedImages', request.objectId] });
          onSaved();
        }}
      />
    </Suspense>
  );
}
