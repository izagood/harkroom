import { memo, useLayoutEffect, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useActiveStore } from '../state/communities';
import { MessageItem } from './MessageItem';
import { ProgressRow } from './ProgressRow';
import { AgentExchange } from './AgentExchange';
import { dayLabel, localDayKey } from '../lib/day';
import { exchangeRows, type ExchangeSlot } from '../lib/agentExchange';
import type { SectionId } from './settings/sections';
import type { Locale } from '../i18n';
import { markFirstMessagePaint } from '../lib/bootTimings';
import { useT } from '../i18n/useT';
import { topRowShift, type HeldTopRow } from '../lib/holdTopRow';

/**
 * 채널 대화 줄들 — **화면에 보이는 줄과 그 앞뒤 버퍼만 마운트한다**(대화 불러오기 성능,
 * 2026-09-29 사용자 결정 "근본 원인을 해결하는 방식").
 *
 * 왜 창인가: 채널을 열 때의 비용은 거의 전부 **줄 수에 비례하는 React 렌더와 DOM 커밋**이었다
 * (WebKit prod 벤치 150/500/1500행: 44~53 / 163~174 / 504~528ms). 첫 페이지를 줄이는 것
 * (D 안)은 행 수만 줄이는 완화책이고 `loadOlder` 로 늘어난 채널에서는 그대로 돌아온다. 창으로
 * 좁히면 비용이 행 수와 상관없이 **보이는 줄 수**에만 묶인다.
 *
 * 라이브러리는 `@tanstack/react-virtual`(headless)이다. 이 목록의 스크롤 상자·하단 고정·
 * 읽던 자리 붙잡기·과거 앵커는 `ChannelPane` 에 이미 회귀선과 함께 있고, headless 는 그
 * 상자를 **그대로 둔 채** 줄 마운트만 좁힌다. 상자를 통째로 가져가는 라이브러리
 * (react-virtuoso)는 그 회귀선들을 거의 다 새로 짜게 만든다.
 *
 * **줄은 보통 흐름에 둔다**(절대 위치 + translateY 가 아니라 위·아래 여백 상자). 이유는
 * `ChannelPane` 의 앵커 로직이 줄의 `offsetTop` 을 읽기 때문이다 — 절대 위치로 두면 모든 줄의
 * `offsetTop` 이 0 이 되어 읽던 자리를 붙잡는 코드가 조용히 죽는다.
 *
 * 화면 밖 줄은 DOM 에 없다. 그래서 여러 메시지에 걸친 드래그 선택·⌘A 복사·VoiceOver 전체
 * 읽기는 보이는 범위(버퍼 포함)까지만 된다 — Slack·Discord 와 같은 제약이고, 받아들이기로
 * 했다(스레드 ad8c5bd2 의 선택지 A). ⌘F 는 앱 검색(SearchPalette)이라 이 제약과 무관하다.
 */

/** 재지 않은 줄의 어림 높이(px). 한 줄짜리 메시지 + 이름줄이 대략 이만하다. */
export const ROW_ESTIMATE_PX = 72;
/**
 * 창 앞뒤로 더 마운트할 줄 수. 너무 작으면 빠르게 굴릴 때 빈 여백이 한 프레임 보이고,
 * 너무 크면 채널 전환 비용이 다시 커진다. 12 × 2 에 화면 한 장(~12줄)이면 36줄 안팎이다.
 */
export const ROW_OVERSCAN = 12;

/**
 * 과거를 받는 동안 맨 위에 세울 자리표시 줄 수(designer 안, 스레드 1a06bdce). 줄마다 높이는
 * `ROW_ESTIMATE_PX` 그대로다 — 창의 어림값과 같아야 넣는 순간 아무것도 밀리지 않는다.
 */
export const OLDER_SKELETON_ROWS = 3;

/**
 * 창으로 좁힐 수 있는 환경인가. 줄 높이를 재려면 `ResizeObserver` 가 있어야 한다 — jsdom 에는
 * 없고, 거기서는 **모든 줄을 그린다**(예전과 같다). 그래서 글자로 줄을 찾는 기존 화면
 * 테스트는 그대로 돌고, 창 쪽 동작은 `test/virtualRows.test.tsx` 가 관찰자를 세워 지킨다.
 */
function canVirtualize(): boolean {
  return typeof ResizeObserver !== 'undefined';
}

/** 자리의 첫 메시지 — 키·날짜·앵커의 기준이다(묶음도 목록에서는 한 자리다). */
function slotHead(slot: ExchangeSlot) {
  if (slot.kind === 'message') return slot.message;
  // 주고받기는 진행 묶음으로 시작할 수 있다 — 첫 **행**이 자리의 머리다.
  return slot.kind === 'exchange' ? exchangeRows(slot)[0]! : slot.messages[0]!;
}

function slotHas(slot: ExchangeSlot, id: string): boolean {
  if (slot.kind === 'message') return slot.message.id === id;
  return (slot.kind === 'exchange' ? exchangeRows(slot) : slot.messages).some((m) => m.id === id);
}

interface RowsProps {
  slots: ExchangeSlot[];
  /** `ChannelPane` 의 스크롤 상자. 창의 기준이 이 상자다. */
  scrollRef: RefObject<HTMLDivElement | null>;
  dividerBeforeId: string | null;
  locale: Locale;
  /** `Load older` 버튼이 줄 상자 위에 서는가 — 서면 줄 상자의 시작 위치가 바뀐다. */
  hasMore: boolean;
  /** 맨 위에 세울 자리표시 줄 수(과거를 받는 중일 때만, 0 이면 없음). */
  skeleton?: number;
  /**
   * 강조로 **우리가** 목록을 옮기기 직전에 부른다. 바닥 추종·정착 창을 여기서 꺼야 한다 —
   * 안 끄면 정착 루프가 방금 옮긴 자리를 바닥으로 되끌어 간다.
   */
  onJump: () => void;
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

export function MessageRows(props: RowsProps) {
  // 콜드 스타트 계측: 첫 메시지 줄이 그려진 때(프로세스에서 한 번, `bootTimings`).
  const hasRows = props.slots.length > 0;
  useEffect(() => { if (hasRows) markFirstMessagePaint(); }, [hasRows]);
  // 환경은 실행 중에 바뀌지 않는다 — 훅 순서가 흔들릴 일이 없다.
  return canVirtualize() ? <VirtualRows {...props} /> : <AllRows {...props} />;
}

function AllRows({ slots, skeleton = 0, dividerBeforeId, locale, onOpenDirectory, onOpenSettings }: RowsProps) {
  return (
    <>
      {skeleton > 0 && <OlderSkeleton rows={skeleton} />}
      {slots.map((slot, i) => (
        <SlotRow
          key={slotHead(slot).id}
          slot={slot}
          newDay={isNewDay(slots, i)}
          divider={slotHead(slot).id === dividerBeforeId}
          locale={locale}
          onOpenDirectory={onOpenDirectory}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </>
  );
}

/**
 * 앞 자리와 로컬 날짜가 다르면 새 날이다. 목록의 첫 자리도 새 날로 친다 — 그 채널의 첫 날도
 * 날이고, 여기에 선이 없으면 위쪽 메시지들의 날짜를 알 길이 없다. **DOM 이 아니라 배열로**
 * 판정하므로 앞 자리가 창 밖(마운트 안 됨)이어도 선은 같은 자리에 선다.
 */
function isNewDay(slots: ExchangeSlot[], i: number): boolean {
  const prev = slots[i - 1];
  return !prev || localDayKey(slotHead(prev).createdAt) !== localDayKey(slotHead(slots[i]!).createdAt);
}

function VirtualRows({ slots, scrollRef, dividerBeforeId, locale, hasMore, skeleton = 0, onJump, onOpenDirectory, onOpenSettings }: RowsProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * 줄 상자가 스크롤 내용에서 시작하는 위치(px). 상자 위에 여백·`Load older` 버튼이 있어
   * 0 이 아니다 — 창이 이 값을 모르면 그만큼 어긋난 줄을 마운트한다.
   */
  const [margin, setMargin] = useState(0);

  /**
   * **처음 그려질 때 바닥에 선다.** 이 컴포넌트는 채널마다 새로 만들어진다(`key`). 창은
   * 스크롤 상자의 지금 위치로 마운트할 줄을 고르는데, 상자는 채널이 바뀌어도 같은 DOM 이라
   * **떠난 채널의 위치**를 들고 있다 — 그대로 두면 새 채널의 엉뚱한 줄 서른 개를 한 번 그리고
   * 버린다. 바닥 이동은 `ChannelPane` 이 곧 하지만(그쪽 layout 효과는 자식인 이것보다 늦게
   * 돈다), 창이 위치를 읽기 **전에** 먼저 옮겨 둔다. 이 효과가 `useVirtualizer` 보다 위에
   * 있어야 하는 이유다(같은 컴포넌트의 효과는 선언 순서대로 돈다).
   */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * **스크롤 상자가 이 컴포넌트와 같은 커밋에 생기면 창이 상자를 못 본다.** React 는 ref 를
   * 자식부터 붙이므로, 자식인 이것의 layout 효과가 돌 때 부모 쪽 상자(`listRef`)는 아직
   * null 이다 — 앱을 채널이 열린 채로 켜는 첫 화면이 정확히 그 경우다. 창은 상자를 렌더마다
   * 다시 확인하지만 다음 렌더가 올 일이 없어 **빈 목록으로 멈춘다.** passive 효과는 모든 ref 가
   * 붙은 뒤에 돌므로, 거기서 상자가 생겼으면 바닥으로 옮기고 한 번 더 그린다.
   */
  const sawBoxRef = useRef(false);
  useLayoutEffect(() => { sawBoxRef.current = scrollRef.current !== null; }, [scrollRef]);
  const [, rerender] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (sawBoxRef.current || !el) return;
    el.scrollTop = el.scrollHeight;
    rerender((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const top = boxRef.current?.offsetTop ?? 0;
    setMargin((m) => (m === top ? m : top));
  }, [hasMore, slots.length === 0]);

  // 자리표시는 창의 **앞쪽 자리**로 둔다 — 창 밖의 덧붙은 상자로 두면 줄 상자의 시작 위치(`margin`)가
  // 한 렌더 늦게 따라와 그 사이 창이 어긋난 줄을 고른다. 번호 i 의 실제 자리는 `slots[i - skeleton]` 이다.
  const virtualizer = useVirtualizer({
    count: skeleton + slots.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: ROW_OVERSCAN,
    // 키는 **메시지 id** 다(자리 번호가 아니다). 과거가 앞에 붙으면 번호가 전부 밀리는데,
    // 잰 높이가 번호에 묶여 있으면 모든 줄이 남의 높이를 받는다.
    getItemKey: (i) => (i < skeleton ? `older-skeleton-${i}` : slotHead(slots[i - skeleton]!).id),
    scrollMargin: margin,
    // 첫 계산부터 바닥 쪽 줄을 고른다 — 위의 layout 효과와 같은 이유다.
    initialOffset: () => Number.MAX_SAFE_INTEGER,
  });

  /**
   * **강조 점프**(saved·검색·링크, `openMessage`). 예전에는 강조된 줄이 스스로
   * `scrollIntoView` 했다 — 줄이 늘 DOM 에 있었기 때문이다. 창 밖 줄은 마운트되지 않았으므로
   * 여기서 **번호로** 그 자리까지 옮기고, 마운트된 줄의 `scrollIntoView` 가 마무리한다.
   *
   * 한 강조에 한 번만 옮긴다(`jumpedRef`). 과거가 앞에 붙어 번호가 바뀔 때마다 다시 옮기면
   * 사람이 그 뒤로 굴린 자리를 빼앗는다.
   */
  const highlightedId = useActiveStore((s) => s.highlightedMessageId);
  const highlightIndex = useMemo(() => {
    const i = highlightedId ? slots.findIndex((s) => slotHas(s, highlightedId)) : -1;
    return i < 0 ? -1 : i + skeleton;
  }, [slots, highlightedId, skeleton]);
  const jumpedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightedId) { jumpedRef.current = null; return; }
    if (highlightIndex < 0 || jumpedRef.current === highlightedId) return;
    jumpedRef.current = highlightedId;
    onJump();
    virtualizer.scrollToIndex(highlightIndex, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightedId, highlightIndex]);

  /**
   * **위쪽이 바뀐 렌더에서 보던 줄을 붙잡는다**(`lib/holdTopRow.ts` 의 근거). 창이 마운트할 줄을 고르기
   * (`getVirtualItems`) **전에** 창의 스크롤 위치를 옮겨야 한다 — 고른 뒤에 옮기면 이미 옛 위치의 새 줄들이
   * 마운트되어 재측정 연쇄가 시작된 뒤다. DOM 쪽은 아래 layout 효과가 같은 값으로 맞춘다.
   *
   * 렌더 안에서 ref 를 고치는 것은 이 한 자리뿐이고 의도다: 창의 위치는 React 상태가 아니라 창이 들고 있는
   * 값이라, 효과로 미루면 그 렌더의 창이 옛 위치로 계산된다. StrictMode 의 두 번째 렌더에서는 `heldTopRef`
   * 가 이미 새 첫 줄이라 다시 옮기지 않는다.
   */
  const heldTopRef = useRef<HeldTopRow | null>(null);
  const pendingScrollRef = useRef(false);
  if (slots.length > 0) {
    // `getTotalSize` 가 창의 측정표를 지금 목록으로 새로 짠다 — 그 뒤의 `measurementsCache` 가 이 렌더의 값이다.
    virtualizer.getTotalSize();
    const measurements = virtualizer.measurementsCache;
    const shift = topRowShift(heldTopRef.current, (key) => {
      const i = slots.findIndex((s) => slotHead(s).id === key);
      return i < 0 ? null : measurements[i + skeleton]?.start ?? null;
    });
    if (shift !== 0 && virtualizer.scrollOffset !== null) {
      virtualizer.scrollOffset = Math.max(0, virtualizer.scrollOffset + shift);
      pendingScrollRef.current = true;
    }
    heldTopRef.current = { key: slotHead(slots[0]!).id, start: measurements[skeleton]!.start };
  } else {
    heldTopRef.current = null;
  }
  /**
   * 창이 옮긴 위치를 그리기 **전에** DOM 에도 쓴다.
   *
   * 쓰기 전에 이 커밋에 마운트된 줄을 **지금** 잰다. 굴리는 중이면 창은 새로 붙은 줄의 측정을 다음 프레임의
   * 관찰자로 미루는데, 그 사이 DOM 에는 실제 높이로 서 있고 창은 어림값(72px)으로 알고 있어 둘이 갈린다 —
   * 그 틈에 읽던 자리 보정(`ChannelPane` 의 `restoreAnchor`)과 창의 첫 측정 보정이 같은 성장을 두 번
   * 셌다(탐침: 즉시 응답 929px). 여기서 재면 창의 보정이 이 자리에서 한 번만 일어나고, 그 값이 곧 쓸 값이다.
   */
  useLayoutEffect(() => {
    if (!pendingScrollRef.current) return;
    pendingScrollRef.current = false;
    const el = scrollRef.current;
    const box = boxRef.current;
    if (!el || !box) return;
    box.querySelectorAll<HTMLElement>('[data-index]').forEach((node) => {
      virtualizer.resizeItem(Number(node.dataset.index), virtualizer.options.measureElement(node, undefined, virtualizer));
    });
    if (virtualizer.scrollOffset !== null) el.scrollTop = virtualizer.scrollOffset;
  });

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();
  const first = items[0];
  const last = items[items.length - 1];
  const padTop = first ? first.start - margin : 0;
  // 창이 아직 비었으면(상자를 못 본 첫 렌더) 전체 어림 높이를 한 여백으로 둔다 — 그래야
  // 위의 효과가 "바닥"으로 옮길 높이가 있다.
  const padBottom = last ? Math.max(0, total - (last.end - margin)) : total;

  return (
    <div ref={boxRef}>
      {/* 창 밖 줄들의 자리. 높이는 잰 값(없으면 어림값)의 합이다. */}
      <div style={{ height: padTop }} aria-hidden="true" />
      {items.map((item) => {
        if (item.index < skeleton) {
          return <SkeletonRow key={item.key} index={item.index} measureRef={virtualizer.measureElement} labelled={item.index === 0} />;
        }
        const slot = slots[item.index - skeleton]!;
        return (
          <SlotRow
            key={item.key}
            index={item.index}
            measureRef={virtualizer.measureElement}
            slot={slot}
            newDay={isNewDay(slots, item.index - skeleton)}
            divider={slotHead(slot).id === dividerBeforeId}
            locale={locale}
            onOpenDirectory={onOpenDirectory}
            onOpenSettings={onOpenSettings}
          />
        );
      })}
      <div style={{ height: padBottom }} aria-hidden="true" />
    </div>
  );
}

interface SlotRowProps {
  slot: ExchangeSlot;
  newDay: boolean;
  divider: boolean;
  locale: Locale;
  /** 창 안에서만 준다 — 창이 줄의 실제 높이를 재는 손잡이다. */
  index?: number;
  measureRef?: (el: HTMLElement | null) => void;
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

/**
 * 한 자리. `memo` 인 이유: 창은 스크롤할 때마다 목록을 다시 그리는데, 이미 마운트된 줄은
 * 그때 바뀐 것이 없다 — 새로 들어온 줄만 그려야 굴림이 가볍다.
 */
const SlotRow = memo(function SlotRow({ slot, newDay, divider, locale, index, measureRef, onOpenDirectory, onOpenSettings }: SlotRowProps) {
  const t = useT();
  const m = slotHead(slot);
  return (
    /* `data-anchor-id` 는 **읽던 자리를 붙잡을 손잡이**다(`lib/scrollAnchor.ts`).
       자리마다 하나여야 하므로 묶음도 첫 메시지의 id 를 쓴다 — 키와 같은 기준이다.
       `data-index` 는 창이 잰 높이를 이 자리에 돌려주는 표식이다. */
    <div data-anchor-id={m.id} data-index={index} ref={measureRef}>
      {/*
        날짜 구분선과 "New messages" 구분선은 **한 지점에 둘 다 걸릴 수 있고, 그때 둘 다 그린다**.
        하나를 감추면 "여기부터 새 날"과 "여기부터 안 읽음"이라는 서로 다른 두 사실 중
        하나가 사라진다. 날짜를 먼저 두는 것은 읽는 순서다 — 날이 바뀌고, 그 안에서 안 읽음이 시작된다.
      */}
      {newDay && (
        <div className="flex items-center gap-2 px-4 py-1" role="separator">
          <span className="h-px flex-1 bg-surface-hover" />
          <span className="text-meta font-medium text-fg-subtle">{dayLabel(m.createdAt, locale)}</span>
          <span className="h-px flex-1 bg-surface-hover" />
        </div>
      )}
      {divider && (
        <div className="flex items-center gap-2 px-4 py-1" role="separator">
          <span className="h-px flex-1 bg-danger-border" />
          <span className="text-meta font-medium text-danger">{t('chat.newMessages')}</span>
          <span className="h-px flex-1 bg-danger-border" />
        </div>
      )}
      {slot.kind === 'progress' ? <ProgressRow messages={slot.messages} endedAt={slot.endedAt} />
        : slot.kind === 'exchange'
          ? <AgentExchange messages={slot.messages} items={slot.items} onOpenDirectory={onOpenDirectory} onOpenSettings={onOpenSettings} />
          : <MessageItem message={m} onOpenDirectory={onOpenDirectory} onOpenSettings={onOpenSettings} />}
    </div>
  );
});

/** 본문 막대의 폭 — 줄마다 달리 해 실제 대화처럼 보이게 한다(designer 안). */
const SKELETON_BODY_WIDTHS = ['70%', '45%', '60%'];

/**
 * 과거를 받는 동안의 자리표시 한 줄. **높이는 `ROW_ESTIMATE_PX` 로 고정**이다 — 내용 길이를 흉내 내지
 * 않는다. 창의 어림값과 같아야 넣고 빼는 순간 위치 계산이 어긋나지 않는다. 모양은 메시지 줄(아바타 +
 * 이름 + 본문)을 따르고, 칠은 설정의 `ProviderUsageSkeleton` 과 같은 토큰이다.
 *
 * `data-anchor-id` 를 주지 않는다 — 읽던 자리를 붙잡을 후보가 아니다(곧 사라진다).
 */
function SkeletonRow({ index, measureRef, labelled }: { index: number; measureRef?: (el: HTMLElement | null) => void; labelled: boolean }) {
  const t = useT();
  return (
    <div
      data-index={index}
      ref={measureRef}
      data-testid="older-skeleton"
      // 화면 읽기에는 한 번만 알린다 — 세 줄 모두 status 면 같은 말을 세 번 읽는다.
      role={labelled ? 'status' : undefined}
      aria-label={labelled ? t('chat.loadingOlder') : undefined}
      className="flex items-start gap-2 overflow-hidden px-4 py-2"
      style={{ height: ROW_ESTIMATE_PX }}
    >
      <div className="h-8 w-8 shrink-0 rounded-avatar bg-border motion-safe:animate-pulse" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2 pt-1" aria-hidden="true">
        <div className="h-3 w-24 rounded-row bg-border motion-safe:animate-pulse" />
        <div className="h-3 rounded-row bg-border motion-safe:animate-pulse" style={{ width: SKELETON_BODY_WIDTHS[index % SKELETON_BODY_WIDTHS.length] }} />
      </div>
    </div>
  );
}

/** 창이 없는 환경(jsdom)의 자리표시 — 같은 줄을 그대로 쌓는다. */
function OlderSkeleton({ rows }: { rows: number }) {
  return <>{Array.from({ length: rows }, (_, i) => <SkeletonRow key={i} index={i} labelled={i === 0} />)}</>;
}
