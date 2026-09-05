import { useMemo, useState } from 'react';
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
import { TypingLine } from './TypingLine';
import type { SectionId } from './settings/sections';

export function ThreadPanel({ onOpenDirectory, onOpenSettings }: {
  /** 멘션 이동(#279). 스레드의 멘션도 대화의 멘션과 같게 동작해야 한다. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
} = {}) {
  const { activeChannelId, threadRootId, messages, accounts, me, online, connected } = useActiveStore();
  /** 채널과 같은 판정을 쓴다 — 모르는 계정은 에이전트로 치지 않는다(`lib/agentExchange`). */
  const isAgent = (id: string): boolean => accounts[id]?.kind === 'agent';
  const [alsoInChannel, setAlsoInChannel] = useState(false);

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

  if (!threadRootId) return null;

  return (
    <section className="flex w-96 flex-col border-l border-border bg-surface-raised">
      <header className="flex items-center border-b border-border px-4 py-2">
        <span className="font-bold">Thread</span>
        <ThreadStateBadge state={state} className="ml-2" />
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
      <div className="flex-1 overflow-y-auto py-2">
        {/* 채널과 **같은 함수**로 접는다 — 두 곳이 다른 판정을 쓰면 같은 대화가 자리마다
            다르게 보인다(`lib/progressGroup`·`lib/agentExchange`). 순서도 채널과 같아야 한다:
            진행을 먼저 접고 그 위에 주고받기를 접는다. */}
        {groupAgentExchanges(groupProgress(thread), isAgent).map((slot) => (
          slot.kind === 'progress'
            ? <ProgressRow key={slot.messages[0]!.id} messages={slot.messages} />
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
      </div>
      <TypingLine />
      <div className="border-t border-border p-3">
        <label className="mb-2 flex items-center gap-2 text-sm text-fg-muted">
          <input
            type="checkbox"
            checked={alsoInChannel}
            onChange={(e) => setAlsoInChannel(e.target.checked)}
            className="rounded border-border"
          />
          채널에도 올리기
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
