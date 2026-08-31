import { useMemo, useState } from 'react';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageItem } from './MessageItem';

export function ThreadPanel() {
  const { activeChannelId, threadRootId, messages } = useAppStore();
  const [draft, setDraft] = useState('');

  const thread = useMemo(() => {
    if (!activeChannelId || !threadRootId) return [];
    return (messages[activeChannelId] ?? [])
      .filter((m) => m.id === threadRootId || m.threadRootId === threadRootId)
      .sort((a, b) => a.seq - b.seq);
  }, [messages, activeChannelId, threadRootId]);

  if (!threadRootId) return null;

  const send = () => {
    const body = draft;
    if (!body.trim()) return;
    setDraft('');
    void getController().reply(body).catch(() => setDraft(body));
  };

  return (
    <section className="flex w-96 flex-col border-l border-zinc-200 bg-white">
      <header className="flex items-center border-b border-zinc-200 px-4 py-2">
        <span className="font-bold">Thread</span>
        <button className="ml-auto rounded px-2 text-zinc-500 hover:bg-zinc-100"
          onClick={() => getController().closeThread()}>
          ×
        </button>
      </header>
      <div className="flex-1 overflow-y-auto py-2">
        {thread.map((m) => <MessageItem key={m.id} message={m} inThread />)}
      </div>
      <div className="border-t border-zinc-200 p-3">
        <textarea
          className="w-full resize-none rounded border border-zinc-300 px-3 py-2"
          rows={2}
          placeholder="Reply…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
      </div>
    </section>
  );
}
