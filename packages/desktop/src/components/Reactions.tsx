import { THREAD_STATUS_EMOJI, type MessageRow, type ThreadStatusReaction } from '@harkroom/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActiveStore } from '../state/communities';
import { selectAccountNames } from '../lib/accountNames';
import { getController } from '../state/controller';
import { useLocale, useT } from '../i18n/useT';
import type { Translate } from '../i18n';
import type { AccountNames } from '../lib/accountNames';
import { reactionSentence, reactorNames } from '../lib/reactionNames';
import { clipBounds, PLACEMENT_GAP } from './Menu';
import { useHostDocument, viewOf } from '../lib/hostDocument';

/**
 * 피커에 올려 둘 이모지. 전체 이모지 검색은 별개 작업이고, 실제로 쓰이는 것은 소수다 —
 * 스크린샷의 👀·💬 가 여기 있어야 한다.
 *
 * #145: 인라인 버튼(툴바에 바로 보이는 3개)은 👀💬 를 제외한다 — 그 둘은 에이전트 상태 신호로 쓰이고,
 * 사람이 그걸 흉내 내면 신호의 의미가 무너진다.
 */
const QUICK = ['👀', '💬', '👍', '🎉', '✅', '🔥', '🤔', '😄'];

/**
 * 에이전트가 상태 신호로 쓰는 이모지. 인라인 버튼에서 제외하는 근거가 이 목록이다.
 * #144 를 보라 — 사람이 이것을 흉내 내면 신호의 의미가 무너진다.
 */
export const STATUS_SIGNAL_EMOJI = ['👀', '💬'];

/**
 * 인라인 세 칸 — **요청받은 순서 그대로의 고정 목록**(2026-09-09).
 *
 * 앞 판은 규칙으로 골랐다: `QUICK` 에서 상태 신호(👀 💬)를 뺀 뒤 앞에서 셋(`pickInline`).
 * 그 규칙의 목적은 **상태 신호가 인라인으로 새어 들어오지 않게** 하는 것이었다(#144·#145 —
 * 사람이 에이전트의 신호를 흉내 내면 신호의 뜻이 무너진다).
 *
 * 요청받은 셋은 `✅ 👀 👍` 이고, 👀 가 그 규칙을 정면으로 어긴다. 규칙을 **반쯤** 고쳐
 * 두면(예: 👀 만 예외로 뚫기) 다음 사람이 그 예외를 보고 💬 도 뚫는다. 그래서 규칙을 지우고
 * **값 하나로** 만들었다 — 여기 적힌 셋이 인라인이고, 되돌리는 것도 이 배열 한 줄이다.
 *
 * **💬 는 여전히 올리지 않는다.** 그것이 남은 절반의 판단이다: 💬 는 상태 신호이면서
 * 바로 옆 스레드 버튼과 뜻이 겹친다(둘 다 "말을 잇는다"). 창에는 그대로 있다.
 */
export const INLINE = ['✅', '👀', '👍'];

/**
 * 리액션 고르는 창 — **툴바 위쪽에 뜨는 팝오버**(요청 2026-09-09: "바 위쪽에 이모지 고를 수
 * 있는 약간 여유 있는 창").
 *
 * ## 앞 판이 무엇을 했는가
 *
 * `＋` 를 누르면 이 컴포넌트가 **자기 자리에서** 8개 이모지 줄로 바뀌었다(`if (picking)
 * return …`). 두 가지가 동시에 깨졌다:
 *
 * 1. 툴바 안의 다른 칸들이 **커서 아래에서 좌우로 밀려났다** — 무엇을 누르려던 자리였는지가
 *    사라진다. 리액션을 고르려다 메뉴를 열게 되는 자리다.
 * 2. 툴바는 호버로만 보이므로, 그 줄을 보려고 마우스를 조금 움직이면 **줄째 사라졌다.**
 *
 * 창을 위로 띄우면 툴바의 자리 여덟은 그대로 있고(순서가 흔들리지 않는다), 창은 툴바의
 * 자식이라 붙잡아 둘 수 있다(`MessageToolbar` 의 `data-open`).
 *
 * ## 왜 32px 칸인가
 *
 * 앞 판은 11px 이모지가 알약에 붙어 있어 **고르는 동작이 조준**이었다. 여기서는 칸이
 * 32px, 사이가 4px 이다. 글자 크기는 `text-title`(17px)이다 — 20px 이 더 낫겠지만 4단
 * 회귀선이 임의 글자 크기를 잡는다(`test/typeScale.test.ts`), 그리고 그 회귀선이 지키는
 * 것("단이 단으로 남는다")이 이모지 3px 보다 크다.
 *
 * ## 위에 자리가 없으면 아래로 뒤집는다
 *
 * 위로만 뜨던 판은 목록 **맨 위** 메시지에서 창이 채널 머리(스크롤 상자의 위 테두리)에
 * 잘려 통째로 보이지 않았다(2026-09-28 신고). `⋯` 메뉴가 같은 결함을 이미 고쳐 두었으므로
 * 판단도 그쪽 것을 그대로 쓴다(`Menu` 의 `clipBounds` — 뷰포트 ∩ 스크롤 조상). 재는
 * 기준은 창의 부모인 **툴바**이고, 원하는 쪽(위)에 안 들어갈 때만, 아래가 더 넓으면 뒤집는다.
 */
export function ReactionPickerPanel({ message, onClose }: { message: MessageRow; onClose: () => void }) {
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);

  // `useLayoutEffect` 는 그리기 전에 돈다 — 뒤집혀도 위에 한 번 그려졌다 내려오는 깜빡임이 없다.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = panel?.parentElement;
    if (!panel || !anchor) return;
    const height = panel.getBoundingClientRect().height;
    const a = anchor.getBoundingClientRect();
    const clip = clipBounds(anchor);
    const roomAbove = a.top - clip.top - PLACEMENT_GAP;
    const roomBelow = clip.bottom - a.bottom - PLACEMENT_GAP;
    setBelow(height > roomAbove && roomBelow > roomAbove);
  }, []);

  const toggle = (emoji: string, on: boolean) => {
    // 고르면 바로 닫는다 — 한 말에 셋을 연달아 다는 일은 드물고, 열린 채로 두면 창이
    // 다음 메시지를 읽는 것을 가린다.
    onClose();
    // 실패는 조용히 넘긴다 — 서버가 받아들인 뒤에만 화면이 바뀌므로 화면은 언제나 서버와 같다.
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  return (
    <div
      ref={panelRef}
      data-testid="reaction-picker-panel"
      data-placement={below ? 'bottom' : 'top'}
      /* 오른쪽 끝을 툴바에 맞춘다(`right-0`) — 툴바가 행의 오른쪽에 붙어 있으므로 왼쪽에
         맞추면 창이 화면 밖으로 나간다. `bottom-full` 은 "내 아래끝 = 부모의 위끝"이다. */
      className={`absolute right-0 z-10 w-58 rounded-card bg-surface-raised
                  p-2.5 shadow-float ${below ? 'top-full mt-1.5' : 'bottom-full mb-1.5'}`}
    >
      <div className="mb-2 flex items-center justify-between px-0.5 text-meta text-fg-subtle">
        <span>{t('reactions.pickTitle')}</span>
        <button
          aria-label="Close reaction picker"
          className="rounded-sm px-1 hover:bg-surface-hover hover:text-fg"
          onClick={onClose}
        >
          Esc
        </button>
      </div>
      <div className="grid grid-cols-6 gap-1">
        {QUICK.map((e) => {
          const mine = myId !== null && !!message.reactions.find((r) => r.emoji === e)?.accountIds.includes(myId);
          return (
            <button
              key={e}
              /* 이름은 이모지 그대로다 — 인라인 버튼은 `React with 👍` 라 둘이 겹치지 않는다
                 (이 파일 아래 주석이 그 사고를 기록한다: 같은 이름이 둘이면 스크린리더와
                 테스트가 어느 것인지 가리지 못한다). */
              aria-label={e}
              aria-pressed={mine}
              className={`flex h-8 w-8 items-center justify-center rounded-card text-title
                ${mine ? 'bg-surface-sunken ring-1 ring-border' : 'hover:bg-surface-hover'}`}
              onClick={() => toggle(e, !mine)}
            >
              {e}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * #145: 툴바에 바로 보이는 인라인 이모지 버튼 3개.
 * 👀💬는 에이전트 상태 신호로 쓰이므로, 사람이 누를 수 있는 인라인 버튼에 포함하지 않는다.
 * 토글 가능하고, 내가 누른 리액션은 눌린 상태로 표시한다.
 */
export function InlineReactionButtons({ message, className, classNameOn }: {
  message: MessageRow;
  /**
   * 칸의 모양은 **툴바가 정한다.** 앞 판은 이 파일이 자기 클래스를 들고 있었고, 그래서 한
   * 툴바 안에서 두 규칙이 돌았다(이모지는 `surface-sunken` 에 반응하고 아이콘 칸은 자기
   * 배경색에 반응해 **아무 변화가 없었다**). 여덟 칸이 같은 상자를 쓰는 것이 요점이라
   * 그 값을 한 곳에서 받는다.
   */
  className?: string;
  /** 내가 이미 누른 칸의 모양(가라앉은 면). */
  classNameOn?: string;
}) {
  const myId = useActiveStore((s) => s.me?.id ?? null);

  const toggle = (emoji: string, on: boolean) => {
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  return (
    <>
      {INLINE.map((emoji) => {
        const existing = message.reactions.find((r) => r.emoji === emoji);
        const mine = myId !== null && existing?.accountIds.includes(myId);
        return (
          <button
            key={emoji}
            // 이름을 피커의 이모지 버튼(`aria-label={e}`)과 **구분**한다. 같으면 피커를 연
            // 순간 같은 접근 가능한 이름이 둘이 되어 스크린리더와 테스트가 어느 것인지
            // 가리지 못한다 — 이 파일 위쪽 주석이 기록한 그 사고다(테스트 4개가 깨졌다).
            // 눌림 여부는 이름이 아니라 `aria-pressed` 가 전한다. 이름은 상태에 따라
            // 바뀌지 않아야 포커스가 그 버튼에 머문 채로도 읽히는 이름이 흔들리지 않는다.
            aria-label={`React with ${emoji}`}
            aria-pressed={mine}
            data-slot
            data-testid={`toolbar-react-${emoji}`}
            className={mine ? classNameOn : className}
            onClick={() => toggle(emoji, !mine)}
          >
            {emoji}
          </button>
        );
      })}
    </>
  );
}

/** 달린 리액션 칩. 추가는 `ReactionPicker`(툴바)가 맡는다 — 같은 것을 두 곳에 두지 않는다. */
export function Reactions({ message }: { message: MessageRow }) {
  // 이름 쪽만 구독한다 — 상태·아바타 이벤트에 행마다 다시 그려지지 않도록(`lib/accountNames`).
  const accounts = useActiveStore(selectAccountNames);
  const myId = useActiveStore((s) => s.me?.id ?? null);

  const toggle = (emoji: string, on: boolean) => {
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  /**
   * **모르는 계정에 `null` 을 돌려준다.** 앞판은 `'…'` 를 돌려줬는데, 그러면 목록에
   * 이름처럼 생긴 자리가 서서 사람이 그것을 이름으로 읽는다 — 그 자리에 낱말
   * (`reactions.unknown`)을 넣을 판단은 `reactorNames` 에 있다.
   *
   * 핸들이 아니라 `displayName` 을 앞에 두는 이유: 이 줄은 **사람이 읽는 이름**을 묻는
   * 자리다(`@` 로 부르는 자리가 아니다). 이름줄·디렉터리가 이미 그 이름을 그리므로
   * 툴팁만 핸들을 말하면 같은 사람을 두 이름으로 부르게 된다. 에이전트는 둘이 같다.
   */
  const nameOf = (id: string) => {
    const a = accounts[id];
    if (!a) return null;
    return a.displayName || a.handle;
  };

  const status = message.threadRootId === null ? message.statusReaction ?? null : null;
  const chips = status ? withoutAgentStatusEchoes(message.reactions, accounts) : message.reactions;
  if (!chips.length && !status) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {status && <StatusReactionChip status={status} accounts={accounts} />}
      {chips.map((r) => (
        <ReactionChip
          key={r.emoji}
          emoji={r.emoji}
          accountIds={r.accountIds}
          nameOf={nameOf}
          myId={myId}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

/** 상태 리액션이 쓰는 이모지들. 루트에 상태가 있으면 에이전트만 단 같은 이모지 칩은 숨긴다. */
const STATUS_EMOJI_SET = new Set(Object.values(THREAD_STATUS_EMOJI));

/**
 * 루트에 상태 리액션이 있으면 **에이전트만 단** 👀·💬·✅ 칩은 그리지 않는다 — 러너가 멘션을
 * 받았다고 단 👀 와 상태 💬 가 나란히 서면 "루트에 언제나 하나"(D안 규칙 1)가 화면에서 깨진다.
 * 사람이 하나라도 단 칩은 그대로 둔다(사람 리액션은 건드리지 않는다). 모르는 계정은 사람으로 친다.
 */
export function withoutAgentStatusEchoes(
  reactions: MessageRow['reactions'], accounts: AccountNames,
): MessageRow['reactions'] {
  return reactions.filter((r) => !STATUS_EMOJI_SET.has(r.emoji)
    || r.accountIds.some((id) => accounts[id]?.kind !== 'agent'));
}

/** 이유는 80자에서 자른다 — 긴 물음이 말풍선을 화면만큼 키우지 않게(designer). */
const REASON_MAX = 80;
const clip = (x: string) => (x.length > REASON_MAX ? `${x.slice(0, REASON_MAX)}…` : x);

/** 상태 → 낱말 키. 화면의 다섯 배지(`thread.state.*`)와 달리 스레드 기준 여섯 상태다. */
const STATUS_LABEL = {
  received: 'threadStatus.label.received',
  running: 'threadStatus.label.running',
  waiting: 'threadStatus.label.waiting',
  'my-turn': 'threadStatus.label.myTurn',
  stuck: 'threadStatus.label.stuck',
  done: 'threadStatus.label.done',
} as const;

/**
 * 마우스를 올리면 뜨는 한 줄 — **상태 낱말 · 누구 · 이유** 순(designer 확정 문구).
 * 예: "내 차례 · task_manager가 묻는다 · 수정안 둘 중 어느 것?", "기다림 · security 답을 기다림".
 * 순수 함수라 시험이 문장을 직접 잰다.
 */
export function statusSentence(
  s: ThreadStatusReaction, accounts: AccountNames, t: Translate, locale: string,
): string {
  const nameOf = (id: string | null) => {
    const a = id ? accounts[id] : undefined;
    return a ? (a.displayName || a.handle) : null;
  };
  const who = nameOf(s.accountId) ?? t('threadStatus.someone');
  const parts: string[] = [t(STATUS_LABEL[s.status])];
  switch (s.status) {
    case 'my-turn':
      parts.push(t('threadStatus.tip.myTurn', { who }));
      if (s.reason) parts.push(clip(s.reason));
      break;
    case 'stuck':
      parts.push(t('threadStatus.tip.stuck', { who }));
      if (s.reason) parts.push(clip(s.reason));
      break;
    case 'waiting': {
      // 이유는 기다리는 상대의 id 이거나 깨움 시각(ISO)이다 — 서버가 그 둘만 싣는다.
      const other = nameOf(s.reason);
      const at = s.reason ? Date.parse(s.reason) : NaN;
      if (other) parts.push(t('threadStatus.tip.waitingOn', { other }));
      else if (!Number.isNaN(at)) {
        const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
        parts.push(t('threadStatus.tip.waitingWake', { time }));
      } else parts.push(who);
      break;
    }
    default:
      parts.push(who);
  }
  return parts.join(' · ');
}

/**
 * **상태 리액션 칩**(D안) — 맨 앞에, 숫자 없이, 누를 수 없다.
 *
 * - 버튼이 아니라 `span` 이다: 사람이 눌러 토글하면 서버 판정과 화면이 갈라진다(규칙 4).
 *   포커스는 받는다(`tabIndex=0`) — 키보드로도 이유를 읽을 수 있어야 한다.
 * - 🙋·🚨 만 색 테두리와 낱말을 받는다. 나머지 넷은 사람을 부르지 않으므로 이모지 하나다
 *   (`isBlocking` 과 같은 강조 예산).
 * - 말풍선은 사람 칩과 **같은 틀**(`ReactionTooltip`)을 쓴다 — 두 모양이면 어느 것이 무엇인지 배워야 한다.
 */
function StatusReactionChip({ status, accounts }: { status: ThreadStatusReaction; accounts: AccountNames }) {
  const t = useT();
  const locale = useLocale();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const openSoon = () => {
    clear();
    timer.current = setTimeout(() => {
      if (ref.current) setAnchor(ref.current.getBoundingClientRect());
    }, TOOLTIP_OPEN_DELAY_MS);
  };
  const close = () => { clear(); setAnchor(null); };
  useEffect(() => clear, []);

  const sentence = statusSentence(status, accounts, t, locale);
  const label = status.status === 'my-turn' || status.status === 'stuck' ? t(STATUS_LABEL[status.status]) : null;
  const tone = status.status === 'my-turn'
    ? 'border-state-turn text-state-turn font-medium'
    : status.status === 'stuck'
      ? 'border-state-stuck text-state-stuck font-medium'
      : 'border-border text-fg-muted';
  return (
    <>
      <span
        ref={ref}
        role="status"
        tabIndex={0}
        data-testid="status-reaction"
        data-status={status.status}
        aria-label={t('threadStatus.aria', { sentence })}
        onMouseEnter={openSoon}
        onMouseLeave={close}
        onFocus={openSoon}
        onBlur={close}
        className={`flex cursor-default select-none items-center gap-1 rounded-full border bg-surface px-1.5 text-meta ${tone}`}
      >
        <span>{status.emoji}</span>
        {label && <span data-testid="status-reaction-label">{label}</span>}
      </span>
      {anchor && <ReactionTooltip emoji={status.emoji} text={sentence} anchor={anchor} />}
    </>
  );
}

/** 올린 뒤 이만큼 머물러야 말풍선을 연다 — 칩 줄을 가로지르는 커서마다 깜빡이지 않게. */
const TOOLTIP_OPEN_DELAY_MS = 150;

/** 칩 하나. 말풍선의 열림 상태가 칩마다 따로라 컴포넌트로 뗐다. */
function ReactionChip({ emoji, accountIds, nameOf, myId, onToggle }: {
  emoji: string;
  accountIds: string[];
  nameOf: (id: string) => string | null;
  myId: string | null;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const t = useT();
  const chipRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const openSoon = () => {
    clear();
    timer.current = setTimeout(() => {
      if (chipRef.current) setAnchor(chipRef.current.getBoundingClientRect());
    }, TOOLTIP_OPEN_DELAY_MS);
  };
  const close = () => { clear(); setAnchor(null); };
  useEffect(() => clear, []);

  const mine = myId !== null && accountIds.includes(myId);
  // 말풍선(`ReactionTooltip`)과 스크린리더(`aria-label`)가 **같은 목록**을 말한다. 갈라 두면
  // 한쪽만 고쳐지고, 그러면 눈으로 본 것과 읽힌 것이 다르다.
  const who = reactorNames(accountIds, nameOf, myId, t);
  return (
    <>
      <button
        ref={chipRef}
        data-testid={`reaction-${emoji}`}
        data-mine={mine ? 'true' : 'false'}
        /*
          **호버로 누가 달았는지 보여 준다** — 앞 판(2026-09-09)은 OS `title` 에 이름
          목록만 실었다. OS 툴팁은 작고 늦게 뜨며(약 1초) 우리가 모양을 못 정한다.
          2026-09-29 부터는 `ReactionTooltip` 이 말풍선을 그린다(Slack 본). `title` 을
          남겨 두면 OS 툴팁이 말풍선 위에 한 번 더 뜨므로 **뺐다.**

          누른 뒤에도 말풍선을 닫지 않는다 — 문장이 바로 "(제거하려면 클릭) …you…" 로
          바뀌어 방금 누른 것이 반영됐음을 커서 자리에서 확인해 준다. 마지막 한 명이 떼면
          칩째 사라지므로 말풍선도 같이 사라진다.
        */
        onMouseEnter={openSoon}
        onMouseLeave={close}
        onFocus={openSoon}
        onBlur={close}
        // 이모지 문자만으로는 스크린리더가 무엇인지 읽을 수 없다 — 누가 눌렀는지 함께 준다.
        aria-label={`${emoji} — ${who}`}
        aria-pressed={mine}
        /*
          **내가 단 것은 선으로도 구별한다**(2026-09-09, 요청자 jaebin).

          앞판은 면과 굵기만 갈랐다(#488 B2: *"테두리는 양쪽이 같다 — 선까지 갈라
          두면 칩이 셋만 붙어도 줄이 시끄러워진다"*). 실사용에서 그 구별이 안 읽혔다:
          `bg-surface-sunken` 과 `bg-surface` 는 면 한 단계 차이라, 칩이 본문 아래
          작게 붙어 있으면 내가 누른 것인지 알아보려고 **눌러 보게 된다** — 그리고
          누르면 취소된다.

          **선에만 `border-accent-brand` 를 쓰고 면·글자에는 강조를 안 쓴다.** 그
          토큰이 `index.css` 에서 *"글자를 얹지 않는 자리에만 쓴다 —
          선(`border-accent-brand`), 상태 점"* 으로 정의된 자리다. 강조 예산(#488 B2)이
          걱정한 것은 채운 면과 글자이고 `accentBudget.test.tsx` 가 그 둘을 계속
          막는다. 선은 칩이 몇 개 붙든 한 겹이므로 "줄이 시끄러워진다"는 그 걱정에
          닿지 않는다.
        */
        className={`flex items-center gap-1 rounded-full border px-1.5 text-meta ${
          mine
            ? 'border-accent-brand bg-surface-sunken font-medium text-fg'
            : 'border-border bg-surface text-fg-muted'
        }`}
        onClick={() => onToggle(emoji, !mine)}
      >
        <span>{emoji}</span>
        <span>{accountIds.length}</span>
      </button>
      {anchor && (
        <ReactionTooltip emoji={emoji} who={{ accountIds, nameOf, myId }} anchor={anchor} />
      )}
    </>
  );
}

/**
 * 폭·이모지·여백은 첫 판(240 · 64px · h-24)에서 한 단씩 줄였다(2026-09-29 jaebin: "좋은데 너무
 * 크다 … 전체적으로 조금만 축소"). 실앱에서 말풍선이 칩에 비해 너무 넓고 높았고, 이모지 위아래
 * 빈 자리가 컸다.
 */
const TOOLTIP_WIDTH = 208;
const TOOLTIP_GAP = 8;
const EDGE_GAP = 8;

/**
 * **리액션 말풍선** — 칩 위에 어두운 풍선, 위에 큰 이모지, 아래에 본문 크기의 문장, 칩을 가리키는
 * 꼬리(2026-09-29, Slack 리액션 툴팁을 본으로 한 요청).
 *
 * `MentionCard` 와 같은 틀이다: `document.body` 로 포털을 띄우고 `fixed` 로 칩의 자리를
 * 따른다. 메시지 목록은 스크롤 상자라 그 안에 두면 맨 위 메시지에서 말풍선이 채널 머리에
 * 잘린다(피커가 2026-09-28 에 겪은 그 결함).
 *
 * - **어두운 면은 `bg-fg` 에 `text-surface`** 다 — 앞글자색과 바탕색을 뒤집은 것이라 두
 *   테마 모두에서 본문과 반대 명도가 되고, 새 색 토큰이 필요 없다.
 * - **위에 자리가 없으면 아래로 연다**(꼬리도 뒤집힌다). 가로는 창 안으로 밀되 꼬리는 늘
 *   칩의 가운데를 가리킨다.
 * - 말풍선 자체는 마우스를 받지 않는다(`pointer-events-none`) — 안에 누를 것이 없고, 받으면
 *   칩에서 커서를 올리는 순간 `mouseleave` 가 나서 풍선이 떨린다.
 * - 스크린리더는 이 말풍선을 따로 읽지 않는다(`aria-hidden`) — 칩의 `aria-label` 이 같은 목록을
 *   이미 말한다. 둘 다 읽히면 같은 이름이 두 번 들린다.
 */
function ReactionTooltip({ emoji, who, text, anchor }: {
  emoji: string;
  /** 사람 칩: 누가 달았는지로 문장을 만든다. */
  who?: { accountIds: string[]; nameOf: (id: string) => string | null; myId: string | null };
  /** 상태 칩: 이미 만든 문장(`statusSentence`). */
  text?: string;
  anchor: DOMRect;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  // 말풍선은 칩이 그려진 **그 창**에 띄우고 그 창 크기로 자른다 — 메인 `document.body`·`window` 를 쓰면
  // 새 창에서 올린 칩의 말풍선이 메인 창에 뜬다(2026-10-06 F1).
  const hostDoc = useHostDocument();
  const view = viewOf(hostDoc);
  const { hint, sentence } = who
    ? reactionSentence(emoji, who.accountIds, who.nameOf, who.myId, t)
    : { hint: null, sentence: text ?? '' };

  useLayoutEffect(() => {
    const height = ref.current?.getBoundingClientRect().height ?? 0;
    setBelow(anchor.top - TOOLTIP_GAP - height < EDGE_GAP && anchor.bottom + TOOLTIP_GAP + height <= view.innerHeight - EDGE_GAP);
  }, [anchor]);

  const center = anchor.left + anchor.width / 2;
  const left = Math.max(EDGE_GAP, Math.min(center - TOOLTIP_WIDTH / 2, view.innerWidth - TOOLTIP_WIDTH - EDGE_GAP));
  const style = below
    ? { position: 'fixed' as const, left, top: anchor.bottom + TOOLTIP_GAP, width: TOOLTIP_WIDTH }
    : { position: 'fixed' as const, left, bottom: view.innerHeight - anchor.top + TOOLTIP_GAP, width: TOOLTIP_WIDTH };
  // 꼬리는 칩 가운데에 — 풍선이 창 가장자리로 밀려도 가리키는 곳은 그대로다.
  const tailLeft = Math.max(12, Math.min(center - left, TOOLTIP_WIDTH - 12));

  return createPortal(
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="reaction-tooltip"
      data-placement={below ? 'bottom' : 'top'}
      style={style}
      className="pointer-events-none z-50 flex flex-col items-center gap-1 rounded-card bg-fg px-3 py-2 text-surface shadow-float"
    >
      {/* 칩의 이모지를 크게 다시 그린다 — 칩 여럿이 붙어 있으면 이 풍선이 **어느** 칩 것인지를 이것이 답한다. */}
      <span className="flex h-14 w-14 items-center justify-center text-[48px] leading-none" data-testid="reaction-tooltip-emoji">{emoji}</span>
      {/* **글자는 본문과 같다** — 단(`text-body`)도 굵기도. 첫 판의 `font-semibold` 는 같은 14px 이어도
          본문보다 커 보였고 폭을 더 먹어 "반응 / 했다" 처럼 낱말 가운데서 꺾였다. `break-keep` 은
          한글 낱말을 가운데서 자르지 않게 한다(줄은 띄어쓰기에서만 바뀐다). */}
      <p className="text-center text-body break-keep break-words">
        {hint && <span data-testid="reaction-tooltip-hint">{hint} </span>}
        {sentence}
      </p>
      <span
        aria-hidden="true"
        className={`absolute h-3 w-3 -translate-x-1/2 rotate-45 bg-fg ${below ? '-top-1.5' : '-bottom-1.5'}`}
        style={{ left: tailLeft }}
      />
    </div>,
    hostDoc.body,
  );
}
