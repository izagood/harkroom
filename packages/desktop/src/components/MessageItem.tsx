import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

export function MessageItem({ message, inThread = false }: { message: MessageRow; inThread?: boolean }) {
  const author = useAppStore((s) => s.accounts[message.authorId]);
  const isSystem = message.kind === 'system';
  const avcsType = typeof message.meta.avcsType === 'string' ? message.meta.avcsType : null;
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`group flex gap-2 px-4 py-1.5 hover:bg-zinc-50 ${isSystem ? 'border-l-2 border-amber-400 bg-amber-50/50' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{author?.handle ?? '…'}</span>
          {author?.kind === 'agent' && <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">agent</span>}
          {avcsType && <span className="rounded bg-amber-200 px-1 text-[10px] text-amber-900">{avcsType}</span>}
          <span className="text-[11px] text-zinc-400">{time}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{message.body}</div>
      </div>
      {!inThread && (
        <button
          className="invisible self-start rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600 group-hover:visible"
          onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
        >
          Reply in thread
        </button>
      )}
    </div>
  );
}
