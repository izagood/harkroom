import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Identity } from './Identity';
import { daysWaiting, groupSimilar, laterUntilLabel, oneSentence, BOARD_KINDS, type BoardCard, type BoardGroup, type BoardKind } from '../lib/inboxBoard';
import { bodyWithHandles } from '../lib/mention';
import { useActiveStore } from '../state/communities';
import { useAgo, useLocale, useT } from '../i18n/useT';
import { dateTimeText } from '../lib/localeText';

/** 빈 배열 리터럴을 매 렌더 새로 만들지 않는다. */
const NO_TEAMS: never[] = [];

/** 치움·미룸 뒤 「되돌리기」를 띄워 두는 시간. 결정이 섞이면 더 길게(security #1315 n1) — 놓치면 결정이 조용히 사라진다. */
const TOAST_MS = 6_000;
const TOAST_DECISION_MS = 12_000;

export type InboxStateNext = { state: 'done' } | { state: 'later'; until: string } | { state: null };

/**
 * 목록의 갈래(A안 머리 칩). **할 일**(내 차례)이 기본이다. **소식**은 내 차례가 아닌 나머지 — 나를
 * 불렀지만 지금 내 손이 필요하지 않은 일(진행·기다림·끝)로, 읽기만 하면 된다. 미룬 것·치운 것은
 * 되돌리러 가는 곳이다. 7일 넘은 할 일은 할 일 맨 아래 한 줄로 접힌다(R2) — 갈래로 빼면 「사라진 것」으로 읽힌다.
 */
export type InboxListTab = 'todo' | 'news' | 'later' | 'cleared';
const TABS: readonly InboxListTab[] = ['todo', 'news', 'later', 'cleared'];
const TAB_KEY = {
  todo: 'inbox.list.tab.todo',
  news: 'inbox.list.tab.news',
  later: 'inbox.list.tab.later',
  cleared: 'inbox.list.tab.cleared',
} as const satisfies Record<InboxListTab, string>;

/** 할 일 안의 묶음 머리(R4). 보드의 짧은 이름이 아니라 「무엇을 하라는지」를 말한다. */
const SECTION_KEY = {
  decision: 'inbox.list.section.decision',
  blocker: 'inbox.list.section.blocker',
  news: 'inbox.list.section.news',
} as const satisfies Record<BoardKind, string>;

/** 줄 오른쪽의 종류 꼬리표. */
const KIND_KEY = {
  decision: 'inbox.board.kind.decision',
  blocker: 'inbox.board.kind.blocker',
  news: 'inbox.board.kind.news',
} as const satisfies Record<BoardKind, string>;

/** 나중에의 깨어날 시각 — **다음 날 아침 9시**(내 시계). `Inbox.tsx` 와 같은 규칙이다. */
export function tomorrowMorning(nowMs: number): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** 묶인 줄의 일 수(맨 앞 + 같이 묶인 것). */
const workCount = (groups: BoardGroup[]): number => groups.reduce((n, g) => n + 1 + g.similar.length, 0);

/** 키보드 단축키를 삼키면 안 되는 자리 — 글을 쓰는 중이다. */
function typingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

interface Props {
  /** `buildBoard` 가 낸 카드 전부. 이 화면이 갈래·묶음으로 나눈다. */
  cards: BoardCard[];
  busy: string | null;
  channelLabel: (channelId: string) => string;
  onOpen: (card: BoardCard) => void;
  onAnswer: (card: BoardCard, optionId: string) => Promise<void>;
  onSetState: (groups: BoardGroup[], next: InboxStateNext) => Promise<void>;
}

/**
 * Inbox **A안 — 할 일 목록 + 옆 상세**(designer 재설계, 2026-10-11 jaebin 선택).
 *
 * 메일 받은편지함처럼 왼쪽은 한 줄짜리 목록, 오른쪽은 **고른 것 하나**다. 옛 상태 보드는 「스레드의
 * 상태」를 보여 줬는데 사람이 묻는 것은 「내가 지금 무엇을 해야 하나」였다(designer 진단). 그래서
 * 목록은 내가 할 일의 종류(결정 → 막힘 → 소식)로 묶고, 오른쪽 칸이 왜 묻는지와 선택지를 그 자리에서 준다.
 *
 * - **J/K** 이동 · **E** 치우기 · **L** 나중에 · **↵** 스레드 열기. 글을 쓰는 중(입력칸 포커스)이나
 *   창이 떠 있을 때는 삼키지 않는다.
 * - 치우거나 미루면 그 줄이 빠지고 **같은 자리의 다음 줄**이 골라진다 — 위에서부터 차례로 비운다.
 * - 치우고 미룬 뒤에는 「되돌리기」 알림을 띄운다(designer n4) — 묶인 줄·전부 치우기는 여러 건이
 *   한 번에 사라지므로 실수를 바로 되돌릴 길이 있어야 한다.
 * - 좁은 자리(이 화면의 폭이 48rem 아래)에서는 목록만 서고, 줄을 누르면 상세가 목록을 대신한다(← 목록).
 *   창 폭이 아니라 **이 자리의 폭**으로 가른다 — 옆에 스레드를 열면 같은 창에서도 좁아진다.
 */
export function InboxList({ cards, busy, channelLabel, onOpen, onAnswer, onSetState }: Props) {
  const t = useT();
  const ago = useAgo();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS;

  const [tab, setTab] = useState<InboxListTab>('todo');
  const [staleOpen, setStaleOpen] = useState(false);
  /** 좁은 자리에서 상세가 목록을 대신하고 있나. 넓은 자리에서는 뜻이 없다(둘 다 선다). */
  const [detailOnly, setDetailOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  /** 고른 줄이 사라졌을 때(치움·미룸) 그 자리의 다음 줄을 고르려고 마지막 위치를 기억한다. */
  const lastIndex = useRef(0);
  /**
   * 되돌리기 알림. `pending` 인 동안은 [되돌리기]를 잠근다(security n2) — 묶음 치우기가 아직 도는 중에
   * 되돌리면 두 루프가 겹쳐 뒤쪽 일이 치운 채로 남는다. 알림 시간은 호출이 끝난 뒤부터 잰다.
   */
  const [toast, setToast] = useState<{ text: string; groups: BoardGroup[]; pending: boolean; ms: number } | null>(null);
  /** 이 화면의 뿌리. 단축키는 Inbox 자리 안에 포커스가 있을 때만 받는다(security F1). */
  const rootRef = useRef<HTMLDivElement | null>(null);

  const todo = useMemo(() => cards.filter((c) => c.column === 'mine' && c.fold === null), [cards]);
  const stale = useMemo(() => cards.filter((c) => c.column === 'mine' && c.fold === 'stale'), [cards]);
  // 소식은 열이 섞이므로 **최근에 움직인 순**으로 다시 세운다(보드는 열 순서로 준다).
  const news = useMemo(
    () => cards.filter((c) => c.column !== 'mine' && c.fold === null)
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)),
    [cards],
  );
  const later = useMemo(() => cards.filter((c) => c.fold === 'later'), [cards]);
  const cleared = useMemo(() => cards.filter((c) => c.fold === 'cleared'), [cards]);

  const sections = useMemo(
    () => BOARD_KINDS.map((kind) => ({ kind, groups: groupSimilar(todo.filter((c) => c.kind === kind)) })).filter((s) => s.groups.length > 0),
    [todo],
  );
  const staleGroups = useMemo(() => groupSimilar(stale), [stale]);
  const newsGroups = useMemo(() => groupSimilar(news), [news]);
  const laterGroups = useMemo(() => groupSimilar(later), [later]);
  const clearedGroups = useMemo(() => groupSimilar(cleared), [cleared]);

  /** 지금 보이는 줄들, 화면 순서대로 — J/K 가 이 순서를 걷는다. */
  const rows = useMemo<BoardGroup[]>(() => {
    if (tab === 'news') return newsGroups;
    if (tab === 'later') return laterGroups;
    if (tab === 'cleared') return clearedGroups;
    return [...sections.flatMap((s) => s.groups), ...(staleOpen ? staleGroups : [])];
  }, [tab, sections, staleGroups, staleOpen, newsGroups, laterGroups, clearedGroups]);

  const current = useMemo<BoardGroup | null>(() => {
    if (rows.length === 0) return null;
    const i = rows.findIndex((g) => g.card.rootId === selected);
    if (i >= 0) return rows[i]!;
    return rows[Math.min(lastIndex.current, rows.length - 1)]!;
  }, [rows, selected]);
  const currentIndex = current ? rows.indexOf(current) : -1;
  useEffect(() => { if (currentIndex >= 0) lastIndex.current = currentIndex; }, [currentIndex]);

  const select = useCallback((g: BoardGroup | undefined) => {
    if (!g) return;
    setSelected(g.card.rootId);
  }, []);

  /** 상태를 바꾸고 되돌리기 알림을 띄운다. 호출이 끝날 때까지 알림의 [되돌리기]는 잠겨 있다. */
  const act = useCallback((gs: BoardGroup[], next: InboxStateNext, text: string) => {
    if (gs.length === 0) return;
    const hasDecision = gs.some((g) => [g.card, ...g.similar].some((c) => c.kind === 'decision'));
    const mine = { text, groups: gs, pending: true, ms: hasDecision ? TOAST_DECISION_MS : TOAST_MS };
    setToast(mine);
    const settle = (): void => setToast((cur) => (cur && cur.groups === gs ? { ...cur, pending: false } : cur));
    onSetState(gs, next).then(settle, settle);
  }, [onSetState]);
  useEffect(() => {
    if (!toast || toast.pending) return;
    const id = setTimeout(() => setToast(null), toast.ms);
    return () => clearTimeout(id);
  }, [toast]);

  const dismiss = useCallback((gs: BoardGroup[]) => {
    act(gs, { state: 'done' }, t('inbox.list.toast.dismissed', { count: workCount(gs) }));
  }, [act, t]);
  const snooze = useCallback((gs: BoardGroup[]) => {
    act(gs, { state: 'later', until: tomorrowMorning(Date.now()) }, t('inbox.list.toast.later', { count: workCount(gs) }));
  }, [act, t]);
  const restore = useCallback((gs: BoardGroup[]) => { void onSetState(gs, { state: null }); }, [onSetState]);

  /**
   * 단축키. **Inbox 자리(`<aside>`) 안에 포커스가 있을 때만** 받는다(security #1315 F1). Inbox 는 모달이
   * 아니라 옆에 스레드·채널을 같이 연다 — document 전체에서 받으면 옆 스레드를 읽던 사람의 E 가 보지도
   * 않은 결정을 치우고, ↑/↓·↵ 가 옆의 스크롤·메뉴 이동을 먹는다. Inbox 를 열면 포커스가 이 자리로
   * 들어오고(`Inbox.tsx`) 줄을 누르면 그 줄에 있으므로, 이 화면을 보는 동안은 그대로 듣는다.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const pane = rootRef.current?.closest('aside') ?? rootRef.current;
      if (!pane || !(e.target instanceof Node) || !pane.contains(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      if (key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); select(rows[Math.min(currentIndex + 1, rows.length - 1)]); return; }
      if (key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); select(rows[Math.max(currentIndex - 1, 0)]); return; }
      if (!current) return;
      const folded = current.card.fold === 'later' || current.card.fold === 'cleared';
      // 손대는 중인 줄에 또 보내지 않는다(security n3).
      if ((key === 'e' || key === 'l') && busy === current.card.rootId) { e.preventDefault(); return; }
      if (key === 'e' && !folded) { e.preventDefault(); dismiss([current]); return; }
      if (key === 'l' && !folded) { e.preventDefault(); snooze([current]); return; }
      // 버튼에 포커스가 있으면 ↵ 는 그 버튼의 것이다 — 두 번 일하지 않게 넘긴다.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); onOpen(current.card); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [rows, current, currentIndex, select, dismiss, snooze, onOpen, busy]);

  const decisionCount = workCount(sections.find((s) => s.kind === 'decision')?.groups ?? []);
  const blockerCount = workCount(sections.find((s) => s.kind === 'blocker')?.groups ?? []);
  const staleDecisions = stale.filter((c) => c.kind === 'decision').length;

  const rowView = (g: BoardGroup) => {
    const { card } = g;
    const who = card.whoId ? accounts[card.whoId] : undefined;
    const days = daysWaiting(card.sinceAt, Date.now());
    const on = current?.card.rootId === card.rootId;
    return (
      <li key={card.rootId}>
        <button
          type="button"
          data-testid={`inbox-card-${card.rootId}`}
          data-column={card.column}
          data-unread={card.unread ? 'true' : 'false'}
          aria-current={on ? 'true' : undefined}
          onClick={() => { select(g); setDetailOnly(true); }}
          onDoubleClick={() => onOpen(card)}
          className={`flex w-full items-start gap-2 rounded-row border-l-2 px-2 py-1.5 text-left ${
            on ? 'border-accent bg-accent-surface' : card.unread ? 'border-accent/50 hover:bg-surface-hover' : 'border-transparent hover:bg-surface-hover'}`}
        >
          {who
            ? <Identity account={who} className="mt-0.5 h-6 w-6 shrink-0 text-meta" variant="avatar" />
            : <span className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span data-testid={`inbox-card-summary-${card.rootId}`} className={`min-w-0 truncate ${card.unread ? 'font-medium text-fg' : 'text-fg'}`}>
                {bodyWithHandles(card.summary, accounts, groups, teams)}
              </span>
              {g.similar.length > 0 && (
                <span data-testid={`inbox-card-similar-${card.rootId}`} className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-meta text-fg-muted">
                  {t('inbox.board.similar', { count: g.similar.length + 1 })}
                </span>
              )}
            </span>
            {/* 누가 · 채널. 이름은 자르지 않고 채널부터 줄인다(R6) — 채널은 세 글자 폭은 지킨다(d1). */}
            <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-meta text-fg-subtle">
              {who && <span data-testid={`inbox-card-who-${card.rootId}`} className="shrink-0 text-fg-muted">{who.handle}</span>}
              <span data-testid={`inbox-card-channel-${card.rootId}`} className="min-w-[3ch] truncate">· {channelLabel(card.channelId)}</span>
            </span>
          </span>
          {/* 오른쪽 한 자리 — 종류 · 기다린 시간 · 새 말을 **같은 자리**에 모은다(designer). */}
          <span className="flex shrink-0 flex-col items-end gap-0.5 text-meta">
            <span
              data-testid={`inbox-card-age-${card.rootId}`}
              title={dateTimeText(card.sinceAt, locale)}
              className={days != null && card.column === 'mine' ? 'text-state-turn' : 'text-fg-subtle'}
            >
              {days != null ? t('inbox.board.days', { count: days }) : ago(new Date(card.sinceAt).getTime())}
            </span>
            <span className="flex items-center gap-1">
              {card.unread && <span data-testid={`inbox-card-unread-${card.rootId}`} className="text-accent">{t('inbox.board.unread')}</span>}
              <span className="text-fg-subtle">{t(KIND_KEY[card.kind])}</span>
            </span>
          </span>
        </button>
      </li>
    );
  };

  const detailView = (g: BoardGroup) => {
    const { card } = g;
    const who = card.whoId ? accounts[card.whoId] : undefined;
    const replies = card.replyCount ?? 0;
    // 맥락 줄 — 나에게 온 말 중 가장 최근 것, 단 제목과 같은 문장은 건너뛴다(물음 자신을 되풀이하지 않게).
    const latest = card.entries.find((e) => { const line = oneSentence(e.body); return line !== '' && line !== card.summary; });
    const latestLine = latest ? oneSentence(latest.body) : '';
    const latestWho = latest?.authorId ? accounts[latest.authorId] : undefined;
    const folded = card.fold === 'later' || card.fold === 'cleared';
    return (
      <div data-testid="inbox-detail" data-root={card.rootId} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <button
          type="button"
          data-testid="inbox-detail-back"
          onClick={() => setDetailOnly(false)}
          className="self-start rounded-row px-1 text-meta text-fg-muted hover:bg-surface-hover @3xl:hidden"
        >
          ← {t('inbox.list.back')}
        </button>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-meta text-fg-subtle">
          {who && <Identity account={who} className="h-5 w-5 shrink-0 text-meta" variant="avatar" />}
          {who && <span className="font-medium text-fg-muted">{who.handle}</span>}
          <span>· {channelLabel(card.channelId)}</span>
          <span title={dateTimeText(card.sinceAt, locale)}>· {ago(new Date(card.sinceAt).getTime())}</span>
          {replies > 0 && <span data-testid={`inbox-card-replies-${card.rootId}`}>· {t('inbox.board.replies', { count: replies })}</span>}
          {card.laterUntil && (
            <span data-testid={`inbox-card-later-until-${card.rootId}`} title={dateTimeText(card.laterUntil, locale)}>
              · {t('inbox.board.laterUntil', { when: laterUntilLabel(card.laterUntil, Date.now(), locale, t) })}
            </span>
          )}
        </div>
        <p className="break-words text-name text-fg">
          {bodyWithHandles(card.summary, accounts, groups, teams)}
          {g.similar.length > 0 && (
            <span className="ml-1.5 rounded-full bg-surface-sunken px-1.5 text-meta text-fg-muted">{t('inbox.board.similar', { count: g.similar.length + 1 })}</span>
          )}
        </p>
        {/* 스레드의 마지막 말 — 왜 묻는지의 맥락. 제목과 같으면 되풀이하지 않는다. */}
        {latestLine && (
          <div data-testid="inbox-detail-latest" className="rounded-row border border-border bg-surface-sunken p-2 text-meta text-fg-muted">
            <span className="font-medium">{t('inbox.list.latest')}{latestWho ? ` · ${latestWho.handle}` : ''}</span>
            <p className="mt-0.5 break-words text-fg">{bodyWithHandles(latestLine, accounts, groups, teams)}</p>
          </div>
        )}
        {/* 선택지 줄 — 행동 줄과 **어떤 폭에서도 합치지 않는다**(designer d1·n3). */}
        {card.ask && (
          <div className="flex flex-col gap-1.5">
            {card.ask.options.map((o) => (
              <button
                key={o.id}
                type="button"
                data-testid={`inbox-card-answer-${card.rootId}-${o.id}`}
                disabled={busy === card.rootId}
                onClick={() => void onAnswer(card, o.id)}
                className="rounded-row border border-border px-3 py-1.5 text-left text-fg hover:bg-surface-hover disabled:opacity-50"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-meta">
          <button
            type="button"
            data-testid={`inbox-card-open-${card.rootId}`}
            onClick={() => onOpen(card)}
            className="rounded-row bg-accent px-2.5 py-1 text-fg-on-strong hover:bg-accent-hover"
          >
            {t('inbox.list.openThread')} <kbd className="ml-1 opacity-70">↵</kbd>
          </button>
          {folded ? (
            <button
              type="button"
              data-testid={`inbox-card-undo-${card.rootId}`}
              disabled={busy === card.rootId}
              onClick={() => restore([g])}
              className="rounded-row px-2.5 py-1 text-fg-muted hover:bg-surface-hover disabled:opacity-50"
            >
              {t('inbox.board.undo')}
            </button>
          ) : (
            <>
              <button
                type="button"
                data-testid={`inbox-card-later-${card.rootId}`}
                disabled={busy === card.rootId}
                onClick={() => snooze([g])}
                className="rounded-row px-2.5 py-1 text-fg-muted hover:bg-surface-hover disabled:opacity-50"
              >
                {t('inbox.board.later')} <kbd className="ml-1 opacity-70">L</kbd>
              </button>
              <button
                type="button"
                data-testid={`inbox-card-done-${card.rootId}`}
                disabled={busy === card.rootId}
                onClick={() => dismiss([g])}
                className="rounded-row px-2.5 py-1 text-fg-muted hover:bg-surface-hover disabled:opacity-50"
              >
                {t('inbox.board.done')} <kbd className="ml-1 opacity-70">E</kbd>
              </button>
            </>
          )}
          <span className="ml-auto text-fg-subtle">{t('inbox.list.keys')}</span>
        </div>
      </div>
    );
  };

  const tabCount = (k: InboxListTab): number => ({ todo: todo.length, news: news.length, later: later.length, cleared: cleared.length })[k];

  return (
    <div ref={rootRef} data-testid="inbox-list-view" className="@container flex min-h-0 flex-1 flex-col">
      {/* 머리 한 줄 — 「답할 것 N · 막힘 M」이 오늘 남은 일을 말한다(B안의 요약을 여기로). */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <div role="tablist" aria-label={t('inbox.list.tabs')} className="flex flex-wrap gap-1">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              data-testid={`inbox-tab-${k}`}
              onClick={() => { setTab(k); setDetailOnly(false); }}
              className={`rounded-full border px-2 py-0.5 text-meta ${tab === k
                ? 'border-transparent bg-accent-surface text-accent' : 'border-border text-fg-muted hover:bg-surface-hover'}`}
            >
              {t(TAB_KEY[k])} <span className="text-fg-subtle">{tabCount(k)}</span>
            </button>
          ))}
        </div>
        {tab === 'todo' && (decisionCount > 0 || blockerCount > 0) && (
          <span data-testid="inbox-list-summary" className="ml-auto text-meta text-state-turn">
            {t('inbox.list.summary', { decision: decisionCount, blocker: blockerCount })}
          </span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 목록 — 넓은 자리에서는 왼쪽 고정 폭, 좁은 자리에서는 전폭(상세가 대신하면 숨는다). */}
        <div className={`${detailOnly ? 'hidden' : 'flex'} min-h-0 w-full flex-col overflow-y-auto @3xl:flex @3xl:w-[26rem] @3xl:shrink-0 @3xl:border-r @3xl:border-border`}>
          {rows.length === 0 && !(tab === 'todo' && stale.length > 0) && (
            <p data-testid="inbox-list-empty" className="p-3 text-meta text-fg-subtle">
              {t(tab === 'todo' ? 'inbox.board.empty.mine' : 'inbox.board.empty.other')}
            </p>
          )}
          {tab === 'todo' && sections.map(({ kind, groups: gs }) => (
            <section key={kind} data-testid={`inbox-section-${kind}`} aria-label={t(SECTION_KEY[kind])} className="py-1">
              <h3 className="flex items-baseline gap-1 px-3 py-1 text-meta font-medium text-fg-muted">
                {t(SECTION_KEY[kind])}
                <span data-testid={`inbox-section-count-${kind}`} className="font-normal text-fg-subtle">· {workCount(gs)}</span>
              </h3>
              <ul className="flex flex-col px-1">{gs.map(rowView)}</ul>
            </section>
          ))}
          {/* 7일 넘게 기다린 것(R2) — 수에서 빠지고 한 줄로 접힌다. 결정이 섞여 있으면 그 수를 같이
              말한다(designer n2) — 잊힌 권한 요청이 있다는 것은 보여야 한다. */}
          {tab === 'todo' && stale.length > 0 && (
            <div data-testid="inbox-stale" className="border-t border-border px-3 py-2">
              <div className="flex items-center gap-2 text-meta text-fg-subtle">
                <span data-testid="inbox-stale-label">
                  {t('inbox.board.fold.stale', { count: stale.length })}
                  {staleDecisions > 0 && <span className="text-state-turn"> · {t('inbox.list.staleDecisions', { count: staleDecisions })}</span>}
                </span>
                <button
                  type="button"
                  data-testid="inbox-stale-toggle"
                  aria-expanded={staleOpen}
                  onClick={() => setStaleOpen((v) => !v)}
                  className="ml-auto rounded-row px-1.5 hover:bg-surface-hover hover:text-fg-muted"
                >
                  {t(staleOpen ? 'inbox.list.collapse' : 'inbox.list.expand')}
                </button>
                <button
                  type="button"
                  data-testid="inbox-stale-clear-all"
                  onClick={() => dismiss(staleGroups)}
                  className="rounded-row px-1.5 hover:bg-surface-hover hover:text-fg-muted"
                >
                  {t('inbox.list.clearAll')}
                </button>
              </div>
              {staleOpen && <ul className="mt-1 flex flex-col">{staleGroups.map(rowView)}</ul>}
            </div>
          )}
          {tab !== 'todo' && rows.length > 0 && <ul className="flex flex-col px-1 py-1">{rows.map(rowView)}</ul>}
        </div>
        {/* 상세 — 넓은 자리에서는 늘 서고, 좁은 자리에서는 줄을 눌렀을 때만 목록을 대신한다. */}
        <div className={`${detailOnly ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col @3xl:flex`}>
          {current
            ? detailView(current)
            : <p className="m-auto p-6 text-meta text-fg-subtle">{t('inbox.list.pick')}</p>}
        </div>
      </div>
      {/* 되돌리기 알림(designer n4). 알림 영역이라 스크린리더가 읽는다. */}
      {toast && (
        <div role="status" data-testid="inbox-toast" className="mx-3 mb-3 flex items-center gap-3 rounded-row bg-surface-raised px-3 py-2 text-meta shadow-md ring-1 ring-border">
          <span className="text-fg">{toast.text}</span>
          <button
            type="button"
            data-testid="inbox-toast-undo"
            disabled={toast.pending}
            onClick={() => { restore(toast.groups); setToast(null); }}
            className="ml-auto rounded-row px-2 py-0.5 font-medium text-accent hover:bg-surface-hover disabled:opacity-50"
          >
            {t('inbox.list.toast.undo')}
          </button>
        </div>
      )}
    </div>
  );
}
