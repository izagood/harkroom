import { useEffect, useMemo, useState } from 'react';
import type { ChannelRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SortMode = 'name' | 'creation';

export function ChannelDirectory({ open, onClose }: Props) {
  const channels = useAppStore((s) => s.channels);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [archivedOpen, setArchivedOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSortMode('name');
    setArchivedOpen(false);
  }, [open]);

  const { standardChannels, archivedChannels } = useMemo(() => {
    const standard = channels.filter((ch) => ch.kind === 'standard' && !ch.archivedAt);
    const archived = channels.filter((ch) => ch.kind === 'standard' && ch.archivedAt);
    return { standardChannels: standard, archivedChannels: archived };
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    let result = q
      ? standardChannels.filter((ch) => (ch.name ?? '').toLowerCase().includes(q))
      : standardChannels;

    if (sortMode === 'name') {
      result = [...result].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    }
    return result;
  }, [standardChannels, query, sortMode]);

  const sortedArchived = useMemo(() => {
    return [...archivedChannels].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [archivedChannels]);

  const handleChannelClick = async (channel: ChannelRow) => {
    await getController().openChannel(channel.id);
    onClose();
  };

  if (!open) return null;

  const row = (ch: ChannelRow) => (
    <li key={ch.id}>
      <button
        data-testid={`channel-row-${ch.id}`}
        className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-800"
        onClick={() => handleChannelClick(ch)}
      >
        {ch.visibility === 'private'
          ? <span className="text-zinc-500" aria-label="비공개 채널" title="비공개 채널">🔒</span>
          : <span className="text-zinc-500">#</span>}
        <div className="flex-1 overflow-hidden">
          <div className="font-medium text-zinc-100">{ch.name}</div>
          {ch.topic && (
            <div className="truncate text-xs text-zinc-500">{ch.topic}</div>
          )}
        </div>
      </button>
    </li>
  );

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="채널 디렉터리"
        className="flex max-h-full w-[36rem] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <span className="font-bold">채널 찾기</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700"
            aria-label="채널 디렉터리 닫기"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <input
            type="text"
            aria-label="채널 이름으로 검색"
            placeholder="채널 이름"
            className="flex-1 rounded bg-zinc-800 px-2 py-1 text-zinc-100 placeholder-zinc-500"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="flex rounded bg-zinc-800 text-xs">
            <button
              className={`rounded px-2 py-1 ${sortMode === 'name' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              onClick={() => setSortMode('name')}
            >
              이름순
            </button>
            <button
              className={`rounded px-2 py-1 ${sortMode === 'creation' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              onClick={() => setSortMode('creation')}
            >
              생성순
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {filteredChannels.length === 0 ? (
            <p className="px-2 text-xs text-zinc-500">
              {query ? '검색 결과가 없다' : '표준 채널이 없다'}
            </p>
          ) : (
            <ul>{filteredChannels.map(row)}</ul>
          )}
          {archivedChannels.length > 0 && (
            <div className="mt-4 border-t border-zinc-800 pt-2">
              <button
                className="flex w-full items-center gap-1 px-2 pb-1 text-[11px] uppercase tracking-wide text-zinc-500 hover:text-zinc-400"
                onClick={() => setArchivedOpen((v) => !v)}
              >
                <span>{archivedOpen ? '▼' : '▶'}</span>
                보관됨 ({archivedChannels.length})
              </button>
              {archivedOpen && (
                <ul>{sortedArchived.map(row)}</ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}