import { useState, useId } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageBody } from './MessageBody';
import { Reactions } from './Reactions';
import { Attachments } from './Attachments';
import { Menu } from './Menu';

function ReactionsToolbar({ message }: { message: MessageRow }) {
  const [picking, setPicking] = useState(false);
  const myId = useAppStore((s) => s.me?.id ?? null);

  const toggle = (emoji: string, on: boolean) => {
    setPicking(false);
    void getController().toggleReaction(message.channelId, message.id, emoji, on).catch(() => {});
  };

  const QUICK = ['👀', '💬', '👍', '🎉', '✅', '🔥', '🤔', '😄'];

  if (picking) {
    return (
      <div className="flex items-center gap-0.5 rounded-full border border-zinc-300 bg-white px-1 shadow-sm">
        {QUICK.map((e) => (
          <button
            key={e}
            aria-label={e}
            className="rounded px-1 hover:bg-zinc-100"
            onClick={() => toggle(e, !message.reactions.find((r) => r.emoji === e)?.accountIds.includes(myId ?? ''))}
          >
            {e}
          </button>
        ))}
        <button
          aria-label="Close reaction picker"
          className="rounded px-1 text-[11px] text-zinc-400 hover:bg-zinc-100"
          onClick={() => setPicking(false)}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <button
      aria-label="Add reaction"
      className="rounded-full border border-zinc-200 px-1.5 text-[11px] text-zinc-500 hover:bg-zinc-100"
      onClick={() => setPicking(true)}
    >
      ＋
    </button>
  );
}

export function MessageItem({ message, inThread = false }: { message: MessageRow; inThread?: boolean }) {
  const author = useAppStore((s) => s.accounts[message.authorId]);
  const isMine = useAppStore((s) => s.me?.id === message.authorId);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  // 스토어는 스레드 답글까지 들고 있다(ChannelPane이 표시 단계에서 거를 뿐). 그래서 답글 수는
  // 서버 필드 없이 여기서 셀 수 있다. 한계: 히스토리 창 밖의 오래된 답글은 세지 않는다.
  const replyCount = useAppStore(
    (s) => (s.messages[message.channelId] ?? []).filter((m) => m.threadRootId === message.id).length,
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isSystem = message.kind === 'system';
  const avcsType = typeof message.meta.avcsType === 'string' ? message.meta.avcsType : null;
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // system 메시지는 avcs 투영의 산물이라 사람이 고칠 수 없다 — 서버도 거절한다.
  const canEdit = isMine && !isSystem;
  // 삭제는 작성자 또는 admin — 서버가 그렇게 허용한다. UI가 작성자만 내주면 잘못 올라간
  // 비밀·스팸을 치울 경로가 admin 에게 없어, 서버가 열어 둔 조정 수단이 도달 불가가 된다.
  // 수정은 admin 에게도 열지 않는다: 남의 발언을 고칠 수 있으면 기록이 증거가 못 된다.
  const canDelete = (isMine || isAdmin) && !isSystem;

  const save = () => {
    const next = draft ?? '';
    setDraft(null);
    if (next.trim() && next !== message.body) void getController().editMessage(message.id, next);
  };

  const hoverOnly = 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100';
  const iconBtn = 'rounded p-1 text-zinc-500 hover:bg-zinc-100';

  const menuItems = [
    ...(canEdit ? [{ label: 'Edit', onSelect: () => setDraft(message.body) }] : []),
    ...(canDelete && !confirmingDelete ? [{ label: 'Delete', onSelect: () => setConfirmingDelete(true) }] : []),
  ];

  return (
    <div className={`group relative flex gap-2 px-4 py-1.5 hover:bg-zinc-50 ${isSystem ? 'border-l-2 border-amber-400 bg-amber-50/50' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{author?.handle ?? '…'}</span>
          {author?.kind === 'agent' && <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">agent</span>}
          {avcsType && <span className="rounded bg-amber-200 px-1 text-[10px] text-amber-900">{avcsType}</span>}
          <span className="text-[11px] text-zinc-400">{time}</span>
          {message.editedAt && <span className="text-[11px] text-zinc-400">(edited)</span>}
        </div>

        {draft === null ? (
          <>
            {message.body.trim() && <MessageBody body={message.body} />}
            <Attachments attachments={message.attachments} />
            <Reactions message={message} />
          </>
        ) : (
          <div className="space-y-1">
            <textarea
              className="w-full resize-none rounded border border-zinc-300 px-2 py-1"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                if (e.key === 'Escape') setDraft(null);
              }}
            />
            <div className="flex gap-1">
              <button className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600" onClick={save}>Save</button>
              <button className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {!inThread && (
        <button
          className={`absolute right-4 top-1 self-start rounded border border-zinc-300 px-1.5 text-[11px] ${
            replyCount > 0
              ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
              : `border-zinc-300 text-zinc-600 ${hoverOnly}`
          }`}
          onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
        >
          {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
        </button>
      )}

      {draft === null && (
        <div role="group" aria-label="message toolbar" className={`absolute right-4 top-6 flex items-center gap-0.5 ${hoverOnly}`}>
          <ReactionsToolbar message={message} />
          {!isSystem && (
            confirmingDelete ? (
              <>
                <button
                  className="rounded border border-red-300 bg-red-50 px-1.5 text-[11px] text-red-700"
                  onClick={() => { setConfirmingDelete(false); void getController().deleteMessage(message.id); }}
                >
                  Really delete
                </button>
                <button className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600" onClick={() => setConfirmingDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <Menu
                renderTrigger={(props) => (
                  <button
                    {...props}
                    className={iconBtn}
                    aria-label="More actions"
                  >
                    ⋯
                  </button>
                )}
                items={menuItems}
                placement="bottom"
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
