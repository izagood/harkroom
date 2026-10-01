import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Identity } from './Identity';
import type { InboxEntry, MessageRow } from '@harkroom/shared';
import { BOARD_COLUMNS, CLEAR_EMOJI, buildBoard, daysWaiting, type BoardCard, type BoardColumn, type BoardFold } from '../lib/inboxBoard';
import { bodyWithHandles } from '../lib/mention';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useAgo, useT } from '../i18n/useT';

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

/** 열 이름 키. 화면이 제 손으로 글자를 적지 않는다. */
/** 열 맨 아래 접힘 줄의 이름. 접힌 카드는 사라지지 않는다 — 수와 함께 한 줄로 남는다. */
const FOLD_KEY = {
  quiet: 'inbox.board.fold.quiet',
  old: 'inbox.board.fold.old',
  cleared: 'inbox.board.fold.cleared',
} as const satisfies Record<BoardFold, string>;
/** 열마다 접힘 줄의 순서. 진행은 조용한 것, 끝남은 지난 것 → 치운 것. */
const COLUMN_FOLDS: Record<BoardColumn, readonly BoardFold[]> = {
  mine: [], blocked: [], active: ['quiet'], done: ['old', 'cleared'],
};

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
 * 카드에서 그 자리 처리: 나에게 온 물음은 카드에서 고르고, 치움은 머리에 ✅ 를 단다
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
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const accounts = useActiveStore((s) => s.accounts);
  // 문장의 집합·팀 토큰(#845). 안 주면 그 자리가 `@알 수 없음` 이 된다.
  const groups = useActiveStore((s) => s.groups);
  const teams = useActiveStore((s) => s.teams) ?? INBOX_NO_TEAMS;
  const me = useActiveStore((s) => s.me);
  const drafts = useActiveStore((s) => s.drafts);
  /** 서버의 인박스가 바뀐 횟수. 열려 있는 동안 "다시 읽어라"로 쓴다(아래 effect). */
  const inboxRevision = useActiveStore((s) => s.inboxRevision);
  /** 지금 손대는 카드(답·완료). 두 번 눌러 두 번 보내지 않게 한다. */
  const [busy, setBusy] = useState<string | null>(null);

  const [entries, setEntries] = useState<InboxEntry[]>([]);
  /** `null` = 서버가 머리를 안 줬다(옛 서버). 보드가 항목 `meta` 로 판정한다. */
  const [threads, setThreads] = useState<MessageRow[] | null>(null);
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
  const reload = useCallback((opts: { quiet?: boolean } = {}): (() => void) => {
    let alive = true;
    const seq = ++reloadSeq.current;
    if (!opts.quiet) setLoad({ kind: 'loading' });
    getController().api.inboxBoard().then(
      (res) => {
        if (!alive || seq !== reloadSeq.current) return;
        setEntries(res.entries);
        setThreads(res.threads);
        setLoad({ kind: 'ready' });
      },
      (err: unknown) => {
        if (!alive || opts.quiet || seq !== reloadSeq.current) return;
        // 실패했을 때 앞선 결과를 남겨 두면 낡은 보드가 지금 사실인 척한다.
        setEntries([]);
        setThreads(null);
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
   * **열려 있는 동안 새로 온 것을 그린다**(2026-09-10 신고). 서버의 `inbox.updated` 를
   * 컨트롤러가 `inboxRevision` 으로 세고, 이 화면은 그 수가 바뀔 때 조용히 다시 읽는다.
   * 닫혀 있을 때도 번호는 따라간다 — 다시 열 때 위 effect 의 조회 하나로 끝나게.
   */
  const seenRevision = useRef(inboxRevision);
  useEffect(() => {
    if (!open || seenRevision.current === inboxRevision) {
      seenRevision.current = inboxRevision;
      return;
    }
    seenRevision.current = inboxRevision;
    return reload({ quiet: true });
  }, [open, inboxRevision, reload]);

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
      entries, threads,
      me: me ? { id: me.id, kind: me.kind } : null,
      isAgent: (id) => accounts[id]?.kind === 'agent',
      nowMs: Date.now(),
    }),
    [entries, threads, me, accounts],
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
      : (onClose(), getController().openMessage(card.entries[0]!.messageId));
    void go.then(() => reload({ quiet: true }));
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
   * **치움** — 머리에 ✅ 를 달거나 뗀다(designer 정정 3). 보드에서 내려 끝남 맨 아래 접힘으로
   * 보낸다. 사람이 이미 ✅ 로 그렇게 적고 있다. 2/2 의 서버 "완료"가 이것을 대신한다.
   */
  const setCleared = async (card: BoardCard, on: boolean): Promise<void> => {
    setBusy(card.rootId);
    try {
      await getController().toggleReaction(card.channelId, card.rootId, CLEAR_EMOJI, on);
      reload({ quiet: true });
    } finally { setBusy(null); }
  };

  const cardView = (card: BoardCard) => {
    const who = card.whoId ? accounts[card.whoId] : undefined;
    const days = daysWaiting(card.sinceAt, Date.now());
    const more = card.entries.length - 1;
    return (
      <li key={card.rootId} className="rounded border border-border bg-surface-raised">
        <button
          data-testid={`inbox-card-${card.rootId}`}
          data-column={card.column}
          data-unread={card.unread ? 'true' : 'false'}
          onClick={() => openCard(card)}
          className={`flex w-full flex-col gap-1 rounded border-l-2 px-2 py-1.5 text-left hover:bg-surface-hover ${
            card.unread ? 'border-accent' : 'border-transparent'}`}
        >
          {/* **해야 할 일 한 문장.** 잘라 낸 본문 두 줄이 아니라 고른 한 문장이다(`oneSentence`). */}
          <span data-testid={`inbox-card-summary-${card.rootId}`} className="line-clamp-2 break-words text-fg">
            {bodyWithHandles(card.summary, accounts, groups, teams)}
          </span>
          {/* 채널 · 누가 · 얼마나. 넘치면 채널 이름부터 줄인다 — 시각은 잘리면 뜻을 잃는다. */}
          <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-meta text-fg-subtle">
            {who && <Identity account={who} className="h-4 w-4 shrink-0 text-[9px]" variant="avatar" />}
            {who && <span aria-hidden="true" className="shrink-0 font-medium text-fg-muted">{who.handle}</span>}
            <span className="min-w-0 truncate">{channelLabel(card.channelId)}</span>
            <span
              className={`shrink-0 ${days != null && card.column === 'mine' ? 'text-state-turn' : ''}`}
              data-testid={`inbox-card-age-${card.rootId}`}
              title={new Date(card.sinceAt).toLocaleString()}
            >
              · {days != null ? t('inbox.board.days', { count: days }) : ago(new Date(card.sinceAt).getTime())}
            </span>
            {more > 0 && <span className="shrink-0">· {t('inbox.board.more', { count: more })}</span>}
            {card.unread && <span className="shrink-0 text-accent">· {t('inbox.board.unread')}</span>}
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
              className="rounded border border-border px-2 py-0.5 text-meta text-fg hover:bg-surface-hover disabled:opacity-50"
            >
              {o.label}
            </button>
          ))}
          <button
            data-testid={`inbox-card-clear-${card.rootId}`}
            disabled={busy === card.rootId}
            onClick={() => void setCleared(card, card.fold !== 'cleared')}
            className="ml-auto rounded px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-hover disabled:opacity-50"
          >
            {card.fold === 'cleared' ? t('inbox.board.unclear') : t('inbox.board.clear')}
          </button>
        </div>
      </li>
    );
  };

  const mineCount = byColumn.mine.length;

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
        <span className="font-bold">{t('inbox.pane.title')}</span>
        {/* **숫자는 내 차례 하나뿐이다** — 0 이 될 수 있는 수만 뜻이 있다. */}
        {load.kind === 'ready' && (
          <span data-testid="inbox-mine-count" className={`text-meta ${mineCount > 0 ? 'font-medium text-state-turn' : 'text-fg-subtle'}`}>
            {t('inbox.board.mineCount', { count: mineCount })}
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded px-2 py-1 text-fg-muted hover:bg-surface-hover
                     focus-visible:outline-solid focus-visible:outline-2
                     focus-visible:outline-accent"
          aria-label={t('inbox.pane.close')}
        >
          ✕
        </button>
      </div>
      {/* 실패는 보드 위에 남긴다 — 조회 실패를 빈 보드로 삼키지 않는다. */}
      {load.kind === 'error' && (
        <div role="alert" className="m-3 rounded border border-danger-border bg-danger-surface p-2 text-danger">
          {t('inbox.pane.loadFailed', { reason: load.message })}
          <button
            onClick={() => { reload(); }}
            className="ml-2 rounded bg-danger px-2 py-0.5 text-fg-on-strong hover:bg-danger-hover"
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
        열 넷. **넓은 창에서는 나란히**, 좁은 창에서는 **세로 구획으로 쌓는다**(designer) — 순서가
        곧 열 순서라 내 차례가 맨 위다. 끌어 옮기기는 없다: 카드는 판정을 따라 저절로 옮긴다.
      */}
      {load.kind === 'ready' && cards.length > 0 && (
        <div
          data-testid="inbox-board"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2 lg:flex-row lg:gap-2 lg:overflow-y-hidden lg:overflow-x-auto"
        >
          {BOARD_COLUMNS.map((col) => {
            const shown = byColumn[col].filter((c) => c.fold === null);
            return (
              <section
                key={col}
                data-testid={`inbox-col-${col}`}
                aria-label={t(COLUMN_KEY[col])}
                className="flex shrink-0 flex-col lg:min-h-0 lg:w-64 lg:min-w-56 lg:flex-1 lg:shrink"
              >
                <h3 className={`px-1 pb-1 text-meta font-medium uppercase tracking-wide ${col === 'mine' ? 'text-state-turn' : 'text-fg-subtle'}`}>
                  {t(COLUMN_KEY[col])}
                </h3>
                <div className="flex flex-col gap-1.5 lg:min-h-0 lg:overflow-y-auto">
                  {shown.length === 0
                    ? <p className="px-1 text-meta text-fg-subtle">{t(col === 'mine' ? 'inbox.board.empty.mine' : 'inbox.board.empty.other')}</p>
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
