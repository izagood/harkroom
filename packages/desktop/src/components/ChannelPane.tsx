import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';

export function ChannelPane() {
  const { activeChannelId, channels, dms, accounts, me, messages } = useAppStore();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const channel = channels.find((c) => c.id === activeChannelId);
  const dm = dms.find((d) => d.id === activeChannelId);
  const title = channel
    ? `# ${channel.name}`
    : dm
      ? dm.memberIds.filter((id) => id !== me?.id).map((id) => accounts[id]?.handle ?? '…').join(', ')
      : null;
  const composerName = channel?.name ?? title ?? '';

  const roots = useMemo(
    () => (activeChannelId ? (messages[activeChannelId] ?? []).filter((m) => m.threadRootId === null) : []),
    [messages, activeChannelId],
  );

  useEffect(() => { bottomRef.current?.scrollIntoView?.(); }, [roots.length]);

  if (!activeChannelId) {
    return <main className="flex flex-1 items-center justify-center text-zinc-400">Pick a channel to start</main>;
  }

  const send = () => {
    const body = draft;
    setDraft('');
    if (body.trim()) void getController().send(body);
  };

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2">
        <span className="font-bold">{title}</span>
        {channel?.topic && <span className="truncate text-xs text-zinc-500">{channel.topic}</span>}
        {channel?.repo && <span className="rounded bg-zinc-100 px-1.5 text-[11px] text-zinc-600">{channel.repo}</span>}
      </header>
      <div className="flex-1 overflow-y-auto py-2">
        {roots.map((m) => <MessageItem key={m.id} message={m} />)}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-zinc-200 p-3">
        <textarea
          className="w-full resize-none rounded border border-zinc-300 px-3 py-2"
          rows={2}
          placeholder={`Message #${composerName}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
      </div>
    </main>
  );
}
