import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';
import { ProgressRow } from './ProgressRow';
import { groupProgress } from '../lib/progressGroup';
import { AgentExchange } from './AgentExchange';
import { groupAgentExchanges } from '../lib/agentExchange';
import { ThreadStateBadge } from './ThreadStateBadge';
import { threadState } from '../lib/threadState';
import { WaitChainLine } from './WaitChain';
import { waitChain } from '../lib/waitChain';
import { ThreadParticipants } from './ThreadParticipants';
import { Composer } from './Composer';
import { PaneResizer } from './PaneResizer';
import { paneStorage, paneMaxWidth, MIN_THREAD_WIDTH, MAX_THREAD_WIDTH, MIN_CHANNEL_WIDTH } from '../lib/prefs';
import { TypingLine } from './TypingLine';
import { isNearBottom } from '../lib/stickyBottom';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

export function ThreadPanel({ onOpenDirectory, onOpenSettings }: {
  /** 멘션 이동(#279). 스레드의 멘션도 대화의 멘션과 같게 동작해야 한다. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
} = {}) {
  const t = useT();
  const { activeChannelId, threadRootId, messages, accounts, me, online, connected } = useActiveStore();
  /** 채널과 같은 판정을 쓴다 — 모르는 계정은 에이전트로 치지 않는다(`lib/agentExchange`). */
  const isAgent = (id: string): boolean => accounts[id]?.kind === 'agent';
  const [alsoInChannel, setAlsoInChannel] = useState(false);

  /**
   * 패널 폭. 사이드바와 같은 모양으로 **바꿀 때마다 저장**한다 — 드래그가 끝날 때
   * 한 번만 저장하면 드래그 도중 창이 닫히거나 앱이 죽었을 때 고른 폭이 사라진다.
   */
  const [threadWidth, setWidth] = useState(() => paneStorage.loadThreadWidth());
  const setThreadWidth = useCallback((next: number) => {
    setWidth(next);
    paneStorage.saveThreadWidth(next);
  }, []);

  const thread = useMemo(() => {
    if (!activeChannelId || !threadRootId) return [];
    return (messages[activeChannelId] ?? [])
      .filter((m) => m.id === threadRootId || m.threadRootId === threadRootId)
      .sort((a, b) => a.seq - b.seq);
  }, [messages, activeChannelId, threadRootId]);

  /**
   * 이 스레드의 상태(Task 6). **스레드 패널에만 둔다** — 여기가 답글이 전부 로드된 유일한
   * 자리이기 때문이다(`controller.openThread` 가 열 때 받아 온다). 채널 요약 줄에도 같은
   * 줄을 달려면 서버가 스레드별 상태를 함께 실어 주어야 하고, 그것 없이 지금 데이터로
   * 그리면 **열어 보지 않은 스레드가 전부 '끝남'으로 보인다** — 계획서가 경계한 그 거짓말이다.
   */
  /**
   * 생존 신호를 **한 번만 계산해** 상태 배지 · 사슬 · 참여자 줄이 같은 값을 쓰게 한다.
   * 셋이 따로 계산하면 한 화면 안에서 서로 다른 사실을 말할 수 있다.
   * `connected` 가 false 면 presence 는 '모른다'다 — 빈 집합이 '아무도 없다'가 아니다
   * (`controller.startRunners` 와 같은 규약).
   */
  const live = useMemo(() => (connected ? new Set(online) : null), [connected, online]);

  const state = useMemo(() => threadState({
    messages: thread,
    myAccountId: me?.id ?? null,
    isAgent: (id) => accounts[id]?.kind === 'agent',
    live,
  }), [thread, me, accounts, live]);

  /**
   * 대기 사슬(Task 7). 상태 배지가 "무엇인가"를 말한다면 이 줄은 **"왜"** 를 말한다 —
   * 같은 `live` 규약을 쓴다(`null` 은 '모른다').
   */
  const chain = useMemo(() => waitChain({
    messages: thread,
    myAccountId: me?.id ?? null,
    live,
  }), [thread, me, live]);

  /**
   * **스레드를 열면 마지막 답글이 보여야 한다**(jaebin 보고, 2026-09-09): 스레드는 계속
   * 길어지는데 패널은 늘 맨 위에서 시작해, 열 때마다 손으로 끝까지 내려야 했다.
   *
   * 판정은 채널과 **같은 것을 쓴다**(`lib/stickyBottom`) — 두 자리가 다른 규칙을 쓰면 같은
   * 대화가 화면마다 다르게 움직인다. 다만 "아래로 내려가기" 버튼은 여기 두지 않았다:
   * 채널에 그 버튼이 생긴 이유는 목록이 수백 줄이라 위를 읽는 중 새 줄이 오면 되돌아갈
   * 길이 필요했던 것이고, 스레드는 답글 몇 줄짜리 상자다. 필요해지면 그때 붙인다.
   */
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 스크롤 상자 자체. 바닥에서 얼마나 떨어졌는지는 이 요소만 안다. */
  const listRef = useRef<HTMLDivElement>(null);
  /** 지금 바닥을 보고 있는가. 스레드를 열면 바닥에 서므로 기본값은 참이다. */
  const atBottomRef = useRef(true);

  /** `block: 'nearest'` 는 필수다 — 근거는 `ChannelPane` 의 같은 함수 위에 적혀 있다. */
  const scrollToBottom = () => {
    atBottomRef.current = true;
    bottomRef.current?.scrollIntoView?.({ block: 'nearest' });
  };

  /**
   * 스레드를 열거나 다른 스레드로 옮기면 **바닥에서 시작한다.** `atBottomRef` 를 되돌리는
   * 것이 핵심이다 — 스크롤 상자는 스레드가 바뀌어도 같은 DOM 이라 `scrollTop` 이 0 으로
   * 돌아가지 않고, 앞 스레드에서 위를 보던 값이 그대로 남는다.
   *
   * 열 때 답글은 아직 없을 수 있다(`controller.openThread` 가 받아 온다). 그때는 이 효과가
   * 짧은 목록의 바닥(=맨 위)으로 가고, 답글이 도착해 길이가 늘면 아래 효과가 다시 내려간다.
   */
  useEffect(() => { scrollToBottom(); }, [threadRootId]);

  /**
   * 답글이 늘었을 때. 채널과 같은 규율이다 — **바닥에 붙어 있을 때만** 따라 내려가고,
   * 위쪽을 읽는 중이면 화면을 건드리지 않는다. 내가 쓴 답글은 예외로 따라간다(위를 보다
   * 답을 보냈다면 그 사람의 관심은 방금 보낸 것에 있다).
   */
  useEffect(() => {
    if (atBottomRef.current || thread[thread.length - 1]?.authorId === me?.id) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.length]);

  /**
   * 바닥 여부를 ref 에 담는 이유도 채널과 같다: 이 값은 그리는 데 쓰이지 않으므로 상태로
   * 두면 스크롤 한 번에 패널이 프레임마다 다시 그려진다.
   */
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = isNearBottom(el);
  };

  if (!threadRootId) return null;

  return (
    /**
     * 폭: 고정 `w-96`(384px) → **가변 + 최소 480px**(계획 Task 10 Step 3) → 이제 **사람이
     * 끄는 값**이다. 선택지 카드 · 완료 보고 · 대기 사슬이 들어갈 자리가 필요한데 얼마나
     * 필요한지는 화면 크기와 지금 하는 일에 달렸다 — `max-w-[640px]` 상한은 그 답을 우리가
     * 대신 고른 것이었다.
     *
     * `flex-1` 을 버린 이유: `flex-1` 은 `flex-basis: 0%` 라 `width` 를 덮는다. 대신
     * `flex-shrink` 기본값(1)을 그대로 둬서, 창이 좁아지면 고른 폭보다 줄어들되
     * `minWidth` 아래로는 안 간다 — 전에 `min-w-[480px] flex-1` 이 하던 일과 같다.
     */
    <section
      /* `ChannelPane` 과 같은 이유로 붙은 손잡이다(그 파일의 주석) — 인박스가 자리가 되면서
         한 줄의 형제가 셋이 되었고, 그 순서를 재는 회귀선이 생겼다. */
      data-testid="thread-pane"
      className="relative flex flex-col border-l border-border bg-surface-raised"
      /* 상한은 `paneMaxWidth` 가 적는다(그 함수의 주석) — 터미널과 **같은 결함**을 여기서도
         막는다: 넓은 창에서 고른 폭이 좁은 창에서 그대로 서면 대화가 폭 0 으로 밀린다. */
      style={{ width: threadWidth, minWidth: MIN_THREAD_WIDTH, maxWidth: paneMaxWidth(MIN_THREAD_WIDTH, MIN_CHANNEL_WIDTH) }}
    >
      <PaneResizer
        label={t('thread.resizeHandle')}
        width={threadWidth}
        min={MIN_THREAD_WIDTH}
        max={MAX_THREAD_WIDTH}
        /* 이 구분선 왼쪽에는 대화만 있다. */
        minRoomLeft={MIN_CHANNEL_WIDTH}
        onWidth={setThreadWidth}
      />
      <header className="flex items-center border-b border-border px-4 py-2">
        <span className="font-bold">Thread</span>
        {/* `null` 은 '아직 아무 말도 못 봤다' — 그때는 배지를 그리지 않는다(`threadState`). */}
        {state && <ThreadStateBadge state={state} className="ml-2" />}
        {/* 참여자 줄과 터미널 선택자는 **헤더**다 — 세션이 (에이전트, 스레드)당 하나이므로
            문이 달릴 자리가 여기다(규칙 06). */}
        <div className="ml-auto flex items-center gap-2">
          <ThreadParticipants messages={thread} live={live} />
        </div>
        <button className="ml-2 rounded px-2 text-fg-subtle hover:bg-surface-sunken"
          onClick={() => getController().closeThread()}>
          ×
        </button>
      </header>
      {/* 사슬은 헤더 **바로 아래**다 — "무엇을 기다리는가"는 대화를 읽기 전에 알아야 한다. */}
      <WaitChainLine chain={chain} />
      <div
        ref={listRef}
        onScroll={onListScroll}
        /* 회귀선(`threadScroll.test.tsx`)이 이 상자의 스크롤 수치를 가짜로 세워야 한다 —
           jsdom 은 레이아웃을 재지 않아 `scrollHeight` 가 늘 0 이다(채널의 `channel-scroll`
           과 같은 이유). */
        data-testid="thread-scroll"
        className="flex-1 overflow-y-auto py-2"
      >
        {/* 채널과 **같은 함수**로 접는다 — 두 곳이 다른 판정을 쓰면 같은 대화가 자리마다
            다르게 보인다(`lib/progressGroup`·`lib/agentExchange`). 순서도 채널과 같아야 한다:
            진행을 먼저 접고 그 위에 주고받기를 접는다. */}
        {groupAgentExchanges(groupProgress(thread), isAgent).map((slot) => (
          slot.kind === 'progress'
            ? <ProgressRow key={slot.messages[0]!.id} messages={slot.messages} endedAt={slot.endedAt} />
            : slot.kind === 'exchange'
              ? (
                <AgentExchange
                  key={slot.messages[0]!.id}
                  messages={slot.messages}
                  inThread
                  onOpenDirectory={onOpenDirectory}
                  onOpenSettings={onOpenSettings}
                />
              )
              : (
                <MessageItem
                  key={slot.message.id}
                  message={slot.message}
                  inThread
                  onOpenDirectory={onOpenDirectory}
                  onOpenSettings={onOpenSettings}
                />
              )
        ))}
        <div ref={bottomRef} />
      </div>
      <TypingLine />
      <div className="border-t border-border p-3">
        {/* 이 체크박스를 켜면 말이 채널에도 나간다 — 읽고 정하는 자리라 본문단이다
            (앱 기본값 13px 이라 크기를 안 적는다). */}
        <label className="mb-2 flex items-center gap-2 text-fg-muted">
          <input
            type="checkbox"
            checked={alsoInChannel}
            onChange={(e) => setAlsoInChannel(e.target.checked)}
            className="rounded border-border"
          />
          {t('thread.alsoPostToChannel')}
        </label>
        <Composer
          scopeKey={`thread:${threadRootId}`}
          // 스레드도 그 채널 안이다 — 채널이 부르는 에이전트는 스레드 답글에서도 불린다(#173).
          // `channelId` 가 아니라 이쪽으로 넘기는 이유는 Composer 의 prop 주석에 있다:
          // 예약 표면은 스레드 뿌리를 못 실어서 답글을 채널 본문으로 내보낸다.
          autoMentionChannelId={activeChannelId ?? undefined}
          placeholder="Reply…"
          // 채널과 스레드 뿌리를 지금 것으로 붙인다(#223) — 창이 도는 동안 패널을 닫으면
          // 스토어의 `threadRootId` 는 null 이 되어 답글이 조용히 사라진다.
          onSend={(body, attachmentIds) =>
            getController().reply(body, attachmentIds, activeChannelId ?? undefined, threadRootId, alsoInChannel)}
        />
      </div>
    </section>
  );
}
