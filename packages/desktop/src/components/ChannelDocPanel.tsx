import { useEffect, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageBody } from './MessageBody';
import type { ChannelDoc } from '@murmur/shared';

interface ChannelDocPanelProps {
  channelId: string;
  onClose: () => void;
}

export function ChannelDocPanel({ channelId, onClose }: ChannelDocPanelProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState<number | null>(null);

  const accounts = useAppStore((s) => s.accounts);
  const channelDoc = useAppStore((s) => s.channelDocs[channelId]);

  useEffect(() => {
    if (!channelDoc) {
      getController().loadChannelDoc(channelId)
        .then((doc) => {
          setBody(doc.body);
          setExpectedUpdatedAt(new Date(doc.updatedAt).getTime());
        })
        .catch(() => {
          setError('문서를 불러올 수 없습니다');
        })
        .finally(() => setLoading(false));
    } else {
      setBody(channelDoc.body);
      setExpectedUpdatedAt(new Date(channelDoc.updatedAt).getTime());
      setLoading(false);
    }
  }, [channelId, channelDoc]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const doc = await getController().saveChannelDoc(channelId, body, expectedUpdatedAt);
      setExpectedUpdatedAt(new Date(doc.updatedAt).getTime());
      setEditing(false);
    } catch (e) {
      const apiError = e as { status?: number; code?: string; message?: string };
      if (apiError.status === 409 && apiError.code === 'doc_stale') {
        setError('문서가 변경되었습니다. 현재 내용을 확인하고 다시 저장해 주세요.');
        if (channelDoc) {
          setBody(channelDoc.body);
          setExpectedUpdatedAt(new Date(channelDoc.updatedAt).getTime());
        }
      } else {
        setError('저장 중 오류가 발생했습니다');
      }
    } finally {
      setSaving(false);
    }
  };

  const updatedByName = channelDoc ? accounts[channelDoc.updatedBy]?.handle ?? '...' : null;
  const updatedAt = channelDoc ? new Date(channelDoc.updatedAt).toLocaleString() : null;

  if (loading) {
    return (
      <div className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 p-4">
        <div className="text-sm text-zinc-500">불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
        <span className="font-semibold">문서</span>
        {updatedByName && updatedAt && (
          <span className="text-xs text-zinc-500">
            · {updatedByName} · {updatedAt}
          </span>
        )}
        <button
          className="ml-auto shrink-0 rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
          onClick={onClose}
        >
          닫기
        </button>
      </div>

      {error && (
        <div className="mx-3 mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {editing ? (
          <textarea
            className="w-full resize-none rounded border border-zinc-300 p-2 text-sm focus:border-zinc-400 focus:outline-none"
            rows={12}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="이 채널에 대한 문서를 입력하세요..."
          />
        ) : (
          <div className="text-sm text-zinc-700">
            {body ? <MessageBody body={body} messageId={channelId} /> : <span className="text-zinc-400">문서가 비어 있습니다</span>}
          </div>
        )}
      </div>

      <div className="border-t border-zinc-200 p-2">
        {editing ? (
          <div className="flex gap-2">
            <button
              className="flex-1 rounded bg-zinc-200 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-300"
              onClick={() => {
                setEditing(false);
                setError(null);
                if (channelDoc) {
                  setBody(channelDoc.body);
                }
              }}
            >
              취소
            </button>
            <button
              className="flex-1 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        ) : (
          <button
            className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100"
            onClick={() => setEditing(true)}
          >
            편집
          </button>
        )}
      </div>
    </div>
  );
}