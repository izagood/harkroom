import { useCallback, useEffect, useState } from 'react';
import type { SavedMessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

interface Props {
  open: boolean;
  onClose: () => void;
}

type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type Tab = 'open' | 'done';

export function SavedMessages({ open, onClose }: Props) {
  const channels = useAppStore((s) => s.channels);
  const dms = useAppStore((s) => s.dms);
  const accounts = useAppStore((s) => s.accounts);
  const me = useAppStore((s) => s.me);

  const [entries, setEntries] = useState<SavedMessageRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('open');

  const reload = useCallback((): (() => void) => {
    let alive = true;
    setLoad({ kind: 'loading' });
    getController().loadSavedMessages(tab).then(
      (rows) => { if (alive) { setEntries(rows); setLoad({ kind: 'ready' }); } },
      (err: unknown) => {
        if (!alive) return;
        setEntries([]);
        setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, [tab]);

  useEffect(() => {
    if (!open) return;
    return reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    getController().loadSavedCount();
  }, [open]);

  const channelLabel = useCallback((id: string): string => {
    const ch = channels.find((c) => c.id === id);
    if (ch?.kind === 'standard') return `#${ch.name ?? id}`;
    const dm = dms.find((d) => d.id === id);
    if (dm) {
      const peers = dm.memberIds.filter((p) => p !== me?.id);
      return peers.map((p) => accounts[p]?.handle ?? '…').join(', ') || 'just me';
    }
    return ch?.name ? `#${ch.name}` : id;
  }, [channels, dms, accounts, me]);

  if (!open) return null;

  const openEntry = (e: SavedMessageRow): void => {
    void getController().openMessage(e.messageId);
    onClose();
  };

  const toggleState = async (e: SavedMessageRow): Promise<void> => {
    const newState = e.state === 'open' ? 'done' : 'open';
    await getController().updateSavedMessageState(e.messageId, newState);
  };

  const entryRow = (e: SavedMessageRow) => {
    const author = accounts[e.message.authorId];
    const body = e.message.body.length > 100 ? e.message.body.slice(0, 100) + '...' : e.message.body;
    const time = new Date(e.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <li key={e.messageId}>
        <button
          data-testid={`saved-entry-${e.messageId}`}
          onClick={() => openEntry(e)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-700"
        >
          <span className="rounded bg-zinc-800 px-1 text-[10px] uppercase tracking-wide text-zinc-400">
            {channelLabel(e.channelId)}
          </span>
          <span className="text-zinc-300">@{author?.handle ?? '…'}</span>
          <span className="truncate flex-1 text-zinc-400">{body}</span>
          <span className="text-[10px] text-zinc-500">{time}</span>
          <button
            data-testid={`saved-toggle-${e.messageId}`}
            onClick={(evt) => { evt.stopPropagation(); void toggleState(e); }}
            className="ml-auto rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:bg-zinc-700"
          >
            {e.state === 'open' ? '✓' : '↺'}
          </button>
        </button>
      </li>
    );
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="저장된 메시지"
        className="flex max-h-full w-[42rem] flex-col overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 text-sm text-zinc-200"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <span className="font-bold">Saved</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-zinc-400 hover:bg-zinc-700"
            aria-label="패널 닫기"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-3 border-b border-zinc-800 p-3">
          <button
            className={`rounded px-2 py-1 ${tab === 'open' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-700'}`}
            onClick={() => setTab('open')}
          >
            할 것
          </button>
          <button
            className={`rounded px-2 py-1 ${tab === 'done' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:bg-zinc-700'}`}
            onClick={() => setTab('done')}
          >
            완료
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded border border-red-800 bg-red-950 p-2 text-xs text-red-200">
              불러오지 못했다 — {load.message}
              <button
                onClick={() => { reload(); }}
                className="ml-2 rounded bg-red-800 px-2 py-0.5 text-red-100 hover:bg-red-700"
              >
                다시 시도
              </button>
            </div>
          )}
          {load.kind === 'loading' && <p className="px-2 text-xs text-zinc-500">불러오는 중…</p>}

          {load.kind === 'ready' && entries.length === 0 && (
            <p data-testid="saved-empty" className="px-2 text-xs text-zinc-500">
              {tab === 'open' ? '저장된 메시지가 없다' : '완료된 메시지가 없다'}
            </p>
          )}
          {entries.length > 0 && <ul>{entries.map(entryRow)}</ul>}
        </div>
      </div>
    </div>
  );
}