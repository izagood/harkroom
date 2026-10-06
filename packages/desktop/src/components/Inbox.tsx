import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Identity } from './Identity';
import type { InboxEntry, InboxThreadState, MessageRow } from '@harkroom/shared';
import { buildBoard, daysWaiting, laterUntilLabel, mineCount, type BoardCard, type BoardColumn, type BoardFold } from '../lib/inboxBoard';
import { bodyWithHandles } from '../lib/mention';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useAgo, useLocale, useT } from '../i18n/useT';

/** 빈 배열 리터럴을 매 렌더 새로 만들지 않는다. */
const INBOX_NO_TEAMS: never[] = [];

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 조회 상태를 셋으로 나눈다(#226 의 Directory 와 같은 모양). 둘로 두면 **"못 불러왔다"가
 * "아무도 안 불렀다"로 보인다** — inbox 에서는 그 거짓말의 값이 특히 비싸다.
 */
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

const THREAD_PREFIX = 'thread:';

/** 열 맨 아래 접힘 줄의 이름. 접힌 카드는 사라지지 않는다 — 수와 함께 한 줄로 남는다. */
const FOLD_KEY = {
  quiet: 'inbox.board.fold.quiet',
  old: 'inbox.board.fold.old',
  cleared: 'inbox.board.fold.cleared',
  later: 'inbox.board.fold.later',
} as const satisfies Record<BoardFold, string>;
/** 열마다 접힘 줄의 순서. 나중에는 어느 열에나 서고, 진행은 조용한 것, 끝남은 지난 것 → 치운 것. */
const COLUMN_FOLDS: Record<BoardColumn, readonly BoardFold[]> = {
  mine: ['later'], blocked: ['later'], active: ['quiet', 'later'], done: ['old', 'later', 'cleared'],
};

/** 나중에의 깨어날 시각 — **다음 날 아침 9시**(내 시계). 하루 미룸이 가장 흔한 뜻이다. */
function tomorrowMorning(nowMs: number): string {
  const d = new Date(nowMs);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * 「내 작업」 화면의 자리(designer W2 안 82644a8f). **내 차례는 열이 아니라 맨 위 전폭 띠**이고,
 * 그 아래 세 열이 진행 → 기다림 → 끝 순서로 선다. 판정은 그대로 `buildBoard` 다 — 바뀐 것은 놓는 자리뿐이다.
 */
const LANE_COLUMNS: readonly Exclude<BoardColumn, 'mine'>[] = ['active', 'blocked', 'done'];
/** 띠에 펼쳐 두는 장수. 넘치면 "+N개 더" 로 접는다 — 띠가 화면을 다 먹으면 세 열이 사라진다. */
const BAND_LIMIT = 5;
/**
 * 열 머리의 상태 이모지 — 채널의 스레드 상태 리액션(088)과 **같은 말**이다. 장식이라 읽지 않는다
 * (`aria-hidden`); 구획 이름은 글자 키가 진다.
 */
const COLUMN_EMOJI = { mine: '🙋', active: '💬', blocked: '⏳', done: '✅' } as const satisfies Record<BoardColumn, string>;

/** 열 이름 키. 화면이 제 손으로 글자를 적지 않는다. */
const COLUMN_KEY = {
  mine: 'inbox.board.col.mine',
  blocked: 'inbox.board.col.blocked',
  active: 'inbox.board.col.active',
  done: 'inbox.board.col.done',
} as const satisfies Record<BoardColumn, string>;

/**
 * 나를 부른 것을 **일(스레드) 단위 상태 보드**로 보는 표면(#185 → C안, 2026-10-01).
 *
 * ## 보드 (C안)
 *
 * 열 넷 — **내 차례 / 막힘 / 진행 / 끝남**. 카드 하나가 스레드 하나이고, 해야 할 일 한 문장과
 * 채널·누가·얼마나 기다렸나를 말한다. 묶기와 열 판정은 `lib/inboxBoard` 가 하고, 열은
 * 스레드 머리의 지금 상태(`GET /inbox?threads=1`)가 정한다. 옛 칩 넷·"To read" 수·
 * "Waiting on" 목록은 없앴다 — 줄지 않는 숫자와 내용 없는 목록이 이 화면을 소음으로 만들었다
 * (designer 진단). **숫자는 내 차례만 센다** — 0 이 될 수 있는 수만 뜻이 있다.
 *
 * 카드에서 그 자리 처리: 나에게 온 물음은 카드에서 고르고, 완료·나중에는 서버의 내 상태다
 * (끝남 맨 아래로 접힌다 — 서버의 완료·나중에 상태는 2/2).
 *
 * ## 모달이 아니라 **자리**다 (#488 C2)
 *
 * 정본 문서(`docs/desktop-remaining-gaps.html` C2): *"지금은 채널 위에 뜨는 모달이라
 * 스레드를 보면서 열어 둘 수 없다. **막는 말을 확인하면서 그 스레드를 여는 것이 기본
 * 동작**인데, 모달이 그걸 막는다."*
 *
 * 그래서 `Overlay` 를 벗었다. 여는 입구는 그대로다 — 사이드바 홈 **맨 위 한 줄**
 * (`docs/desktop-rail.html`). 바뀐 것은 **열린 뒤**다.
 *
 * ### 어느 축인가 — **채널 열을 대신한다** (2026-09-11)
 *
 * 오래 **채널의 왼쪽 열**이었다. 그 자리가 고른 것은 옳았고(인박스와 스레드가 동시에
 * 보여야 한다), 틀린 것은 **열을 하나 더 만든 것**이다 — 레일·사이드바·인박스·채널·스레드
 * 다섯이 서면 맨 오른쪽이 잘리고, 하필 잘리는 것이 함께 보여야 할 그 스레드였다
 * (2026-09-11 신고). 지금은 인박스가 **본문 자리**를 차지한다(배선은 `Workspace.tsx`).
 *
 * 그래서 폭이 사라졌다. 400px 고정이 아니라 **본문 폭을 채운다**(`flex-1`) — 좁아져도
 * 사라지지 않게 막던 `MIN_INBOX_PANE_WIDTH` 도 함께 지웠다: 본문 열의 하한은 이제
 * 오른쪽 패널들이 지킨다(`ThreadPanel` 의 `paneMaxWidth(..., MIN_CHANNEL_WIDTH)`).
 *
 * ### 누른 것은 반드시 보인다
 *
 * 본문을 차지하면 **줄이 여는 목적지가 인박스 뒤에 숨을 수 있다.** 그래서 규칙 하나를
 * 둔다 — 목적지가 스레드면 인박스는 남고(스레드는 오른쪽에 서므로 둘이 함께 보인다,
 * 문서가 말한 기본 동작 그대로), 목적지가 채널·DM 본문이면 인박스가 **자리를 내준다**.
 * 판정은 `openEntry`·`openDraft` 에 있다.
 *
 * ### Esc·닫기·포커스 — `Overlay` 가 주던 것을 무엇으로 대신했나
 *
 * | `Overlay` 가 주던 것 | 자리가 된 뒤 |
 * |---|---|
 * | 스크림 | **버린다.** 덮지 않는 것이 이 작업의 요지다. |
 * | 바깥 클릭으로 닫기 | **버린다.** 자리는 옆에 선 것이라 "바깥"이 곧 사이드바·스레드다 — 스레드를 읽으려 누른 클릭이 인박스를 닫으면 문서가 말한 기본 동작이 불가능해진다. 인박스가 스스로 접히는 경우는 **하나**이고 그것은 바깥 클릭이 아니라 목적지 판정이다(위 "누른 것은 반드시 보인다"). |
 * | Esc | **남긴다**(아래 `useEffect`). 뜻이 "덮은 것을 걷는다"에서 "이 자리를 접는다"로 바뀐다 — `⌘\` 와 같은 종류다. |
 * | `role="dialog"` + 이름 | `role="complementary"`(`<aside>`) + `aria-label`. 랜드마크로 남아 스크린리더가 이 자리를 찾을 수 있다. |
 * | 포커스 트랩 | **일부러 두지 않는다.** 트랩은 정확히 이 작업이 걷어내려는 것이다(스레드로 탭해 갈 수 없게 된다). 대신 **열 때 포커스를 이 자리로 옮긴다** — 열었는데 포커스가 사이드바에 남아 있으면 키보드 사용자에게는 아무 일도 일어나지 않은 것이다. |
 *
 * 닫는 길은 둘이다: Esc 와 닫기 버튼. 버튼은 `<button>` 이라 탭 순서와 Enter/Space 를
 * 브라우저에서 받는다.
 *
 * ### 좁은 창
 *
 * 새 수단을 만들지 않았다. `docs/desktop-rail.html` 이 값을 이미 적어 뒀고 —
 * *"좁은 창에서는 레일만 남기고 패널을 접는 단계가 하나 더 필요하다"* — `Workspace` 가
 * 그 단계를 `⌘\`(사이드바 접기)로 이미 얹었다. 인박스가 Esc 를 document 에서 받으므로
 * **`⌘\` 를 삼키지 않는 것**이 여기서 지켜야 할 것이고, `inboxPane.test.tsx` 가 그것을
 * 잰다.
 *
 */
export function Inbox({ open, onClose }: Props) {
  const t = useT();
  const ago = useAgo();
  const locale = useLocale();
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  // 문장의 집합·팀 토큰(#845). 안 주면 그 자리가 `@알 수 없음` 이 된다.
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? INBOX_NO_TEAMS;
  const me = useActiveStore((s) => s.me);
  const drafts = useActiveStore((s) => s.drafts);
  /** 컨트롤러가 보드 재료를 새로 받은 횟수. 열려 있는 동안 "다시 그려라"로 쓴다(아래 effect). */
  const boardRevision = useActiveStore((s) => s.inboxBoardRevision);
  /** 지금 손대는 카드(답·완료). 두 번 눌러 두 번 보내지 않게 한다. */
  const [busy, setBusy] = useState<string | null>(null);

  const [entries, setEntries] = useState<InboxEntry[]>([]);
  /** `null` = 서버가 머리를 안 줬다(옛 서버). 보드가 항목 `meta` 로 판정한다. */
  const [threads, setThreads] = useState<MessageRow[] | null>(null);
  /** 내 완료·나중에(서버, 2/2). */
  const [threadStates, setThreadStates] = useState<InboxThreadState[]>([]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });

  /**
   * 나간 순서를 재는 번호 — 겹친 두 조회 중 **먼저 나간 응답이 나중에 도착하면** 낡은
   * 보드가 새 보드를 덮는다. 취소 플래그(`alive`)는 "이 화면이 아직 사나"만 안다.
   */
  const reloadSeq = useRef(0);

  /**
   * `quiet` 는 사람이 기다리지 않는 재조회다(라이브 갱신·카드를 연 뒤 읽음 맞추기). 화면을
   * "불러오는 중"으로 되돌리지 않고 실패도 세우지 않는다 — 읽던 자리가 사라지지 않게.
   */
  /**
   * 조회는 **컨트롤러를 지난다**(`loadInboxBoard`) — 배지와 같은 조회 하나를 나눠 쓰고, 여는 순간
   * 배지도 이 보드와 맞춰진다(#1076 후속).
   */
  const reload = useCallback((opts: { quiet?: boolean } = {}): (() => void) => {
    let alive = true;
    const seq = ++reloadSeq.current;
    if (!opts.quiet) setLoad({ kind: 'loading' });
    getController().loadInboxBoard().then(
      (res) => {
        if (!alive || seq !== reloadSeq.current) return;
        setEntries(res.entries);
        setThreads(res.threads);
        setThreadStates(res.threadStates);
        setLoad({ kind: 'ready' });
      },
      (err: unknown) => {
        if (!alive || opts.quiet || seq !== reloadSeq.current) return;
        // 실패했을 때 앞선 결과를 남겨 두면 낡은 보드가 지금 사실인 척한다.
        setEntries([]);
        setThreads(null);
        setThreadStates([]);
        setLoad({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    return reload();
  }, [open, reload]);

  /**
   * **열려 있는 동안 새로 온 것을 그린다**(2026-09-10 신고). 서버의 `inbox.updated` 에 컨트롤러가
   * 보드 재료를 다시 받고(배지 때문에 어차피 받는다) `inboxBoardRevision` 을 올린다. 이 화면은
   * **다시 조회하지 않고** 그 재료를 그린다 — 신호 하나에 조회 하나(#1076 security a).
   *
   * 조용히 그린다: "불러오는 중"으로 되돌리지 않는다. 이 화면이 낸 조회가 아직 돌고 있으면
   * (`reloadSeq` 가 앞서 있다) 그 조회의 결과가 곧 같은 재료로 그리므로 여기서는 건너뛰지 않아도
   * 된다 — 같은 컨트롤러 약속이라 순서가 거꾸로 올 수 없다.
   */
  const seenRevision = useRef(boardRevision);
  useEffect(() => {
    if (!open || seenRevision.current === boardRevision) {
      seenRevision.current = boardRevision;
      return;
    }
    seenRevision.current = boardRevision;
    const snap = getController().inboxBoardSnapshot();
    if (!snap) return;
    setEntries(snap.entries);
    setThreads(snap.threads);
    setThreadStates(snap.threadStates);
    setLoad({ kind: 'ready' });
  }, [open, boardRevision]);

  /** 채널 하나의 사람이 읽을 이름. DM 은 이름이 없으므로 상대 handle 로 짓는다. */
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

  const cards = useMemo(
    () => buildBoard({
      entries, threads, threadStates,
      me: me ? { id: me.id, kind: me.kind } : null,
      isAgent: (id) => accounts[id]?.kind === 'agent',
      nowMs: Date.now(),
    }),
    [entries, threads, threadStates, me, accounts],
  );
  const byColumn = useMemo(() => {
    const out: Record<BoardColumn, BoardCard[]> = { mine: [], blocked: [], active: [], done: [] };
    for (const c of cards) out[c.column].push(c);
    return out;
  }, [cards]);

  /** 쓰다 만 초안. 보드 밖 한 줄이다 — 남이 나를 부른 것이 아니라 내가 쓰다 만 것이라 열이 없다. */
  const draftKeys = useMemo(
    () => Object.entries(drafts).filter(([, body]) => body.trim().length > 0).map(([k]) => k),
    [drafts],
  );

  /** 이 자리의 뿌리. 열 때 포커스를 옮기는 곳이다. */
  const paneRef = useRef<HTMLElement | null>(null);

  /**
   * **Esc 로 접는다.** document 리스너인 이유: 옆의 채널·스레드를 읽는 동안 포커스는 늘
   * 인박스 밖에 있다. **오버레이가 떠 있으면 Esc 는 내 것이 아니다** — 자리는 늘 오버레이
   * 아래에 있다. `⌘\` 는 삼키지 않는다(좁은 창에서 빠져나오는 길이다, `inboxPane.test.tsx`).
   */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /** **열면 포커스가 이 자리로 들어온다**(모달의 포커스 트랩 대신). */
  useEffect(() => {
    if (!open) return;
    paneRef.current?.focus({ preventScroll: true });
  }, [open]);

  if (!open) return null;

  /**
   * 카드를 연다. **스레드면 오른쪽 패널로 열고 보드는 남는다** — 보드와 그 일을 나란히 보며
   * 처리하는 것이 기본 동작이다. 채널 바로 밑의 말 하나뿐이면 목적지가 본문이라 보드가
   * 자리를 내준다(누른 것이 보드 뒤에 숨으면 아무 일도 안 한 것과 구별되지 않는다).
   *
   * 읽음은 서버가 채널 단위로 바꾼다(`controller.openChannel`). 화면에서 그 채널의 줄을 바로
   * 읽음으로 걷고, 조용한 재조회로 서버 사실에 맞춘다.
   */
  const openCard = (card: BoardCard): void => {
    const at = new Date().toISOString();
    setEntries((rows) => rows.map((r) => (r.channelId === card.channelId && r.readAt === null ? { ...r, readAt: at } : r)));
    const isThread = card.entries.some((e) => e.threadRootId != null)
      || (threads?.find((m) => m.id === card.rootId)?.replyCount ?? 0) > 0;
    const go = isThread
      ? getController().openThread(card.rootId, { channelId: card.channelId })
      // 항목 없는 카드(inbox 밖 머리)는 머리 자체를 연다.
      : (onClose(), getController().openMessage(card.entries[0]?.messageId ?? card.rootId));
    void Promise.resolve(go).then(() => reload({ quiet: true }));
  };

  const answer = async (card: BoardCard, optionId: string): Promise<void> => {
    if (!card.ask) return;
    setBusy(card.rootId);
    try {
      await getController().answerAsk(card.ask.messageId, optionId, card.channelId);
      reload({ quiet: true });
    } finally { setBusy(null); }
  };

  /**
   * **완료·나중에·되돌리기** — 서버의 내 상태다(2/2). 남에게 보이는 표시를 남기지 않는다(1/2 의
   * ✅ 를 대신한다). 바꾼 뒤 조용히 다시 읽는다 — 서버가 내 다른 기기에도 `inbox.updated` 를 보낸다.
   */
  const setState = async (
    card: BoardCard, next: { state: 'done' } | { state: 'later'; until: string } | { state: null },
  ): Promise<void> => {
    setBusy(card.rootId);
    try {
      await getController().api.setInboxThreadState(card.rootId, next);
      reload({ quiet: true });
    } finally { setBusy(null); }
  };

  const cardView = (card: BoardCard) => {
    const who = card.whoId ? accounts[card.whoId] : undefined;
    const days = daysWaiting(card.sinceAt, Date.now());
    const more = card.entries.length - 1;
    return (
      <li key={card.rootId} className="rounded-row border border-border bg-surface-raised">
        <button
          data-testid={`inbox-card-${card.rootId}`}
          data-column={card.column}
          data-unread={card.unread ? 'true' : 'false'}
          onClick={() => openCard(card)}
          className={`flex w-full flex-col gap-1 rounded-row border-l-2 px-2 py-1.5 text-left hover:bg-surface-hover ${
            card.unread ? 'border-accent' : 'border-transparent'}`}
        >
          {/* **해야 할 일 한 문장.** 잘라 낸 본문 두 줄이 아니라 고른 한 문장이다(`oneSentence`). */}
          <span data-testid={`inbox-card-summary-${card.rootId}`} className="line-clamp-2 break-words text-fg">
            {bodyWithHandles(card.summary, accounts, groups, teams)}
          </span>
          {/* 채널 · 누가 · 얼마나. 넘치면 채널 이름부터 줄인다 — 시각은 잘리면 뜻을 잃는다. */}
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta text-fg-subtle">
            {who && <Identity account={who} className="h-5 w-5 shrink-0 text-[10px]" variant="avatar" />}
            {/* 좁으면 **작성자부터** 줄인다(designer) — 얼굴이 이미 누군지 말하고, 채널은 대신할 것이 없다. */}
            {who && <span aria-hidden="true" className="min-w-0 shrink-[10] truncate font-medium text-fg-muted">{who.handle}</span>}
            {/* 채널은 줄지 않는다 — 다만 아주 긴 이름이 줄을 다 먹지 않게 폭의 절반 가까이에서 자른다. */}
            <span className="max-w-[45%] shrink-0 truncate">{channelLabel(card.channelId)}</span>
            <span
              className={`shrink-0 ${days != null && card.column === 'mine' ? 'text-state-turn' : ''}`}
              data-testid={`inbox-card-age-${card.rootId}`}
              title={new Date(card.sinceAt).toLocaleString()}
            >
              · {days != null ? t('inbox.board.days', { count: days }) : ago(new Date(card.sinceAt).getTime())}
            </span>
            {more > 0 && <span className="shrink-0">· {t('inbox.board.more', { count: more })}</span>}
            {card.unread && <span className="shrink-0 text-accent">· {t('inbox.board.unread')}</span>}
            {/* 미룬 카드는 **언제 다시 서는지** 말한다(designer) — 되돌릴지 그냥 둘지 정하는 근거다. */}
            {card.laterUntil && (
              <span className="shrink-0" data-testid={`inbox-card-later-until-${card.rootId}`} title={new Date(card.laterUntil).toLocaleString()}>
                · {t('inbox.board.laterUntil', { when: laterUntilLabel(card.laterUntil, Date.now(), locale, t) })}
              </span>
            )}
          </span>
        </button>
        {/*
          그 자리 처리. 버튼은 카드 **바깥**에 둔다 — `<button>` 안의 `<button>` 은 HTML 이
          허용하지 않고, 고르려다 스레드가 열린다.
        */}
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          {card.ask?.options.map((o) => (
            <button
              key={o.id}
              data-testid={`inbox-card-answer-${card.rootId}-${o.id}`}
              disabled={busy === card.rootId}
              onClick={() => void answer(card, o.id)}
              className="rounded-row border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-hover disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
          {/*
            접힌 카드(치움·나중에)는 **되돌리기** 하나. 펼친 카드는 나중에 + 완료 — 단, 내 차례에는
            완료가 없다(내 차례가 치움을 이겨 눌러도 그 자리에 남는다). 나중에는 내 차례에도 있다:
            그래야 지금 못 할 일을 수에서 뺄 수 있다.
          */}
          {card.fold === 'cleared' || card.fold === 'later'
            ? (
              <button
                data-testid={`inbox-card-undo-${card.rootId}`}
                disabled={busy === card.rootId}
                onClick={() => void setState(card, { state: null })}
                className="ml-auto rounded-row px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover disabled:opacity-50"
              >
                {t('inbox.board.undo')}
              </button>
            )
            : (
              <span className="ml-auto flex gap-1">
                <button
                  data-testid={`inbox-card-later-${card.rootId}`}
                  disabled={busy === card.rootId}
                  onClick={() => void setState(card, { state: 'later', until: tomorrowMorning(Date.now()) })}
                  className="rounded-row px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover disabled:opacity-50"
                >
                  {t('inbox.board.later')}
                </button>
                {card.column !== 'mine' && (
                  <button
                    data-testid={`inbox-card-done-${card.rootId}`}
                    disabled={busy === card.rootId}
                    onClick={() => void setState(card, { state: 'done' })}
                    className="rounded-row px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover disabled:opacity-50"
                  >
                    {t('inbox.board.done')}
                  </button>
                )}
              </span>
            )}
        </div>
      </li>
    );
  };

  // 접힌 것(나중에)은 세지 않는다 — 미룬 일은 지금 나를 기다리는 일이 아니다.
  // 배지와 같은 함수다(`lib/inboxBoard::mineCount`) — 두 숫자가 갈릴 자리가 없게.
  const mine = mineCount(cards);

  return (
    <aside
      ref={paneRef}
      data-testid="inbox-pane"
      // `<aside>` 가 랜드마크(`complementary`)다. `tabIndex={-1}`: 스크립트로만 포커스를 받는다.
      // 폭은 본문 열 그대로(`flex-1`), `min-w-0` 이 없으면 긴 카드가 오른쪽 패널을 밀어낸다.
      tabIndex={-1}
      aria-label={t('inbox.pane.title')}
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-sunken
                 text-fg outline-none focus-visible:outline-solid focus-visible:outline-2
                 focus-visible:outline-accent focus-visible:-outline-offset-2"
    >
      <div className="flex items-center gap-2 border-b border-border bg-surface-raised p-3">
        <span className="font-semibold">{t('inbox.pane.title')}</span>
        {/* **숫자는 내 차례 하나뿐이다** — 0 이 될 수 있는 수만 뜻이 있다. */}
        {load.kind === 'ready' && (
          <span data-testid="inbox-mine-count" className={`text-meta ${mine > 0 ? 'font-medium text-state-turn' : 'text-fg-subtle'}`}>
            {t('inbox.board.mineCount', { count: mine })}
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded-row px-2 py-1 text-fg-muted hover:bg-surface-hover
                     focus-visible:outline-solid focus-visible:outline-2
                     focus-visible:outline-accent"
          aria-label={t('inbox.pane.close')}
        >
          ✕
        </button>
      </div>
      {/* 실패는 보드 위에 남긴다 — 조회 실패를 빈 보드로 삼키지 않는다. */}
      {load.kind === 'error' && (
        <div role="alert" className="m-3 rounded-row border border-danger-border bg-danger-surface p-2 text-danger">
          {t('inbox.pane.loadFailed', { reason: load.message })}
          <button
            onClick={() => { reload(); }}
            className="ml-2 rounded-row bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
          >
            {t('inbox.pane.retry')}
          </button>
        </div>
      )}
      {load.kind === 'loading' && <p className="p-3 text-fg-subtle">{t('inbox.pane.loading')}</p>}
      {load.kind === 'ready' && cards.length === 0 && (
        <p data-testid="inbox-empty" className="p-3 text-fg-subtle">{t('inbox.board.empty.all')}</p>
      )}
      {/*
        「내 작업」(W2): **내 차례 띠**가 맨 위 전폭으로 서고, 그 아래 세 열(진행 → 기다림 → 끝)이
        넓은 창에서는 나란히, 좁은 창에서는 세로로 쌓인다. 끌어 옮기기는 없다: 카드는 판정을 따라
        저절로 옮긴다. 스크롤은 이 자리 하나가 진다 — 띠와 열이 따로 굴러가면 띠가 열을 가린다.
      */}
      {load.kind === 'ready' && cards.length > 0 && (
        <div data-testid="inbox-board" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2">
          {(() => {
            // 띠 — 오래 기다린 것부터(`buildBoard` 가 내 차례를 sinceAt 오름차순으로 준다).
            const shown = byColumn.mine.filter((c) => c.fold === null);
            const head = shown.slice(0, BAND_LIMIT);
            const rest = shown.slice(BAND_LIMIT);
            const later = byColumn.mine.filter((c) => c.fold === 'later');
            return (
              <section
                data-testid="inbox-col-mine"
                aria-label={t(COLUMN_KEY.mine)}
                className={`shrink-0 rounded-row border p-2 ${shown.length > 0
                  ? 'border-state-turn/40 bg-state-turn/10' : 'border-border bg-surface-raised'}`}
              >
                <h3 className={`flex items-baseline gap-1.5 px-1 pb-1 text-meta font-medium ${shown.length > 0 ? 'text-state-turn' : 'text-fg-subtle'}`}>
                  <span aria-hidden="true">{COLUMN_EMOJI.mine}</span>
                  <span>{t(COLUMN_KEY.mine)}</span>
                  {shown.length > 1 && <span className="font-normal text-fg-subtle">· {t('inbox.board.band.order')}</span>}
                </h3>
                {/* 0 이면 한 줄로 줄어든다 — 이 띠가 비는 것이 이 화면의 목적이다. */}
                {shown.length === 0
                  ? <p data-testid="inbox-band-empty" className="px-1 text-meta text-fg-subtle">{t('inbox.board.empty.mine')}</p>
                  : <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1.5">{head.map(cardView)}</ul>}
                {rest.length > 0 && (
                  <details data-testid="inbox-band-more" className="mt-1.5 px-1">
                    <summary className="cursor-pointer text-meta text-fg-subtle hover:text-fg-muted">
                      {t('inbox.board.more', { count: rest.length })}
                    </summary>
                    <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1.5">{rest.map(cardView)}</ul>
                  </details>
                )}
                {later.length > 0 && (
                  <details data-testid="inbox-fold-later" className="mt-1.5 px-1">
                    <summary className="cursor-pointer text-meta text-fg-subtle hover:text-fg-muted">
                      {t(FOLD_KEY.later, { count: later.length })}
                    </summary>
                    <ul className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1.5">{later.map(cardView)}</ul>
                  </details>
                )}
              </section>
            );
          })()}
          <div className="flex flex-col gap-3 lg:grid lg:grid-cols-3 lg:items-start lg:gap-2">
            {LANE_COLUMNS.map((col) => {
              const shown = byColumn[col].filter((c) => c.fold === null);
              return (
                <section
                  key={col}
                  data-testid={`inbox-col-${col}`}
                  aria-label={t(COLUMN_KEY[col])}
                  className="flex min-w-0 flex-col"
                >
                  {/* 이모지는 채널의 상태 리액션과 같은 말이다. 수는 띠 하나만 센다 — 다른 열은 줄지 않는 숫자다. */}
                  <h3 className="flex items-baseline gap-1.5 px-1 pb-1 text-meta font-medium text-fg-subtle">
                    <span aria-hidden="true">{COLUMN_EMOJI[col]}</span>
                    <span>{t(COLUMN_KEY[col])}</span>
                  </h3>
                  <div className="flex flex-col gap-1.5">
                    {shown.length === 0
                      ? <p className="px-1 text-meta text-fg-subtle">{t('inbox.board.empty.other')}</p>
                      : <ul className="flex flex-col gap-1.5">{shown.map(cardView)}</ul>}
                    {/* 접힘 줄 — 열 맨 아래. 펼치면 같은 카드 모양으로 선다. */}
                    {COLUMN_FOLDS[col].map((fold) => {
                      const folded = byColumn[col].filter((c) => c.fold === fold);
                      if (folded.length === 0) return null;
                      return (
                        <details key={fold} data-testid={`inbox-fold-${fold}`} className="px-1">
                          <summary className="cursor-pointer text-meta text-fg-subtle hover:text-fg-muted">
                            {t(FOLD_KEY[fold], { count: folded.length })}
                          </summary>
                          <ul className="mt-1.5 flex flex-col gap-1.5">{folded.map(cardView)}</ul>
                        </details>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
      {/* 쓰다 만 초안 — 보드 밖 한 줄. 누르면 가장 최근 초안 자리로 간다. */}
      {draftKeys.length > 0 && (
        <button
          data-testid="inbox-drafts"
          onClick={() => {
            const key = draftKeys[0]!;
            if (key.startsWith(THREAD_PREFIX)) { void getController().openMessage(key.slice(THREAD_PREFIX.length)); return; }
            onClose();
            void getController().openChannel(key);
          }}
          className="border-t border-border bg-surface-raised px-3 py-2 text-left text-meta text-fg-muted hover:bg-surface-hover"
        >
          {t('inbox.board.drafts', { count: draftKeys.length })}
        </button>
      )}
    </aside>
  );
}
