import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';

export function ChannelPane() {
  const { activeChannelId, channels, dms, accounts, me, messages, hasMore, dividerSeq } = useAppStore();
  const bottomRef = useRef<HTMLDivElement>(null);

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

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
        <span className="font-bold">{title}</span>
        {channel?.topic && <span className="truncate text-xs text-zinc-500">{channel.topic}</span>}
        {channel?.repo && <span className="rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-600">{channel.repo}</span>}
      </header>
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
        {roots.map((m) => (
          <Fragment key={m.id}>
            {m.id === dividerBeforeId && (
              <div className="flex items-center gap-2 px-4 py-1" role="separator">
                <span className="h-px flex-1 bg-red-300" />
                <span className="text-[11px] font-medium text-red-500">New messages</span>
                <span className="h-px flex-1 bg-red-300" />
              </div>
            )}
            <MessageItem message={m} />
          </Fragment>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-200 p-3">
        <Composer
          scopeKey={activeChannelId}
          placeholder={`Message ${composerTarget}`}
          onSend={(body) => getController().send(body)}
        />
      </div>
    </main>
  );
}
