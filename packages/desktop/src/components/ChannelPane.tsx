import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';

export function ChannelPane() {
  const { activeChannelId, channels, dms, accounts, me, messages, hasMore } = useAppStore();
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
        {roots.map((m) => <MessageItem key={m.id} message={m} />)}
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
