import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { TypingLine } from './TypingLine';
import { ChannelFiles } from './ChannelFiles';
import { ChannelDocPanel } from './ChannelDocPanel';
import { ChannelEmptyState } from './ChannelEmptyState';
import { RunnerStatusLine } from './RunnerStatus';
import { dayLabel, localDayKey } from '../lib/day';
import { displayBody } from '../lib/mention';
import { mentionedHandles, mentionedIds } from '@murmur/shared';
import type { SectionId } from './settings/sections';

interface ChannelPaneProps {
  /**
   * 검색 팔레트를 여는 요청. `scoped` 는 "지금 보는 대화로 좁혀서" 라는 뜻이다.
   *
   * 옵셔널인 이유는 이 컴포넌트를 홀로 띄우는 기존 테스트가 많아서다. 안 넘기면 버튼이
   * 아무 일도 하지 않으므로 배선이 끊기면 조용히 죽은 버튼이 된다 —
   * `test/searchEntryPoint.test.tsx` 가 Workspace 를 통째로 띄워 그 배선을 지킨다.
   */
  onOpenSearch?: (scoped: boolean) => void;
  /**
   * 멘션을 눌렀을 때 갈 곳(#279). `onOpenSearch` 와 같은 이유로 옵셔널이고 같은 위험을 진다 —
   * 넘기지 않으면 멘션이 버튼이 아니게 되고 화면에서는 조용하다. `test/mentionClick.test.tsx`
   * 가 `Workspace` 를 통째로 띄워 그 배선을 지킨다.
   */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}

export function ChannelPane({ onOpenSearch, onOpenDirectory, onOpenSettings }: ChannelPaneProps) {
  const { activeChannelId, channels, dms, accounts, me, messages, hasMore, dividerSeq, pins, runnerStates } = useActiveStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  // 파일 색인(#232)은 채널 안에서 열고 닫는 패널이다 — 새 최상위 화면이 아니다. 그래서
  // 열림 상태도 채널 화면이 들고 있고, 채널이 바뀌면 `key` 로 패널이 다시 만들어진다.
  const [filesOpen, setFilesOpen] = useState(false);
  /**
   * 고정 목록은 **접힌 채로 시작한다**(#218). 핀은 "필요할 때 찾아가는 자리"이지 늘 읽는
   * 것이 아니고, 펼친 채로 두면 핀이 몇 개만 쌓여도 대화가 화면 아래로 밀린다.
   * 채널을 옮기면 다시 접힌다 — 이 상태는 지금 보는 채널에 대한 것이라 들고 다닐 뜻이 없다.
   */
  const [pinsOpen, setPinsOpen] = useState(false);
  /**
   * 문서 패널(#188)도 채널을 옮기면 닫는다 — 열린 채로 두면 방금 떠난 채널의 문서가 잠깐
   * 남아 어느 채널의 전제인지 오해할 여지가 생긴다(파일 패널과 같은 이유다).
   */
  const [docOpen, setDocOpen] = useState(false);
  useEffect(() => { setPinsOpen(false); setDocOpen(false); }, [activeChannelId]);

  const channel = channels.find((c) => c.id === activeChannelId);
  const dm = dms.find((d) => d.id === activeChannelId);
  const title = channel
    ? `# ${channel.name}`
    : dm
      ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
      : null;
  // DM은 채널이 아니다 — '#'을 붙이면 존재하지 않는 채널 이름을 가리키게 된다.
  const composerTarget = channel ? `#${channel.name}` : (title ?? '');

  /**
   * #368: 이 채널에서 **부른** 에이전트의 러너가 기동에 실패했으면 그 사유를 여기, 부른
   * 자리에 그린다. 사유 문구는 러너 실행기가 상태에 실어 준 `state.message` 를 그대로
   * 지나보낸다 — 화면이 문구를 새로 쓰면 설정 화면의 것과 갈라져 한쪽만 고치는 사고가
   * 난다(`runnerLauncher.ts` 가 유일한 출처다).
   *
   * **'불렀다'의 판정은 채널 설정이 아니라 실제 본문이다.** 자동 멘션 설정
   * (`channelAutoMentions`, #173)만 보면 이슈가 적은 재현 — 일반 채널에서 사람이 손으로
   * `@forge` 를 치는 경우 — 가 통째로 빠진다. 그 설정은 "이 채널이 누구를 자동으로 부르나"
   * 이지 "방금 누가 불렸나"가 아니다. 자동 멘션은 작성창이 보낼 때 본문 앞에 멘션을 실제로
   * 붙이므로(`Composer.tsx::autoActive` → `withStickyMentions`), 본문만 보면 손으로 친 것과
   * 자동으로 붙은 것이 **둘 다** 잡힌다.
   *
   * id 토큰(`<@uuid>`)과 평문 `@handle` 을 모두 보는 이유: 정규화는 보내는 쪽에 계정 지도가
   * 있을 때만 일어나고(`normalizeMentions` 는 지도가 비면 본문을 그대로 돌려준다), 없으면
   * 평문이 그대로 저장된다. 한쪽만 보면 그 경로에서 조용히 안 뜬다.
   *
   * DM 은 멘션이 없어도 부른 것으로 친다 — 상대가 그 에이전트뿐이라 보낸 글은 전부 그
   * 에이전트에게 간 것이다.
   */
  const runnerFailureInChannel = useMemo(() => {
    if (!activeChannelId) return null;
    const agentIdByHandle = new Map<string, string>();
    for (const a of Object.values(accounts)) {
      if (a.kind === 'agent') agentIdByHandle.set(a.handle.toLowerCase(), a.id);
    }
    const called = new Set<string>();
    if (dm) {
      for (const memberId of dm.memberIds) {
        if (accounts[memberId]?.kind === 'agent') called.add(memberId);
      }
    }
    for (const m of messages[activeChannelId] ?? []) {
      for (const id of mentionedIds(m.body)) {
        if (accounts[id]?.kind === 'agent') called.add(id);
      }
      for (const handle of mentionedHandles(m.body)) {
        const id = agentIdByHandle.get(handle);
        if (id) called.add(id);
      }
    }
    for (const agentId of called) {
      const state = runnerStates[agentId];
      // failed 일 때만이다. 정상인 러너의 상태를 늘 띄우면 그것은 안내가 아니라 소음이고,
      // 소음이 되면 진짜 실패도 같이 안 읽힌다.
      if (state?.status === 'failed') return { agentId, state };
    }
    return null;
  }, [activeChannelId, dm, accounts, messages, runnerStates]);

  const roots = useMemo(
    () => (activeChannelId ? (messages[activeChannelId] ?? []).filter((m) => m.threadRootId === null || m.alsoInChannel) : []),
    [messages, activeChannelId],
  );

  /**
   * 구분선을 그릴 메시지. **채널을 열 때 얼려 둔 위치**(`dividerSeq`)를 쓴다 — 라이브 읽음
   * 상태를 쓰면 열자마자 읽음 처리가 돌아 선이 즉시 사라진다. 내가 쓴 메시지는 기준에서
   * 빼는데, 자기 발화 위에 "안 읽음"이 뜨면 무의미하기 때문이다.
   */
  const dividerBeforeId = useMemo(() => {
    if (!activeChannelId) return null;
    const frozen = dividerSeq[activeChannelId] ?? 0;
    return roots.find((m) => m.seq > frozen && m.authorId !== me?.id)?.id ?? null;
  }, [roots, dividerSeq, activeChannelId, me?.id]);

  useEffect(() => { bottomRef.current?.scrollIntoView?.(); }, [roots.length]);

  // 채널을 옮기면 파일 패널을 닫는다. 열린 채로 두면 방금 떠난 채널의 목록이 잠깐 남아
  // 어느 채널의 파일인지 오해할 여지가 생긴다.
  useEffect(() => { setFilesOpen(false); }, [activeChannelId]);

  if (!activeChannelId) {
    return <main className="flex flex-1 items-center justify-center text-fg-muted">Pick a channel to start</main>;
  }

  const isArchived = channel?.archivedAt != null;
  const channelPins = pins[activeChannelId] ?? [];

  return (
    <div className="flex min-w-0 flex-1">
    <main className="flex min-w-0 flex-1 flex-col bg-surface-raised">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-bold">{title}</span>
        {channel?.topic && <span className="truncate text-xs text-fg-subtle">{channel.topic}</span>}
        {channel?.repo && <span className="rounded bg-surface-sunken px-1.5 text-[11px] text-fg-muted">{channel.repo}</span>}
        {isArchived && <span className="rounded bg-surface-hover px-1.5 text-[11px] text-fg-muted">보관됨</span>}
        {/* 문서는 채널에 붙는다(#188) — DM 에는 없다. `channel` 이 없을 때 버튼을 그리면
            눌러도 아무 일이 없는 죽은 버튼이 된다(패널 쪽 조건과 같은 조건이어야 한다). */}
        {channel && (
          <button
            className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-sunken"
            aria-expanded={docOpen}
            onClick={() => setDocOpen((v) => !v)}
          >
            문서
          </button>
        )}
        <button
          className={`${channel ? '' : 'ml-auto '}shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-sunken`}
          onClick={() => setFilesOpen((v) => !v)}
        >
          파일
        </button>
        {/* 검색은 ⌘K 로도 열리지만 단축키만으로는 보이지 않는다(#258). 헤더 버튼은
            **지금 보는 대화로 좁힌 채** 열고, ⌘K 는 전역으로 남는다 — 두 진입점이 서로
            다른 뜻을 가지므로 title 에 그 차이를 적는다. DM 에도 같은 버튼이 나온다. */}
        <button
          className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:bg-surface-sunken"
          onClick={() => onOpenSearch?.(true)}
          aria-label="이 채널에서 찾기"
          title="이 채널에서 찾기 (⌘K 는 전체 검색)"
        >
          검색
        </button>
      </header>
      {/* 고정된 메시지(#218). 핀이 하나도 없으면 아무것도 그리지 않는다 — 늘 있는 빈 줄은
          "여기에 뭔가 있다"는 거짓 신호이고, 헤더 아래 세로 공간을 그냥 먹는다. */}
      {channelPins.length > 0 && (
        <div className="border-b border-border bg-surface">
          <button
            className="flex w-full items-center gap-1 px-4 py-1 text-left text-[11px] text-fg-muted"
            aria-expanded={pinsOpen}
            onClick={() => setPinsOpen((v) => !v)}
          >
            <span aria-hidden="true">{pinsOpen ? '▾' : '▸'}</span>
            <span>{channelPins.length} pinned</span>
          </button>
          {pinsOpen && (
            <ul className="pb-1">
              {channelPins.map((p) => (
                <li key={p.messageId}>
                  {/* 누르면 그 메시지로 간다. `openMessage` 를 쓰는 이유: 답글이면 스레드
                      패널까지 열고 강조를 거는 일이 이미 거기 한 곳에 있다(#178). */}
                  <button
                    className="flex w-full gap-2 px-6 py-0.5 text-left text-[12px] text-fg hover:bg-surface-sunken"
                    onClick={() => void getController().openMessage(p.messageId)}
                  >
                    <span className="shrink-0 font-semibold">{accounts[p.message.authorId]?.handle ?? '…'}</span>
                    {/* 본문은 한 줄만 미리 보여 준다 — 목록이 대화를 두 번 그리는 자리가 되면
                        접어 둔 이유가 사라진다. 첨부만 있는 메시지는 본문이 빈 문자열이라
                        그대로 두면 누를 곳이 handle 뿐인 줄이 된다.
                        `displayBody` 를 지나는 이유(#329): 시스템 메시지는 본문에 이름이 없고
                        자리표시자만 있어, 원본을 그대로 쓰면 이 줄에만 그 글자가 남는다. */}
                    <span className="truncate">{displayBody(p.message, accounts).trim().split('\n')[0] || '(attachment)'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-2">
        {activeChannelId && hasMore[activeChannelId] && (
          // 서버 히스토리 창(최신 N개) 밖으로 밀려난 대화로 돌아가는 유일한 경로다.
          <div className="px-4 py-2 text-center">
            <button
              className="rounded border border-border px-2 py-1 text-[11px] text-fg-muted"
              onClick={() => void getController().loadOlder()}
            >
              Load older messages
            </button>
          </div>
        )}
        {/*
          빈 상태는 **메시지가 없을 때만**이다. `hasMore` 가 참이면 과거가 서버에 더 있고 아직
          안 받아온 것뿐이라, 그때 "아직 메시지가 없다"를 그리면 거짓말이 된다(#234).
        */}
        {roots.length === 0 && !hasMore[activeChannelId] && (
          <ChannelEmptyState channel={channel} isArchived={isArchived} />
        )}
        {roots.map((m, i) => {
          // 앞 메시지와 로컬 날짜가 다르면 새 날이다. 목록의 첫 메시지도 새 날로 친다 —
          // 그 채널의 첫 날도 날이고, 여기에 선이 없으면 위쪽 메시지들의 날짜를 알 길이 없다.
          const prev = roots[i - 1];
          const newDay = !prev || localDayKey(prev.createdAt) !== localDayKey(m.createdAt);
          return (
            <Fragment key={m.id}>
              {/*
                날짜 구분선과 "New messages" 구분선은 **한 지점에 둘 다 걸릴 수 있고, 그때 둘 다 그린다**.
                하나를 감추면 "여기부터 새 날"과 "여기부터 안 읽음"이라는 서로 다른 두 사실 중
                하나가 사라진다. 날짜를 먼저 두는 것은 읽는 순서다 — 날이 바뀌고, 그 안에서 안 읽음이 시작된다.
              */}
              {newDay && (
                <div className="flex items-center gap-2 px-4 py-1" role="separator">
                  <span className="h-px flex-1 bg-surface-hover" />
                  <span className="text-[11px] font-medium text-fg-subtle">{dayLabel(m.createdAt)}</span>
                  <span className="h-px flex-1 bg-surface-hover" />
                </div>
              )}
              {m.id === dividerBeforeId && (
                <div className="flex items-center gap-2 px-4 py-1" role="separator">
                  <span className="h-px flex-1 bg-danger-border" />
                  <span className="text-[11px] font-medium text-danger">New messages</span>
                  <span className="h-px flex-1 bg-danger-border" />
                </div>
              )}
              <MessageItem message={m} onOpenDirectory={onOpenDirectory} onOpenSettings={onOpenSettings} />
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <TypingLine />
      {/* #368: 부른 에이전트의 러너가 안 떴다는 사실은 **부른 자리 바로 위**에 둔다. 헤더에
          두면 답을 기다리며 보는 곳(작성창 위)에서 눈이 닿지 않는다 — 이슈가 적은 실패
          방식이 정확히 "보내고 기다리다 포기했다" 였다. `TypingLine`(누가 입력 중) 옆에
          서는 것도 같은 이유다: 둘 다 "지금 답이 오는 중인가"에 답하는 줄이다. */}
      {runnerFailureInChannel && (
        <div data-testid="channel-runner-failure" className="border-t border-danger-border bg-surface-sunken px-4 py-1.5">
          <span className="text-[11px] font-medium text-danger">
            @{accounts[runnerFailureInChannel.agentId]?.handle ?? '에이전트'} 는 지금 응답하지 않는다
          </span>
          <RunnerStatusLine state={runnerFailureInChannel.state} />
        </div>
      )}
      <div className="border-t border-border p-3">
        {isArchived ? (
          <div className="rounded bg-surface-sunken p-2 text-center text-sm text-fg-subtle">
            보관된 채널이다
          </div>
        ) : (
          <Composer
            scopeKey={activeChannelId}
            channelId={activeChannelId}
            // 같은 값을 두 번 넘긴다 — 뜻이 둘이라서다(Composer 의 prop 주석): 여기는
            // 채널에 직접 올리는 자리라 예약도 되고 자동 멘션도 그 채널의 것을 본다.
            autoMentionChannelId={activeChannelId}
            placeholder={`Message ${composerTarget}`}
            // 채널을 **지금 렌더된 것으로 붙여 준다**(#223). 보냄 취소 창이 도는 동안
            // 채널을 옮겨도 이 클로저가 든 채널로 나간다 — 컨트롤러가 스토어를 다시 읽으면
            // 옮긴 채널로 새어 나간다.
            onSend={(body, attachmentIds) => getController().send(body, attachmentIds, activeChannelId)}
          />
        )}
      </div>
    </main>
    {/* `activeChannelId` 는 위에서 이미 이른 반환으로 걸러졌다 — 여기서 또 보면
        "널일 수도 있다" 는 거짓 신호가 남는다. */}
    {filesOpen && (
      <ChannelFiles key={activeChannelId} channelId={activeChannelId} onClose={() => setFilesOpen(false)} />
    )}
    {docOpen && channel && (
      <ChannelDocPanel
        key={activeChannelId}
        channelId={activeChannelId}
        onClose={() => setDocOpen(false)}
        // 채널 문서의 본문도 멘션을 담는다(#279) — 여기서 신호를 끊으면 같은 `@handle` 이
        // 대화에서는 눌리고 문서에서는 안 눌린다.
        onOpenDirectory={onOpenDirectory}
        onOpenSettings={onOpenSettings}
      />
    )}
    </div>
  );
}
