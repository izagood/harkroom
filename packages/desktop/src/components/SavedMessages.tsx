import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedMessageRow } from '@harkroom/shared';
import { useActiveStore, useCommunityRegistry } from '../state/communities';
import { getController } from '../state/controller';
import { displayBody } from '../lib/mention';
import { useT, useLocale } from '../i18n/useT';
import { shortStampLabel, stampLabel } from '../lib/day';
import { errorText } from '../lib/errorText';

/**
 * 담아 둔 메시지 목록(#219). **세 상태**다 — loading / ready / error.
 *
 * **사이드바 칸이다 — 모달이 아니다**(소유자, 2026-10-15). 레일의 북마크 칸을 누르면 DM 칸이
 * DM 목록을 세우듯 이 목록이 사이드바 자리에 선다. 모달일 때는 줄을 누르면 모달이 닫혀서
 * 다음 것을 보려면 다시 열어야 했다 — 칸이면 목록이 왼쪽에 남은 채 본문만 바뀐다. 그래서
 * 이 컴포넌트에는 `open`·`onClose` 가 없다: 그려지면 열린 것이고, 닫는 것은 다른 칸을 고르는 것이다.
 * 조회 실패를 빈 배열로 삼키면 "담은 것이 없다"와 "못 읽었다"가 한 화면이 된다(design.md §4).
 */
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };
type Tab = 'open' | 'done';

/** 빈 배열 리터럴을 매 렌더 새로 만들지 않는다. */
const NO_TEAMS_FALLBACK: never[] = [];

/** 옮기기 실패 알림이 떠 있는 시간. */
const MOVE_FAILED_MS = 5_000;

/**
 * 서버에 보내 놓고 아직 답을 못 받은 옮기기 하나. 행은 이미 화면에서 옮겨져 있다.
 * `community` 는 누른 때의 활성 커뮤니티다 — 이 패널(`Workspace`)은 커뮤니티를 바꿔도
 * 새로 그려지지 않아 표가 살아남으므로, 다른 커뮤니티의 목록에 끼우지 않으려고 적어 둔다.
 */
interface PendingMove { row: SavedMessageRow; to: Tab; community: string }

/**
 * 서버에서 받은 한 탭의 목록에 아직 끝나지 않은 옮기기를 겹친다. 목록을 받는 사이에 서버가
 * 그 옮기기를 반영했는지 모르므로, 떠나는 행은 빼고 들어오는 행은 없을 때만 맨 앞에 끼운다.
 */
function overlayPending(rows: SavedMessageRow[], tab: Tab, community: string, pending: ReadonlyMap<string, PendingMove>): SavedMessageRow[] {
  if (pending.size === 0) return rows;
  const out = rows.filter((r) => { const p = pending.get(r.messageId); return !p || p.community !== community || p.to === tab; });
  for (const p of pending.values()) {
    if (p.community === community && p.to === tab && !out.some((r) => r.messageId === p.row.messageId)) out.unshift({ ...p.row, state: tab });
  }
  return out;
}

export function SavedMessages() {
  const t = useT();
  const locale = useLocale();
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  // 집합·팀 토큰(#845)도 이름으로 되돌린다 — 안 주면 미리보기에 `@알 수 없음` 이 뜬다.
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS_FALLBACK;
  const me = useActiveStore((s) => s.me);
  const savedChange = useActiveStore((s) => s.savedChange);
  const community = useCommunityRegistry((r) => r.activeId);

  const [entries, setEntries] = useState<SavedMessageRow[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('open');
  // 목록을 다시 받게 하는 방아쇠 — [다시 시도] 만 당긴다. 체크(✓·↺)는 당기지 않는다:
  // 누를 때마다 목록 전체가 '불러오는 중' 으로 깜빡였다(10-13 소유자). 체크는 그 행만
  // 낙관적으로 옮기고 요청은 뒤에서 보낸다(`toggleState`).
  const [reloadSeq, setReloadSeq] = useState(0);
  // 답을 기다리는 옮기기(messageId → 무엇을 어디로). 탭을 바꿔 목록을 새로 받아도 이 표를
  // 겹치므로, 서버가 아직 반영하기 전이라도 옮긴 행이 되살아나거나 사라지지 않는다.
  const pendingRef = useRef(new Map<string, PendingMove>());
  // 답이 왔어도(성공) 그 전에 떠난 목록 읽기가 남아 있으면 그 읽기는 옛 목록을 가져온다 — 그래서
  // 끝난 옮기기는 날아가는 읽기가 다 끝날 때까지 `pendingRef` 에 두고 여기 적어 둔다.
  const settledRef = useRef(new Set<string>());
  const readsInFlightRef = useRef(0);
  // 비동기 답이 돌아왔을 때 지금 보이는 탭. 클로저의 `tab` 은 누른 때의 값이다.
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;
  const communityRef = useRef(community);
  communityRef.current = community;
  const [moveFailed, setMoveFailed] = useState<string | null>(null);
  // 마지막으로 누른 줄. 목록이 사이드바에 남으므로 지금 본문에 무엇을 열어 두었는지 줄이 말한다
  // (채널 목록의 고른 줄과 같은 면).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (moveFailed === null) return;
    const id = setTimeout(() => setMoveFailed(null), MOVE_FAILED_MS);
    return () => clearTimeout(id);
  }, [moveFailed]);

  // 목록 읽기마다 번호를 붙여 가장 마지막에 떠난 읽기의 답만 쓴다 — 탭을 연 읽기와 담기 변경이
  // 부른 조용한 읽기가 겹치면 늦게 돌아온 옛 답이 새 답을 덮는다.
  const fetchSeqRef = useRef(0);
  const seenChangeRef = useRef({ community, change: savedChange });

  const reload = useCallback((): (() => void) => {
    let alive = true;
    const mySeq = ++fetchSeqRef.current;
    setLoad({ kind: 'loading' });
    readsInFlightRef.current += 1;
    // 겹치기를 **마친 뒤에** 끝난 옮기기를 걷는다 — 먼저 걷으면 이 (옛) 목록이 옮긴 행을 되살린다.
    const settle = (): void => {
      readsInFlightRef.current -= 1;
      if (readsInFlightRef.current > 0) return;
      for (const id of settledRef.current) pendingRef.current.delete(id);
      settledRef.current.clear();
    };
    getController().loadSavedMessages(tab).then(
      (rows) => {
        if (alive && mySeq === fetchSeqRef.current) { setEntries(overlayPending(rows, tab, community, pendingRef.current)); setLoad({ kind: 'ready' }); }
        settle();
      },
      (err: unknown) => {
        settle();
        if (!alive || mySeq !== fetchSeqRef.current) return;
        setEntries([]);
        setLoad({ kind: 'error', message: errorText(err, t) });
      },
    );
    return () => { alive = false; };
    // 커뮤니티를 바꾸면 그 커뮤니티의 목록을 새로 받는다 — 앞 커뮤니티의 행을 남기지 않는다.
  }, [tab, community]);

  useEffect(() => {
    // `reloadSeq` 는 [다시 시도] 의 방아쇠다 — 누르면 이 effect 가 다시 돌아 목록을 새로 받는다.
    // 체크(✓·↺)는 이것을 당기지 않는다(`toggleState` 가 그 행만 옮긴다).
    void reloadSeq;
    return reload();
  }, [reload, reloadSeq]);

  /**
   * 칸을 연 채 담기 상태가 바뀌면(툴바의 저장·해제, 다른 기기, 서버 이벤트) 목록을 맞춘다(10-15).
   * 전에는 탭·커뮤니티가 바뀔 때만 읽어서, 열어 둔 칸에 방금 담은 것이 다른 곳에 다녀올 때까지
   * 안 보였다. 두 단계다:
   * 1. **바로** — 해제·다른 탭으로 옮김은 그 행을 빼고, 이 앱에서 방금 담은 것(`row`)은 '할 것'
   *    맨 위에 끼운다. 왕복을 기다리지 않는다.
   * 2. **조용히 다시 읽기** — '불러오는 중' 으로 깜빡이지 않고 뒤에서 이 탭을 다시 받는다. 다른
   *    기기에서 담은 것처럼 행 내용을 모르는 변경도 여기서 들어온다. 실패해도 지금 목록을 둔다.
   * 내 ✓·↺ 로 생긴 변경(`pendingRef` 에 있음)은 1단계를 건너뛴다 — 이미 옮겨 두었다.
   */
  useEffect(() => {
    // 칸을 열 때 이미 있던 변경과, 커뮤니티를 바꿔 다른 스토어의 값이 보이는 것은 변경이 아니다 —
    // 그때의 목록은 위 `reload` 가 받는다.
    const seen = seenChangeRef.current;
    seenChangeRef.current = { community, change: savedChange };
    if (seen.community !== community || savedChange === null || savedChange === seen.change) return;
    const { messageId, state, row } = savedChange;
    const shown = tabRef.current;
    if (!pendingRef.current.has(messageId)) {
      setEntries((rows) => {
        const rest = rows.filter((r) => r.messageId !== messageId);
        if (state === shown) {
          const had = rows.find((r) => r.messageId === messageId);
          if (had) return rows.map((r) => (r.messageId === messageId ? { ...r, state } : r));
          return row ? [row, ...rest] : rows;
        }
        return rest;
      });
      // 비어 있다고 그리던 칸도 끼운 행을 보여야 한다 — 읽기가 실패한 칸은 그대로 둔다.
      if (state === shown && row) setLoad((l) => (l.kind === 'loading' ? l : { kind: 'ready' }));
    }
    let alive = true;
    const mySeq = ++fetchSeqRef.current;
    const mine = communityRef.current;
    readsInFlightRef.current += 1;
    const settle = (): void => {
      readsInFlightRef.current -= 1;
      if (readsInFlightRef.current > 0) return;
      for (const id of settledRef.current) pendingRef.current.delete(id);
      settledRef.current.clear();
    };
    getController().loadSavedMessages(shown).then(
      (rows) => {
        if (alive && mySeq === fetchSeqRef.current && tabRef.current === shown && communityRef.current === mine) {
          setEntries(overlayPending(rows, shown, mine, pendingRef.current));
          setLoad({ kind: 'ready' });
        }
        settle();
      },
      () => { settle(); },
    );
    return () => { alive = false; };
    // `savedChange` 는 바뀔 때마다 새 객체다(`seq` 가 오른다).
  }, [savedChange, community]);

  useEffect(() => {
    // 배지와 `⋯` 메뉴 문구를 칸을 열 때 한 번 맞춰 둔다. 실패는 배지 숫자를 그대로 두는
    // 것뿐이라 여기서는 화면에 그리지 않는다 — 목록의 실패는 위에서 따로 보인다.
    void getController().loadSavedSummary().catch(() => undefined);
  }, []);

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

  // 목록은 닫지 않는다 — 본문만 그 메시지로 간다(위 컴포넌트 주석).
  const openEntry = (e: SavedMessageRow): void => {
    setSelectedId(e.messageId);
    void getController().openMessage(e.messageId);
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
    const mine = community;
    pendingRef.current.set(e.messageId, { row: e, to: next, community: mine });
    setEntries((rows) => rows.filter((r) => r.messageId !== e.messageId));
    try {
      await getController().updateSavedMessageState(e.messageId, next);
      if (readsInFlightRef.current === 0) pendingRef.current.delete(e.messageId);
      else settledRef.current.add(e.messageId);
    } catch (err: unknown) {
      pendingRef.current.delete(e.messageId);
      settledRef.current.delete(e.messageId);
      // 지금 보는 곳이 누른 때의 그 커뮤니티·그 탭일 때만 되돌려 끼운다.
      if (communityRef.current !== mine) { setMoveFailed(errorText(err, t)); return; }
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
   *
   * **두 줄이다.** 모달은 폭이 넓어 칩·작성자·본문·시각을 한 줄에 세웠는데, 사이드바 폭
   * (기본 260px 안팎)에서는 본문이 몇 글자만 남는다. 윗줄이 어디·누구·언제, 아랫줄이 본문
   * 두 줄까지다 — 무엇을 담았는지 알아보는 것은 본문이라 그쪽에 자리를 준다.
   */
  const entryRow = (e: SavedMessageRow) => {
    // 줄에는 짧은 도장, 긴 도장은 `title` 로 — 사이드바 폭에서 긴 꼴이 칩·작성자를 밀어냈다.
    const when = e.message?.createdAt ?? e.createdAt;
    const stamp = (
      <span className="ml-auto shrink-0 text-fg-subtle" title={stampLabel(when, locale)}>
        {shortStampLabel(when, locale)}
      </span>
    );
    // 시스템 메시지는 본문에 이름이 없고 자리표시자만 있다 — `displayBody` 를 지나지 않으면
    // 이 목록에만 그 글자가 남는다(#329).
    const body = e.message ? displayBody(e.message, accounts, groups, teams) : '';
    const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;
    const selected = selectedId === e.messageId;
    const chip = (
      <span className="min-w-0 max-w-[55%] shrink-0 truncate rounded-sm bg-surface-sunken px-1 uppercase tracking-wide text-fg-muted">
        {channelLabel(e.channelId)}
      </span>
    );

    return (
      <li key={e.messageId} className={`flex items-start gap-1 rounded-row px-2 py-1.5 hover:bg-surface-raised ${selected ? 'bg-surface-raised' : ''}`}>
        {/* #219 결정 3: 지워진 메시지도 자리가 남는다 — 담아 둔 사실은 내 기록이다.
            본문은 서버가 내주지 않으므로(`message: null`) 그릴 것이 없고, 갈 곳도 없어
            누를 수 없게 둔다. 눌러도 아무 일이 없는 버튼은 거짓 신호다(design.md §4). */}
        {e.message === null ? (
          <span
            data-testid={`saved-entry-${e.messageId}`}
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-meta">
              {chip}
              {stamp}
            </span>
            <span className="italic text-fg-subtle">{e.deleted ? t('saved.deleted') : t('saved.unavailable')}</span>
          </span>
        ) : (
          <button
            data-testid={`saved-entry-${e.messageId}`}
            aria-current={selected ? 'true' : undefined}
            onClick={() => openEntry(e)}
            className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-meta">
              {chip}
              <span className="min-w-0 truncate text-fg-muted">@{accounts[e.message.authorId]?.handle ?? '…'}</span>
              {stamp}
            </span>
            <span className="line-clamp-2 break-words text-fg">
              {preview}
            </span>
          </button>
        )}
        <button
          data-testid={`saved-toggle-${e.messageId}`}
          aria-label={e.state === 'open' ? t('saved.markDone') : t('saved.markOpen')}
          title={e.state === 'open' ? t('saved.markDone') : t('saved.markOpen')}
          onClick={() => { void toggleState(e); }}
          className="mt-0.5 shrink-0 rounded-row border border-border px-1.5 py-0.5 text-meta text-fg-muted hover:bg-surface-hover"
        >
          {e.state === 'open' ? '✓' : '↺'}
        </button>
      </li>
    );
  };

  // 탭은 칸 머리 아래 작은 두 칸이다 — 모달의 큰 알약을 그대로 옮기면 좁은 칸에서 목록보다 먼저 눈을 끈다.
  const tabButton = (value: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === value}
      data-testid={`saved-tab-${value}`}
      className={`rounded-row px-2 py-0.5 text-meta ${tab === value ? 'bg-accent text-fg-on-strong' : 'text-fg-muted hover:bg-surface-raised'}`}
      onClick={() => setTab(value)}
    >
      {label}
    </button>
  );

  return (
    <section aria-label={t('saved.label')} data-testid="saved-panel">
        {/* 칸 이름은 다른 칸의 묶음 머리(`FAVORITES`·`CHANNELS`)와 같은 모양이다. */}
        <div className="flex items-center gap-1 px-2 pb-1 text-meta uppercase tracking-wide text-fg-subtle">
          {t('chat.saved')}
        </div>
        <div role="tablist" aria-label={t('saved.label')} className="mb-1 flex items-center gap-1 px-2">
          {tabButton('open', t('saved.tabOpen'))}
          {tabButton('done', t('saved.tabDone'))}
        </div>
        <div>
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
    </section>
  );
}
