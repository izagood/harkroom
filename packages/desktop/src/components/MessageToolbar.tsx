import { useEffect, useRef, useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';
import { Menu, type MenuItem } from './Menu';
import { InlineReactionButtons, ReactionPickerPanel } from './Reactions';
import { SavedIcon } from './RailIcons';
import { DotsIcon, EmojiPlusIcon, LinkIcon, ThreadIcon } from './MessageIcons';

/**
 * 메시지 우상단 호버 툴바 — **여덟 칸**(요청 2026-09-09 · 순서까지 지정받았다).
 *
 * ```
 * ✅ 👀 👍 [이모지＋] │ [스레드] [링크 복사] [담기] │ [⋯]
 *   리액션 넷        │  이 말에 하는 일 셋      │ 나머지
 * ```
 *
 * ## 왜 파일을 갈랐는가
 *
 * `MessageItem` 이 이미 900줄이다. 툴바는 이제 자기 상태(고르는 창이 열렸는가)와 자기
 * 키보드 규칙을 갖는데, 그것을 그 파일에 얹으면 "행을 그리는 일"과 "툴바를 운전하는 일"이
 * 한 컴포넌트에 섞인다. 툴바가 필요한 것은 `message` 와 메뉴 항목뿐이라 경계가 깔끔하다.
 *
 * ## 세 묶음으로 갈라 두는 이유
 *
 * 앞 판은 성질이 다른 다섯(리액션 셋 · 리액션 더 · 스레드 · 메뉴)이 **같은 간격**으로 서
 * 있었다. 그래서 전부 같은 무게로 읽혔고, 정작 제일 자주 쓰는 스레드 진입이 이모지들 사이에
 * 묻혔다. 구분선 둘이 하는 일은 장식이 아니라 **분류**다: 기분을 남기는 일 / 이 말에 무언가를
 * 하는 일 / 덜 쓰는 나머지.
 *
 * ## 스레드 버튼은 **상태와 무관하게** 선다
 *
 * 앞 판은 `!hasActivity` 일 때만 그렸고, 답글이 하나라도 달리면 본문 열의 요약 줄이 그
 * 역할을 대신했다(#396). "같은 진입을 두 곳에 두지 않는다"는 규율을 지킨 것인데, 값이
 * **두 자리를 번갈아 비우는** 방식으로 지켜져서 손이 갈 자리가 고정되지 않았다 — 사람이
 * 볼 수 없는 집계값(`activityCount`)에 따라 진입점이 이사를 다닌 것이다(2026-09-09 신고:
 * "채팅만 있는 경우 스레드에 답글을 못 달아").
 *
 * 그래서 역할을 **자리로** 가른다: 툴바는 **행동**("답한다"), 본문 열의 요약 줄은
 * **상태**("답글 3개가 달렸다"). 둘은 같은 곳으로 가지만 다른 질문에 답하고, 둘 다 늘 그
 * 자리에 있다. `inThread` 에서만 그리지 않는다 — 스레드 안에서는 하단 입력칸이 그 일이다.
 */
export function MessageToolbar({ message, inThread, menuItems, onCopyLink }: {
  message: MessageRow;
  inThread: boolean;
  menuItems: MenuItem[];
  /** 링크 만들기·복사 알림은 `MessageItem` 에 있다 — 이 버튼은 그것을 부르기만 한다. */
  onCopyLink: () => void;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  // #219 와 같은 판단: 담김은 **id 집합**으로 본다(한 탭의 행들로 판단하면 '완료' 탭을 열어
  // 본 뒤로 open 인 메시지가 담기지 않은 것으로 읽힌다).
  const savedIds = useActiveStore((s) => s.savedIds);
  const isSaved = savedIds.includes(message.id);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickBtnRef = useRef<HTMLButtonElement>(null);

  /**
   * 창을 닫는 길 둘 — Esc 와 바깥 클릭.
   *
   * 닫을 때 **포커스를 트리거로 되돌린다.** 되돌리지 않으면 포커스가 사라진 요소에 남아
   * 다음 Tab 이 문서 맨 앞으로 튄다 — 키보드로 리액션을 하나 달면 그 뒤로 길을 잃는다.
   */
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setPicking(false);
      pickBtnRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setPicking(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [picking]);

  /**
   * 좌우 화살표로 칸을 옮긴다(`role="toolbar"` 의 규약).
   *
   * 자리를 `data-slot` 으로 모으는 이유: 자식의 **DOM 순서**가 곧 자리 순서라, 순서를 다시
   * 배열로 적어 두면 두 곳이 어긋날 수 있다. 여기서 세는 것은 화면에 실제로 그려진 칸들이다
   * (스레드 칸은 `inThread` 에서 빠진다).
   */
  const onArrow = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const slots = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-slot]') ?? []);
    const at = slots.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || slots.length === 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' ? (at + 1) % slots.length : (at - 1 + slots.length) % slots.length;
    slots[next]?.focus();
  };

  /**
   * 숨는 방식은 반드시 **opacity** 다 — `visibility:hidden` 은 접근성 트리에서 요소를 지워
   * 키보드 경로를 없앤다(`Reactions.tsx` 주석이 그 비용을 기록한다).
   *
   * **`focus-visible:` 이 아니라 `group-focus-within:` 이다.** 앞 판은 이 자리에
   * `focus-visible:opacity-100` 을 적어 두었는데, 그것이 걸린 곳은 **포커스를 받을 수 없는
   * 컨테이너**였다 — 안의 버튼에 Tab 으로 들어가도 컨테이너는 포커스를 받지 않으므로
   * 불투명도가 0 에 머물렀다. 버튼은 접근성 트리에 있고 눌리기까지 하는데 **보이지 않는**
   * 상태였다. `group-*` 은 행(`group`)을 가리키고, `focus-within` 은 자손의 포커스를 받는다.
   *
   * `data-open` 은 **창이나 메뉴가 열린 동안 툴바를 붙잡는다.** 이것이 없으면 창을 향해
   * 마우스를 옮기다 행을 벗어나는 순간 툴바째 사라진다(창은 툴바의 자식이다). 메뉴는
   * 자기 `aria-expanded` 로 말하므로 `has-*` 로 함께 받는다 — 그쪽 상태를 이 컴포넌트가
   * 또 들고 있으면 두 곳이 어긋난다.
   */
  const reveal = 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
    + ' data-[open=true]:opacity-100 has-[[aria-expanded=true]]:opacity-100';

  /**
   * 여덟 칸이 **같은 상자**를 쓴다. 과녁은 28px 이다.
   *
   * 24px 에 칸 사이 1px(`gap-px`)이던 앞 판은 신고를 받았다(2026-09-10: "너무 따닥따닥
   * 붙어있어"). 문제는 과녁 크기 자체가 아니라 **이웃과의 거리**였다 — 16px 그림이
   * 24px 상자에 들어가면 그림 사이가 9px 이라, 겨눈 칸을 조금만 지나쳐도 옆 칸이 눌린다.
   * 리액션은 되돌릴 수 있지만 '담기'는 목록을 흔들고 '⋯' 는 메뉴를 연다.
   *
   * 그래서 상자를 28px 로 키우고 사이를 4px 로 벌렸다(그림 사이 16px). 두 값을 함께 올린
   * 이유: 사이만 벌리면 툴바만 길어지고 과녁은 그대로라 겨누기가 쉬워지지 않는다.
   * 창(`ReactionPickerPanel`)이 이미 32px 칸에 4px 사이를 쓰므로, 사이 값은 그쪽과 같다.
   */
  const slot = 'flex h-7 w-7 items-center justify-center rounded-md text-fg-muted'
    + ' hover:bg-surface-hover hover:text-fg';
  /** 눌린 칸(담김·리액션)은 **가라앉은 면**으로 말한다. 강조색은 '내 차례'가 쓴다(규칙 04). */
  const slotOn = 'flex h-7 w-7 items-center justify-center rounded-md bg-surface-sunken text-fg';

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="message toolbar"
      aria-orientation="horizontal"
      data-open={picking ? 'true' : 'false'}
      onKeyDown={onArrow}
      /* 행의 **위쪽 경계에 걸친다**(`-top-3`). 앞 판은 `top-1` 이라 한 줄 긴 말의 오른쪽
         끝을 덮었다 — 여덟 칸이면 폭이 200px 을 넘으므로 그만큼 더 덮는다. */
      className={`absolute -top-3 right-2 flex items-center gap-1 rounded-lg border border-border
                  bg-surface-raised p-1 shadow-sm ${reveal}`}
    >
      {/* 창은 툴바의 **자식**이다 — 툴바가 사라지면 창도 사라져야 하고(고아 팝오버를 만들지
          않는다), 바깥 클릭 판정도 `rootRef` 하나로 끝난다. */}
      {picking && (
        <ReactionPickerPanel
          message={message}
          onClose={() => { setPicking(false); pickBtnRef.current?.focus(); }}
        />
      )}

      <InlineReactionButtons message={message} className={slot} classNameOn={slotOn} />

      <button
        ref={pickBtnRef}
        data-slot
        data-testid="toolbar-react-pick"
        className={picking ? slotOn : slot}
        /* 이름을 **바꾸지 않는다** — 이 버튼의 접근 이름은 `Reactions.tsx` 가 쓰던 그대로다.
           그림만 얼굴＋로 바뀌었고, 하는 일은 같다. */
        aria-label="Add reaction"
        aria-expanded={picking}
        aria-haspopup="true"
        onClick={() => setPicking((v) => !v)}
      >
        <EmojiPlusIcon />
      </button>

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />

      {!inThread && (
        <button
          data-slot
          data-testid="toolbar-thread"
          className={slot}
          title={t('message.replyInThread')}
          aria-label={t('message.replyInThread')}
          onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
        >
          <ThreadIcon />
        </button>
      )}

      <button
        data-slot
        data-testid="toolbar-copy-link"
        className={slot}
        title={t('message.copyLink')}
        aria-label={t('message.copyLink')}
        onClick={onCopyLink}
      >
        <LinkIcon />
      </button>

      <button
        data-slot
        data-testid="toolbar-save"
        className={isSaved ? slotOn : slot}
        title={t(isSaved ? 'message.unsave' : 'message.save')}
        aria-label={t(isSaved ? 'message.unsave' : 'message.save')}
        aria-pressed={isSaved}
        onClick={() => {
          const c = getController();
          void (isSaved ? c.unsaveMessage(message.id) : c.saveMessage(message.id));
        }}
      >
        {/* 담긴 것은 **채운 책갈피**다 — 색이 아니라 형태로 가른다. `SavedIcon` 은 `fill="none"`
            을 속성으로 들고 있고 CSS 가 속성을 이기므로, 같은 그림 하나로 두 상태를 낸다
            (그림을 복제하면 레일·표식·이 버튼이 언젠가 서로 달라진다). */}
        <span className={isSaved ? '[&_path]:fill-current' : undefined}>
          <SavedIcon size={16} />
        </span>
      </button>

      <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />

      {
        // 항목이 하나도 없으면 트리거를 만들지 않는다 — 열어도 비어 있는 메뉴는
        // "할 수 있는 게 있다"는 거짓 신호다(design.md §4). 링크 복사가 툴바로 올라간
        // 뒤로 이 가드는 **실제로 거짓이 될 수 있다**(본문 복사만 남아도 하나는 남지만,
        // 조건이 다시 전부 붙는 날이 오면 여기서 걸린다).
        menuItems.length > 0 && (
          <Menu
            renderTrigger={(props) => (
              <button {...props} data-slot className={slot} aria-label="More actions">
                <DotsIcon />
              </button>
            )}
            items={menuItems}
            placement="bottom"
          />
        )
      }
    </div>
  );
}
