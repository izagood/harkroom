import { useCallback, useEffect, useRef, useState } from 'react';
import { Overlay } from './Overlay';
import type { SavedMessageRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { displayBody } from '../lib/mention';
import { useT, useLocale } from '../i18n/useT';
import { stampLabel } from '../lib/day';
import { errorText } from '../lib/errorText';

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

/** 빈 배열 리터럴을 매 렌더 새로 만들지 않는다. */
const NO_TEAMS_FALLBACK: never[] = [];

/** 옮기기 실패 알림이 떠 있는 시간. */
const MOVE_FAILED_MS = 5_000;

/** 서버에 보내 놓고 아직 답을 못 받은 옮기기 하나. 행은 이미 화면에서 옮겨져 있다. */
interface PendingMove { row: SavedMessageRow; to: Tab }

/**
 * 서버에서 받은 한 탭의 목록에 아직 끝나지 않은 옮기기를 겹친다. 목록을 받는 사이에 서버가
 * 그 옮기기를 반영했는지 모르므로, 떠나는 행은 빼고 들어오는 행은 없을 때만 맨 앞에 끼운다.
 */
function overlayPending(rows: SavedMessageRow[], tab: Tab, pending: ReadonlyMap<string, PendingMove>): SavedMessageRow[] {
  if (pending.size === 0) return rows;
  const out = rows.filter((r) => { const p = pending.get(r.messageId); return !p || p.to === tab; });
  for (const p of pending.values()) {
    if (p.to === tab && !out.some((r) => r.messageId === p.row.messageId)) out.unshift({ ...p.row, state: tab });
  }
  return out;
}

export function SavedMessages({ open, onClose }: Props) {
  const t = useT();
  const locale = useLocale();
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  // 집합·팀 토큰(#845)도 이름으로 되돌린다 — 안 주면 미리보기에 `@알 수 없음` 이 뜬다.
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS_FALLBACK;
  const me = useActiveStore((s) => s.me);

  const [entries, setEntries] = useState<SavedMessageRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('open');
  // 목록을 다시 받게 하는 방아쇠 — [다시 시도] 만 당긴다. 체크(✓·↺)는 당기지 않는다:
  // 누를 때마다 목록 전체가 '불러오는 중' 으로 깜빡였다(10-13 jaebin). 체크는 그 행만
  // 낙관적으로 옮기고 요청은 뒤에서 보낸다(`toggleState`).
  const [reloadSeq, setReloadSeq] = useState(0);
  // 답을 기다리는 옮기기(messageId → 무엇을 어디로). 탭을 바꿔 목록을 새로 받아도 이 표를
  // 겹치므로, 서버가 아직 반영하기 전이라도 옮긴 행이 되살아나거나 사라지지 않는다.
  const pendingRef = useRef(new Map<string, PendingMove>());
  // 비동기 답이 돌아왔을 때 지금 보이는 탭. 클로저의 `tab` 은 누른 때의 값이다.
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;
  const [moveFailed, setMoveFailed] = useState<string | null>(null);

  useEffect(() => {
    if (moveFailed === null) return;
    const id = setTimeout(() => setMoveFailed(null), MOVE_FAILED_MS);
    return () => clearTimeout(id);
  }, [moveFailed]);

  const reload = useCallback((): (() => void) => {
    let alive = true;
    setLoad({ kind: 'loading' });
    getController().loadSavedMessages(tab).then(
      (rows) => { if (alive) { setEntries(overlayPending(rows, tab, pendingRef.current)); setLoad({ kind: 'ready' }); } },
      (err: unknown) => {
        if (!alive) return;
        setEntries([]);
        setLoad({ kind: 'error', message: errorText(err, t) });
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
      return peers.map((p) => accounts[p]?.handle ?? '…').join(', ') || t('sidebar.dm.justMe');
    }
    return ch?.name ? `#${ch.name}` : id;
  }, [channels, dms, accounts, me, t]);

  if (!open) return null;

  const openEntry = (e: SavedMessageRow): void => {
    void getController().openMessage(e.messageId);
    onClose();
  };

  /**
   * 그 행만 지금 이 탭에서 빼고 요청은 뒤에서 보낸다. 행마다 따로 돈다 — 여러 개를 연달아
   * 눌러도 서로를 기다리지 않는다. 실패하면 그 행만 원래 자리로 되돌리고 알린다.
   */
  const toggleState = async (e: SavedMessageRow): Promise<void> => {
    const from: Tab = e.state;
    const next: Tab = from === 'open' ? 'done' : 'open';
    if (pendingRef.current.has(e.messageId)) return;
    const at = entries.findIndex((r) => r.messageId === e.messageId);
    pendingRef.current.set(e.messageId, { row: e, to: next });
    setEntries((rows) => rows.filter((r) => r.messageId !== e.messageId));
    try {
      await getController().updateSavedMessageState(e.messageId, next);
      pendingRef.current.delete(e.messageId);
    } catch (err: unknown) {
      pendingRef.current.delete(e.messageId);
      const shown = tabRef.current;
      setEntries((rows) => {
        const rest = rows.filter((r) => r.messageId !== e.messageId);
        if (shown !== from) return rest;
        const pos = at < 0 ? 0 : Math.min(at, rest.length);
        return [...rest.slice(0, pos), e, ...rest.slice(pos)];
      });
      setMoveFailed(errorText(err, t));
    }
  };

  /**
   * 행 하나. 바깥을 `<button>` 으로 감싸지 않는다 — 안의 체크 버튼이 버튼 안의 버튼이 되어
   * 유효하지 않은 문서가 되고, 클릭이 어느 쪽으로 가는지 브라우저마다 갈린다.
   */
  const entryRow = (e: SavedMessageRow) => {
    const time = stampLabel(e.createdAt, locale);
    // 시스템 메시지는 본문에 이름이 없고 자리표시자만 있다 — `displayBody` 를 지나지 않으면
    // 이 목록에만 그 글자가 남는다(#329).
    const body = e.message ? displayBody(e.message, accounts, groups, teams) : '';
    const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;

    return (
      <li key={e.messageId} className="flex items-center gap-2 rounded-row px-2 py-1.5 hover:bg-surface-hover">
        {/* #219 결정 3: 지워진 메시지도 자리가 남는다 — 담아 둔 사실은 내 기록이다.
            본문은 서버가 내주지 않으므로(`message: null`) 그릴 것이 없고, 갈 곳도 없어
            누를 수 없게 둔다. 눌러도 아무 일이 없는 버튼은 거짓 신호다(design.md §4). */}
        {e.message === null ? (
          <span
            data-testid={`saved-entry-${e.messageId}`}
            className="flex flex-1 items-center gap-2 text-left"
          >
            <span className="rounded-sm bg-surface-sunken px-1 text-meta uppercase tracking-wide text-fg-muted">
              {channelLabel(e.channelId)}
            </span>
            <span className="flex-1 italic text-fg-subtle">{e.deleted ? t('saved.deleted') : t('saved.unavailable')}</span>
            <span className="text-meta text-fg-subtle">{time}</span>
          </span>
        ) : (
          <button
            data-testid={`saved-entry-${e.messageId}`}
            onClick={() => openEntry(e)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="rounded-sm bg-surface-sunken px-1 text-meta uppercase tracking-wide text-fg-muted">
              {channelLabel(e.channelId)}
            </span>
            <span className="text-fg-muted">@{accounts[e.message.authorId]?.handle ?? '…'}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">
              {preview}
            </span>
            <span className="text-meta text-fg-subtle">
              {stampLabel(e.message.createdAt, locale)}
            </span>
          </button>
        )}
        <button
          data-testid={`saved-toggle-${e.messageId}`}
          aria-label={e.state === 'open' ? t('saved.markDone') : t('saved.markOpen')}
          onClick={() => { void toggleState(e); }}
          className="shrink-0 rounded-row border border-border px-1.5 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
        >
          {e.state === 'open' ? '✓' : '↺'}
        </button>
      </li>
    );
  };

  return (
    <Overlay label={t('saved.label')} onClose={onClose}>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <span className="font-semibold">{t('chat.saved')}</span>
          <button
            onClick={onClose}
            className="ml-auto rounded-row px-2 py-1 text-fg-muted hover:bg-surface-hover"
            aria-label={t('saved.close')}
          >
            ✕
          </button>
        </div>
        <div className="flex items-center gap-3 border-b border-border p-3">
          <button
            className={`rounded-row px-2 py-1 ${tab === 'open' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-hover'}`}
            onClick={() => setTab('open')}
          >
            {t('saved.tabOpen')}
          </button>
          <button
            className={`rounded-row px-2 py-1 ${tab === 'done' ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-hover'}`}
            onClick={() => setTab('done')}
          >
            {t('saved.tabDone')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {moveFailed !== null && (
            <div role="status" data-testid="saved-move-failed" className="mb-2 rounded-row border border-danger-border bg-danger-surface px-2 py-1 text-meta text-danger">
              {t('saved.moveFailed', { reason: moveFailed })}
            </div>
          )}
          {load.kind === 'error' && (
            <div role="alert" className="mb-3 rounded-row border border-danger-border bg-danger-surface p-2 text-danger">
              {t('saved.listFailed', { reason: load.message })}
              <button
                onClick={() => setReloadSeq((n) => n + 1)}
                className="ml-2 rounded-row bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
              >
                {t('saved.retry')}
              </button>
            </div>
          )}
          {/* 오류·대기·'없다' 는 전부 **본문단**이다(앱 기본값 13px 이라 안 적는다) —
              목록이 비었을 때 화면에 남는 유일한 글자를 아랫단으로 내리지 않는다. */}
          {load.kind === 'loading' && <p className="px-2 text-fg-subtle">{t('saved.loading')}</p>}

          {load.kind === 'ready' && entries.length === 0 && (
            <p data-testid="saved-empty" className="px-2 text-fg-subtle">
              {tab === 'open' ? t('saved.emptyOpen') : t('saved.emptyDone')}
            </p>
          )}
          {load.kind === 'ready' && entries.length > 0 && <ul>{entries.map(entryRow)}</ul>}
        </div>
    </Overlay>
  );
}
