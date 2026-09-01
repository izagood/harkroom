import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

export function MessageItem({ message, inThread = false }: { message: MessageRow; inThread?: boolean }) {
  const author = useAppStore((s) => s.accounts[message.authorId]);
  // 스토어는 스레드 답글까지 들고 있다(ChannelPane이 표시 단계에서 거를 뿐). 그래서 답글 수는
  // 서버 필드 없이 여기서 셀 수 있다. 한계: 히스토리 창 밖의 오래된 답글은 세지 않는다.
  const replyCount = useAppStore(
    (s) => (s.messages[message.channelId] ?? []).filter((m) => m.threadRootId === message.id).length,
  );
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
          // 답글이 달린 메시지는 호버 없이도 그 사실이 보여야 한다. 답글이 없을 때만 호버로
          // 드러나되, visibility가 아니라 opacity로 숨긴다 — visibility:hidden은 접근성
          // 트리에서 요소를 제거해 키보드·스크린리더가 스레드에 도달할 길을 없앤다.
          className={`self-start rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600 ${
            replyCount > 0
              ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
              : 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
          }`}
          onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
        >
          {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
        </button>
      )}
    </div>
  );
}
