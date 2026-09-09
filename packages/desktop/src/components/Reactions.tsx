import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import { reactorNames } from '../lib/reactionNames';

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
 */
export function ReactionPickerPanel({ message, onClose }: { message: MessageRow; onClose: () => void }) {
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const t = useT();

  const toggle = (emoji: string, on: boolean) => {
    // 고르면 바로 닫는다 — 한 말에 셋을 연달아 다는 일은 드물고, 열린 채로 두면 창이
    // 다음 메시지를 읽는 것을 가린다.
    onClose();
    // 실패는 조용히 넘긴다 — 서버가 받아들인 뒤에만 화면이 바뀌므로 화면은 언제나 서버와 같다.
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  return (
    <div
      data-testid="reaction-picker-panel"
      /* 오른쪽 끝을 툴바에 맞춘다(`right-0`) — 툴바가 행의 오른쪽에 붙어 있으므로 왼쪽에
         맞추면 창이 화면 밖으로 나간다. `bottom-full` 은 "내 아래끝 = 부모의 위끝"이다. */
      className="absolute bottom-full right-0 mb-1.5 w-58 rounded-[10px] border border-border
                 bg-surface-raised p-2.5 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between px-0.5 text-meta text-fg-subtle">
        <span>{t('reactions.pickTitle')}</span>
        <button
          aria-label="Close reaction picker"
          className="rounded px-1 hover:bg-surface-hover hover:text-fg"
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
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-title
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
  const accounts = useActiveStore((s) => s.accounts);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const t = useT();

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

  if (!message.reactions.length) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {message.reactions.map((r) => {
        const mine = myId !== null && r.accountIds.includes(myId);
        // 호버(`title`)와 스크린리더(`aria-label`)가 **같은 목록**을 말한다. 갈라 두면
        // 한쪽만 고쳐지고, 그러면 눈으로 본 것과 읽힌 것이 다르다.
        const who = reactorNames(r.accountIds, nameOf, myId, t);
        return (
          <button
            key={r.emoji}
            data-testid={`reaction-${r.emoji}`}
            data-mine={mine ? 'true' : 'false'}
            /*
              **호버로 누가 달았는지 보여 준다**(2026-09-09).

              칩에 이모지와 수만 있던 동안 화면에는 그 수가 누구인지 알 방법이 아예
              없었다 — `👀`·`💬` 는 "누가 이 말을 읽었나"가 신호의 뜻 전부인데
              (`STATUS_SIGNAL_EMOJI`) 화면은 몇 명인지만 말했다.

              문구를 문장으로 짜지 않고 **이름 목록만** 두는 이유: 이모지는 칩에 이미
              그려져 있으므로 문장은 그것을 한 번 더 말하는 것이고, `title` 은 OS 가
              그리는 평문이라 길어지면 우리가 접을 수 없다. 호버가 묻는 것은 "누구"다.
            */
            title={who}
            // 이모지 문자만으로는 스크린리더가 무엇인지 읽을 수 없다 — 누가 눌렀는지 함께 준다.
            aria-label={`${r.emoji} — ${who}`}
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
            onClick={() => toggle(r.emoji, !mine)}
          >
            <span>{r.emoji}</span>
            <span>{r.accountIds.length}</span>
          </button>
        );
      })}
    </div>
  );
}
