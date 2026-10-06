import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GalleryScopeContext } from './Attachments';
import type { GalleryScope } from '../lib/imageGallery';
import { getCommunityController, useActiveStore, useCommunityRegistry } from '../state/communities';
import { useWindowView } from '../state/windowView';
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
import { ThreadModelCollapsed, ThreadModelRow } from './ThreadModelRow';
import { Composer } from './Composer';
import { PaneResizer } from './PaneResizer';
import { paneStorage, paneMaxWidth, MIN_THREAD_WIDTH, MAX_THREAD_WIDTH, MIN_CHANNEL_WIDTH } from '../lib/prefs';
import { TypingLine } from './TypingLine';
import { isNearBottom } from '../lib/stickyBottom';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

export function ThreadPanel({ onOpenDirectory, onOpenSettings, reserveLeft = MIN_CHANNEL_WIDTH }: {
  /** 멘션 이동(#279). 스레드의 멘션도 대화의 멘션과 같게 동작해야 한다. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
  /**
   * 이 패널 왼쪽에 **남겨 둘 폭**. 기본은 대화의 하한이다. 왼쪽에 인박스가 서면 더 크게
   * 받는다(`MIN_INBOX_WIDTH`, UX ① H2) — 222px 는 작성창에는 버틸 만한 폭이지만 인박스
   * 줄(라벨·본문·채널·시각)에는 모자라 "불렀다" 가 한 글자씩 세로로 꺾였다.
   */
  reserveLeft?: number;
} = {}) {
  const t = useT();
  const { messages, accounts, me, online, connected } = useActiveStore();
  // 보는 자리는 **이 창의 것**이다(새 창 — `state/windowView`). 메인이면 스토어 그대로다.
  const view = useWindowView();
  const { channelId: activeChannelId, threadRootId } = view;
  // 답글을 보낼 커뮤니티 — 보낸 순간의 것을 붙잡는다(PR #997, ChannelPane 과 같은 이유).
  const communityId = useCommunityRegistry((s) => s.activeId);
  /** 채널과 같은 판정을 쓴다 — 모르는 계정은 에이전트로 치지 않는다(`lib/agentExchange`). */
  const isAgent = (id: string): boolean => accounts[id]?.kind === 'agent';
  const [alsoInChannel, setAlsoInChannel] = useState(false);
  // 접힌 `모델 · 모두 기본` 칩을 눌러 연 줄(결정 10). 스레드를 바꾸면 다시 접는다.
  const [modelsOpen, setModelsOpen] = useState(false);
  useEffect(() => { setModelsOpen(false); }, [threadRootId]);

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
   * 판정도 **기계도** 채널과 같은 것을 쓴다(`lib/stickyBottom` + 아래 관찰자 보정). #691 이
   * 여기에 넣은 것은 효과 둘(열 때·줄 수가 늘 때)뿐이었고, 바로 다음 날 #693 이 채널에서
   * 같은 증상을 고치며 더한 셋(그리기 전 이동 · 관찰자 보정 · `stickyRef`)이 이 파일에는
   * 오지 않았다. 그래서 스레드에서만 증상이 남았다(jaebin 보고, 2026-09-10).
   *
   * 다만 "아래로 내려가기" 버튼은 여전히 여기 두지 않는다: 채널에 그 버튼이 생긴 이유는
   * 목록이 수백 줄이라 위를 읽는 중 새 줄이 오면 되돌아갈 길이 필요했던 것이고, 스레드는
   * 답글 몇 줄짜리 상자다. 필요해지면 그때 붙인다(#691 의 결정을 그대로 잇는다).
   */
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 스크롤 상자 자체. 바닥에서 얼마나 떨어졌는지는 이 요소만 안다. */
  const listRef = useRef<HTMLDivElement>(null);
  /** 지금 바닥을 보고 있는가. 스레드를 열면 바닥에 서므로 기본값은 참이다. */
  const atBottomRef = useRef(true);
  /**
   * 바닥에 **붙어 있기로 했는가.** `atBottomRef`("지금 바닥이 보이는가")와 갈리는 순간이
   * 있다: 늦게 붙은 그림이 답글을 아래로 늘리면 **바닥은 안 보이는데 사람은 아무것도 하지
   * 않았다.** 아래 보정이 `atBottomRef` 만 보면 그것을 "위를 읽는 중"으로 오해한다.
   * 이 값은 **사람이 위로 올렸을 때만** 거짓이 된다(`onListScroll`). 채널과 같은 규약이다.
   */
  const stickyRef = useRef(true);
  /** 직전 스크롤 위치. 사람이 올린 것과 브라우저가 옮긴 것을 가르는 데만 쓴다. */
  const lastScrollTopRef = useRef(0);

  /** `block: 'nearest'` 는 필수다 — 근거는 `ChannelPane` 의 같은 함수 위에 적혀 있다. */
  const scrollToBottom = () => {
    atBottomRef.current = true;
    stickyRef.current = true;
    bottomRef.current?.scrollIntoView?.({ block: 'nearest' });
    // 방금 **우리가** 옮긴 자리를 직전 위치로 적어 둔다. 이것이 없으면 다음 스크롤을 재는
    // 기준이 0 으로 남아, 사람이 위로 올린 것을 "내용이 자랐다"로 오해한다.
    const el = listRef.current;
    if (el) lastScrollTopRef.current = el.scrollTop;
  };

  /**
   * 스레드를 열거나 다른 스레드로 옮기면 **바닥에서 시작한다.** `atBottomRef`·`stickyRef` 를
   * 되돌리는 것이 핵심이다 — 스크롤 상자는 스레드가 바뀌어도 같은 DOM 이라 `scrollTop` 이
   * 0 으로 돌아가지 않고, 앞 스레드에서 위를 보던 값이 그대로 남는다.
   *
   * `useLayoutEffect` 인 이유는 채널과 같다(#693): 그리기 **전에** 내려간다. `useEffect` 는
   * 화면이 한 번 나온 뒤에 도므로 앞 스레드의 `scrollTop` 이 남은 어중간한 자리가 한 프레임
   * 번쩍인다.
   *
   * 열 때 답글은 아직 없을 수 있다(`controller.openThread` 가 뿌리를 세운 **뒤에** 받아
   * 온다). 그때는 이 효과가 짧은 목록의 바닥(=맨 위)으로 가고, 답글이 도착해 길이가 늘면
   * 아래 효과가, 길이는 그대로인데 높이만 자라면 그 아래 관찰자가 다시 내려간다.
   */
  useLayoutEffect(() => { scrollToBottom(); }, [threadRootId]);

  /**
   * 답글이 늘었을 때. 채널과 같은 규율이다 — **바닥에 붙어 있을 때만** 따라 내려가고,
   * 위쪽을 읽는 중이면 화면을 건드리지 않는다. 내가 쓴 답글은 예외로 따라간다(위를 보다
   * 답을 보냈다면 그 사람의 관심은 방금 보낸 것에 있다).
   */
  /**
   * **강조 점프(saved·검색·링크)로 온 답글이면 바닥 추종을 끈다**(2026-10-01, Saved 클릭 이동이
   * 중간에 멈춤 — 채널의 `onJump` 와 같은 일이다).
   *
   * **어느 길로 왔는가에 따라 커밋이 다르다**(qa_manager 실측, 2026-10-01):
   * - `openThread(…, { focusMessageId })`(채널에 함께 올라온 답의 "최근 댓글 보기")는 답글
   *   페이지를 넣는 것과 강조를 **같은 동기 구간에서** 건다 → React 가 한 커밋으로 묶는다.
   * - `openMessage`(Saved·검색·링크)는 `await this.openThread()` 가 재개된 **뒤에** 강조를 건다 →
   *   실측에서 답글 커밋과 강조 커밋이 **둘로 갈렸다.** 이 길의 멈춤은 주로 접힌 묶음 안의
   *   대상이었다(`AgentExchange`·`ProgressRow` 의 펼침).
   * 한 커밋이면 자식 `MessageItem` 이 그 줄로 `scrollIntoView` 한 뒤 아래 `[thread.length]` 효과가
   * 도는데, 그때 `atBottomRef` 는 스레드를 연 layout 효과가 세운 참 그대로라 방금 옮긴 자리를
   * 바닥으로 되끌어 갔다. 두 커밋이어도 이 효과는 무해하고, 커밋 순서가 바뀌는 날의 방어선이다. 고정(`stickyRef`)도 참으로 남아 늦게
   * 자라는 그림·링크 카드가 바닥 관찰자를 통해 한 번 더 끌어내렸다.
   *
   * 그래서 강조된 줄이 이 스레드에 실린 **그 커밋에서** 사람이 위로 올린 것과 같은 상태로 만든다.
   * 이 효과는 아래 길이 효과보다 **먼저 선언해야 한다**(같은 컴포넌트의 효과는 선언 순서대로 돈다).
   * 한 강조에 한 번만 한다 — 그 뒤에 사람이 바닥으로 내려가 다시 붙는 것을 막지 않는다.
   */
  const highlightedId = useActiveStore((s) => s.highlightedMessageId);
  const highlightInThread = !!highlightedId && thread.some((m) => m.id === highlightedId);
  const jumpedForRef = useRef<string | null>(null);
  const jumpedThisCommitRef = useRef(false);
  useEffect(() => {
    if (!highlightedId) { jumpedForRef.current = null; return; }
    if (!highlightInThread || jumpedForRef.current === highlightedId) return;
    jumpedForRef.current = highlightedId;
    jumpedThisCommitRef.current = true;
    atBottomRef.current = false;
    stickyRef.current = false;
  }, [highlightedId, highlightInThread]);

  useEffect(() => {
    // 줄 수가 는 까닭이 점프가 불러온 답글 페이지면 따라가지 않는다 — "내가 쓴 답글은 따라
    // 간다" 예외도 여기서는 뜻이 없다(마지막 답글이 내 것인 스레드에서 점프가 되끌려 갔다).
    if (jumpedThisCommitRef.current) return;
    if (atBottomRef.current || thread[thread.length - 1]?.authorId === me?.id) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.length]);
  // 점프 표식은 **그 커밋 한 번**만 산다 — 남겨 두면 다음에 내가 보낸 답글까지 안 따라간다.
  useEffect(() => { jumpedThisCommitRef.current = false; });

  /**
   * **늦게 자라는 내용까지 따라간다**(#693 이 채널에 넣은 보정을 스레드에도 놓는다).
   *
   * 위의 두 효과는 목록이 **몇 줄인지** 바뀔 때만 돈다. 그런데 줄 수는 그대로인 채 높이가
   * 자라는 길이 여럿 있고, 스레드는 채널보다 그 길이 잦다 — 첨부 그림은 URL 을 받아온
   * **뒤에** `<img>` 가 생기고(`Attachments.tsx` 의 `useAttachmentUrl`), 링크 미리보기 카드도
   * fetch 가 끝난 뒤에 붙고(`MessageBody` → `LinkPreview`), 접힌 진행·주고받기가 펴지고,
   * 글꼴이 늦게 오면 모든 줄이 함께 자란다. 바닥으로 내려간 다음 그런 것들이 몇백 px 자라면
   * **스크롤 이벤트는 일어나지 않는다**(내용이 자란 것이지 사람이 움직인 것이 아니다) —
   * 화면은 그 자리에 남고, 자란 만큼이 그대로 "내려가야 하는 거리"가 된다.
   *
   * 그래서 **바닥 표식이 상자 밖으로 나가는 순간**을 신호로 삼는다. `root` 를 스크롤 상자로
   * 주는 것이 핵심이다 — 기준은 창이 아니라 이 상자다.
   *
   * 딸림값이 `[threadRootId]` 인 것도 채널과 같은 이유다: 뿌리가 없으면 이 컴포넌트는 아래
   * 이른 반환(`if (!threadRootId) return null`)을 타므로 스크롤 상자도 바닥 표식도 없다.
   * `[]` 로 두면 관찰자가 **영원히 안 붙는다.**
   */
  useEffect(() => {
    const root = listRef.current;
    const marker = bottomRef.current;
    // jsdom 에는 `IntersectionObserver` 가 없다. 없으면 이 보정만 빠지고 줄 수로 도는 위의
    // 효과는 그대로 돈다 — `scrollIntoView?.()` 의 옵셔널과 같은 태도다.
    if (!root || !marker || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!stickyRef.current) return;
        if (entries.some((e) => e.isIntersecting)) return;
        scrollToBottom();
      },
      { root },
    );
    io.observe(marker);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadRootId]);

  /**
   * 바닥 여부를 ref 에 담는 이유도 채널과 같다: 이 값은 그리는 데 쓰이지 않으므로 상태로
   * 두면 스크롤 한 번에 패널이 프레임마다 다시 그려진다.
   */
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;
    const near = isNearBottom(el);
    atBottomRef.current = near;
    // 사람이 손으로 바닥까지 내려왔으면 다시 붙는다.
    if (near) {
      stickyRef.current = true;
      return;
    }
    /**
     * 바닥에서 떨어져 있다 — **누가 떨어뜨렸는지**가 갈린다. 사람이 위로 올렸으면
     * `scrollTop` 이 **줄어든다.** 내용이 자라서 멀어진 경우에는 줄지 않는다(아래로 자라면
     * 그대로이고, 위쪽에 그림이 붙으면 브라우저의 스크롤 앵커링이 오히려 밀어 준다).
     * 후자를 "사람이 올렸다"로 읽으면 고정이 풀려 위의 관찰자 보정이 죽는다.
     */
    if (el.scrollTop < prevTop) stickyRef.current = false;
  };

  // 스레드 패널에서 연 그림은 이 스레드(루트+답글)의 그림을 넘긴다(그림 넘겨 보기 사양 1).
  const gallery = useMemo<GalleryScope | null>(() => (threadRootId ? { kind: 'thread', rootId: threadRootId } : null), [threadRootId]);

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
    <GalleryScopeContext.Provider value={gallery}>
    <section
      /* `ChannelPane` 과 같은 이유로 붙은 손잡이다(그 파일의 주석) — 인박스가 자리가 되면서
         한 줄의 형제가 셋이 되었고, 그 순서를 재는 회귀선이 생겼다. */
      data-testid="thread-pane"
      className="relative flex flex-col border-l border-border bg-surface-raised"
      /* 상한은 `paneMaxWidth` 가 적는다(그 함수의 주석) — 터미널과 **같은 결함**을 여기서도
         막는다: 넓은 창에서 고른 폭이 좁은 창에서 그대로 서면 대화가 폭 0 으로 밀린다. */
      style={{ width: threadWidth, minWidth: MIN_THREAD_WIDTH, maxWidth: paneMaxWidth(MIN_THREAD_WIDTH, reserveLeft) }}
    >
      <PaneResizer
        label={t('thread.resizeHandle')}
        width={threadWidth}
        min={MIN_THREAD_WIDTH}
        max={MAX_THREAD_WIDTH}
        /* 이 구분선 왼쪽에는 대화(또는 인박스) 하나만 있다. */
        minRoomLeft={reserveLeft}
        onWidth={setThreadWidth}
      />
      <header className="flex items-center border-b border-border px-4 py-2">
        <span className="font-semibold">{t('thread.title')}</span>
        {/* `null` 은 '아직 아무 말도 못 봤다' — 그때는 배지를 그리지 않는다(`threadState`). */}
        {state && <ThreadStateBadge state={state} className="ml-2" />}
        {/* 참여자 줄과 터미널 선택자는 **헤더**다 — 세션이 (에이전트, 스레드)당 하나이므로
            문이 달릴 자리가 여기다(규칙 06). */}
        <div className="ml-auto flex items-center gap-2">
          <ThreadModelCollapsed rootId={threadRootId} expanded={modelsOpen} onToggle={() => setModelsOpen((v) => !v)} />
          <ThreadParticipants messages={thread} live={live} />
        </div>
        <button className="ml-2 rounded-row px-2 text-fg-subtle hover:bg-surface-sunken"
          onClick={() => view.closeThread()}>
          ×
        </button>
      </header>
      {/* 사슬은 헤더 **바로 아래**다 — "무엇을 기다리는가"는 대화를 읽기 전에 알아야 한다. */}
      {/* 모델 줄은 사슬보다 **위**다 — 이 스레드가 어떤 비용으로 도는지가 기다림보다 먼저 정해진다. */}
      {activeChannelId && (
        <ThreadModelRow channelId={activeChannelId} rootId={threadRootId} thread={thread} expanded={modelsOpen} />
      )}
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
        {/* 답글이 하나도 없는 스레드 — 머리 하나만 서 있으면 "열렸다"가 아니라 "빈 화면"으로
            읽힌다. 머리는 목록에 포함되므로 길이 1 이 곧 '답글 없음'이다. */}
        {thread.length <= 1 && (
          <p data-testid="thread-empty" className="px-4 py-2 text-meta text-fg-subtle">{t('thread.empty')}</p>
        )}
        {/* 바닥 표식. 관찰자 보정이 지켜보는 대상이라 회귀선이 집을 손잡이가 필요하다
            (채널의 `channel-bottom` 과 같다). */}
        <div ref={bottomRef} data-testid="thread-bottom" />
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
            className="rounded-row border-border"
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
          onSend={(body, attachmentIds, agentModels) =>
            (agentModels?.length
              ? getCommunityController(communityId).reply(body, attachmentIds, activeChannelId ?? undefined, threadRootId, alsoInChannel, agentModels)
              : getCommunityController(communityId).reply(body, attachmentIds, activeChannelId ?? undefined, threadRootId, alsoInChannel))}
        />
      </div>
    </section>
    </GalleryScopeContext.Provider>
  );
}
