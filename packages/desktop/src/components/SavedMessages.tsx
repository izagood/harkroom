import { useCallback, useEffect, useState } from 'react';
import type { SavedMessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 담아 둔 메시지 목록(#219). **세 상태**다 — loading / ready / error.
 * 조회 실패를 빈 배열로 삼키면 "담은 것이 없다"와 "못 읽었다"가 한 화면이 된다(design.md §4).
 */
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type Tab = 'open' | 'done';

export function SavedMessages({ open, onClose }: Props) {
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  const me = useActiveStore((s) => s.me);

  const [entries, setEntries] = useState<SavedMessageRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('open');
  // 체크를 누른 뒤 목록을 다시 받게 하는 방아쇠. 서버가 행을 다른 탭으로 옮겼으니
  // 지역 상태만 고쳐 두면 화면과 서버가 갈라진다.
  const [reloadSeq, setReloadSeq] = useState(0);

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
    // `reloadSeq` 가 의존성에 있는 것이 핵심이다 — 체크를 누르면 이 effect 가 다시 돌아
    // 서버의 새 상태를 받는다.
    void reloadSeq;
    return reload();
  }, [open, reload, reloadSeq]);

  useEffect(() => {
    if (!open) return;
    // 배지와 `⋯` 메뉴 문구를 패널을 열 때 한 번 맞춰 둔다. 실패는 배지 숫자를 그대로 두는
    // 것뿐이라 여기서는 화면에 그리지 않는다 — 목록의 실패는 위에서 따로 보인다.
    void getController().loadSavedSummary().catch(() => undefined);
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
    const next = e.state === 'open' ? 'done' : 'open';
    await getController().updateSavedMessageState(e.messageId, next);
    setReloadSeq((n) => n + 1);
  };

  /**
   * 행 하나. 바깥을 `<button>` 으로 감싸지 않는다 — 안의 체크 버튼이 버튼 안의 버튼이 되어
   * 유효하지 않은 문서가 되고, 클릭이 어느 쪽으로 가는지 브라우저마다 갈린다.
   */
  const entryRow = (e: SavedMessageRow) => {
    const time = new Date(e.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <li key={e.messageId} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-hover">
        {/* #219 결정 3: 지워진 메시지도 자리가 남는다 — 담아 둔 사실은 내 기록이다.
            본문은 서버가 내주지 않으므로(`message: null`) 그릴 것이 없고, 갈 곳도 없어
            누를 수 없게 둔다. 눌러도 아무 일이 없는 버튼은 거짓 신호다(design.md §4). */}
        {e.message === null ? (
          <span
            data-testid={`saved-entry-${e.messageId}`}
            className="flex flex-1 items-center gap-2 text-left"
          >
            <span className="rounded bg-surface-sunken px-1 text-[10px] uppercase tracking-wide text-fg-muted">
              {channelLabel(e.channelId)}
            </span>
            <span className="flex-1 italic text-fg-subtle">삭제된 메시지</span>
            <span className="text-[10px] text-fg-subtle">{time}</span>
          </span>
        ) : (
          <button
            data-testid={`saved-entry-${e.messageId}`}
            onClick={() => openEntry(e)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="rounded bg-surface-sunken px-1 text-[10px] uppercase tracking-wide text-fg-muted">
              {channelLabel(e.channelId)}
            </span>
            <span className="text-fg-muted">@{accounts[e.message.authorId]?.handle ?? '…'}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">
              {e.message.body.length > 100 ? `${e.message.body.slice(0, 100)}…` : e.message.body}
            </span>
            <span className="text-[10px] text-fg-subtle">
              {new Date(e.message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
        )}
        <button
          data-testid={`saved-toggle-${e.messageId}`}
          aria-label={e.state === 'open' ? '완료로 표시' : '할 것으로 되돌리기'}
          onClick={() => { void toggleState(e); }}
          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-fg-muted hover:bg-surface-hover"
        >
          {e.state === 'open' ? '✓' : '↺'}
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
        className="flex max-h-full w-[42rem] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised text-sm text-fg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <span className="font-bold">Saved</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover"
            aria-label="패널 닫기"
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-3 border-b border-border p-3">
          <button
            className={`rounded px-2 py-1 ${tab === 'open' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-hover'}`}
            onClick={() => setTab('open')}
          >
            할 것
          </button>
          <button
            className={`rounded px-2 py-1 ${tab === 'done' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-hover'}`}
            onClick={() => setTab('done')}
          >
            완료
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded border border-danger-border bg-danger-surface p-2 text-xs text-danger">
              불러오지 못했다 — {load.message}
              <button
                onClick={() => setReloadSeq((n) => n + 1)}
                className="ml-2 rounded bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
              >
                다시 시도
              </button>
            </div>
          )}
          {load.kind === 'loading' && <p className="px-2 text-xs text-fg-subtle">불러오는 중…</p>}

          {load.kind === 'ready' && entries.length === 0 && (
            <p data-testid="saved-empty" className="px-2 text-xs text-fg-subtle">
              {tab === 'open' ? '저장된 메시지가 없다' : '완료된 메시지가 없다'}
            </p>
          )}
          {load.kind === 'ready' && entries.length > 0 && <ul>{entries.map(entryRow)}</ul>}
        </div>
      </div>
    </div>
  );
}
