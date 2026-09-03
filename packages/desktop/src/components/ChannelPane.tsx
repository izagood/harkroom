import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { TypingLine } from './TypingLine';
import { ChannelEmptyState } from './ChannelEmptyState';
import { dayLabel, localDayKey } from '../lib/day';

export function ChannelPane() {
  const { activeChannelId, channels, dms, accounts, me, messages, hasMore, dividerSeq, pins } = useAppStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  /**
   * 고정 목록은 **접힌 채로 시작한다**(#218). 핀은 "필요할 때 찾아가는 자리"이지 늘 읽는
   * 것이 아니고, 펼친 채로 두면 핀이 몇 개만 쌓여도 대화가 화면 아래로 밀린다.
   * 채널을 옮기면 다시 접힌다 — 이 상태는 지금 보는 채널에 대한 것이라 들고 다닐 뜻이 없다.
   */
  const [pinsOpen, setPinsOpen] = useState(false);
  useEffect(() => { setPinsOpen(false); }, [activeChannelId]);

  const channel = channels.find((c) => c.id === activeChannelId);
  const dm = dms.find((d) => d.id === activeChannelId);
  const title = channel
    ? `# ${channel.name}`
    : dm
      ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
      : null;
  // DM은 채널이 아니다 — '#'을 붙이면 존재하지 않는 채널 이름을 가리키게 된다.
  const composerTarget = channel ? `#${channel.name}` : (title ?? '');

  const roots = useMemo(
    () => (activeChannelId ? (messages[activeChannelId] ?? []).filter((m) => m.threadRootId === null) : []),
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

  if (!activeChannelId) {
    return <main className="flex flex-1 items-center justify-center text-zinc-400">Pick a channel to start</main>;
  }

  const isArchived = channel?.archivedAt != null;
  const channelPins = pins[activeChannelId] ?? [];

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
        <span className="font-bold">{title}</span>
        {channel?.topic && <span className="truncate text-xs text-zinc-500">{channel.topic}</span>}
        {channel?.repo && <span className="rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-600">{channel.repo}</span>}
        {isArchived && <span className="rounded bg-zinc-200 px-1.5 text-[11px] text-zinc-600">보관됨</span>}
      </header>
      {/* 고정된 메시지(#218). 핀이 하나도 없으면 아무것도 그리지 않는다 — 늘 있는 빈 줄은
          "여기에 뭔가 있다"는 거짓 신호이고, 헤더 아래 세로 공간을 그냥 먹는다. */}
      {channelPins.length > 0 && (
        <div className="border-b border-zinc-200 bg-zinc-50">
          <button
            className="flex w-full items-center gap-1 px-4 py-1 text-left text-[11px] text-zinc-600"
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
                    className="flex w-full gap-2 px-6 py-0.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-100"
                    onClick={() => void getController().openMessage(p.messageId)}
                  >
                    <span className="shrink-0 font-semibold">{accounts[p.message.authorId]?.handle ?? '…'}</span>
                    {/* 본문은 한 줄만 미리 보여 준다 — 목록이 대화를 두 번 그리는 자리가 되면
                        접어 둔 이유가 사라진다. 첨부만 있는 메시지는 본문이 빈 문자열이라
                        그대로 두면 누를 곳이 handle 뿐인 줄이 된다. */}
                    <span className="truncate">{p.message.body.trim().split('\n')[0] || '(attachment)'}</span>
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
              className="rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600"
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
                  <span className="h-px flex-1 bg-zinc-200" />
                  <span className="text-[11px] font-medium text-zinc-500">{dayLabel(m.createdAt)}</span>
                  <span className="h-px flex-1 bg-zinc-200" />
                </div>
              )}
              {m.id === dividerBeforeId && (
                <div className="flex items-center gap-2 px-4 py-1" role="separator">
                  <span className="h-px flex-1 bg-red-300" />
                  <span className="text-[11px] font-medium text-red-500">New messages</span>
                  <span className="h-px flex-1 bg-red-300" />
                </div>
              )}
              <MessageItem message={m} />
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <TypingLine />
      <div className="border-t border-zinc-200 p-3">
        {isArchived ? (
          <div className="rounded bg-zinc-100 p-2 text-center text-sm text-zinc-500">
            보관된 채널이다
          </div>
        ) : (
          <Composer
            scopeKey={activeChannelId}
            placeholder={`Message ${composerTarget}`}
            onSend={(body, attachmentIds) => getController().send(body, attachmentIds)}
          />
        )}
      </div>
    </main>
  );
}
