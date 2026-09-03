import { useEffect, useState } from 'react';
import { getController } from '../state/controller';

type LinkPreviewData = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  status: string;
  fetchedAt: string;
};

interface LinkPreviewProps {
  url: string;
}

export function LinkPreview({ url }: LinkPreviewProps) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchPreview() {
      try {
        const api = getController().api;
        const data = await api.getLinkPreview(url);
        if (!cancelled) setPreview(data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchPreview();
    return () => { cancelled = true; };
  }, [url]);

  if (loading) {
    return (
      <div className="mt-2 rounded border border-slate-200 p-3">
        <div className="animate-pulse">
          <div className="h-4 w-3/4 rounded bg-slate-200"></div>
          <div className="mt-2 h-3 w-1/2 rounded bg-slate-200"></div>
        </div>
      </div>
    );
  }

  if (!preview) return null;
  if (preview.status !== 'ok') return null;
  if (!preview.title && !preview.description && !preview.siteName) return null;

  return (
    <div className="mt-2 rounded border border-slate-200 p-3">
      {preview.siteName && (
        <div className="text-xs text-slate-500">{preview.siteName}</div>
      )}
      {preview.title && (
        <div className="font-semibold text-slate-900">{preview.title}</div>
      )}
      {preview.description && (
        <div className="mt-1 text-sm text-slate-600">{preview.description}</div>
      )}
      <a
        href={preview.url}
        rel="noreferrer noopener"
        className="mt-2 block truncate text-xs text-slate-400 hover:text-slate-600"
      >
        {preview.url}
      </a>
    </div>
  );
}