import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

export function MessageItem({ message, inThread = false }: { message: MessageRow; inThread?: boolean }) {
  const author = useAppStore((s) => s.accounts[message.authorId]);
  const me = useAppStore((s) => s.me);
  // 스토어는 스레드 답글까지 들고 있다(ChannelPane이 표시 단계에서 거를 뿐). 그래서 답글 수는
  // 서버 필드 없이 여기서 셀 수 있다. 한계: 히스토리 창 밖의 오래된 답글은 세지 않는다.
  const replyCount = useAppStore(
    (s) => (s.messages[message.channelId] ?? []).filter((m) => m.threadRootId === message.id).length,
  );
  const [draft, setDraft] = useState<string | null>(null); // null이면 편집 중이 아니다
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isSystem = message.kind === 'system';
  const isMine = me?.id === message.authorId;
  // 수정은 작성자만 — admin 도 예외가 아니다(남의 발언을 고칠 수 있으면 기록이 증거가 못 된다).
  // 삭제는 작성자 또는 admin — 내용을 바꾸는 게 아니라 치우는 것이고, 잘못 올라간 비밀·스팸을
  // 치울 사람이 워크스페이스에 있어야 한다. 서버가 같은 규칙을 강제하므로, 여기서 더 내주면
  // 눌러도 403이 나는 죽은 버튼이 된다.
  const canEdit = isMine && !isSystem;
  const canDelete = !isSystem && (isMine || me?.isAdmin === true);

  const avcsType = typeof message.meta.avcsType === 'string' ? message.meta.avcsType : null;
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const submitEdit = (): void => {
    const next = (draft ?? '').trim();
    setDraft(null);
    if (next && next !== message.body) void getController().editMessage(message.id, next);
  };

  // 호버로만 나타나는 버튼은 키보드·스크린리더에게 없는 버튼이다. visibility가 아니라 opacity로
  // 숨기고, 그룹 안에서 포커스를 받으면 함께 드러난다(visibility:hidden은 접근성 트리에서 제거).
  const actionClass = 'rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600 '
    + 'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

  return (
    <div className={`group flex gap-2 px-4 py-1.5 hover:bg-zinc-50 ${isSystem ? 'border-l-2 border-amber-400 bg-amber-50/50' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{author?.handle ?? '…'}</span>
          {author?.kind === 'agent' && <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">agent</span>}
          {avcsType && <span className="rounded bg-amber-200 px-1 text-[10px] text-amber-900">{avcsType}</span>}
          <span className="text-[11px] text-zinc-400">{time}</span>
          {/* 본문이 바뀐 사실을 읽는 사람이 알 수 있어야 한다 — 조용히 고쳐지면 인용이 어긋난다. */}
          {message.editedAt && <span className="text-[11px] text-zinc-400">(edited)</span>}
        </div>
        {draft === null ? (
          <div className="whitespace-pre-wrap break-words">{message.body}</div>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submitEdit(); }}>
            <input
              autoFocus
              aria-label="Edit message"
              className="w-full rounded border border-indigo-300 px-2 py-1 outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // 편집 취소가 없으면 잘못 누른 편집에서 빠져나올 길이 마우스뿐이다.
              onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }}
            />
            <span className="text-[11px] text-zinc-400">Enter to save · Escape to cancel</span>
          </form>
        )}
      </div>
      <div className="flex shrink-0 gap-1 self-start">
        {!inThread && (
          <button
            // 답글이 달린 메시지는 호버 없이도 그 사실이 보여야 한다.
            className={replyCount > 0
              ? 'rounded border border-indigo-200 bg-indigo-50 px-1.5 text-[11px] text-indigo-700'
              : actionClass}
            onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
          >
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
          </button>
        )}
        {canEdit && draft === null && (
          <button className={actionClass} onClick={() => setDraft(message.body)}>Edit</button>
        )}
        {canDelete && !confirmingDelete && (
          <button className={actionClass} onClick={() => setConfirmingDelete(true)}>Delete</button>
        )}
        {/* 삭제는 되돌릴 수 없다 — 한 번의 오클릭으로 대화가 사라지면 안 된다. */}
        {canDelete && confirmingDelete && (
          <>
            <button
              className="rounded border border-red-300 bg-red-50 px-1.5 text-[11px] text-red-700"
              onClick={() => { setConfirmingDelete(false); void getController().deleteMessage(message.id); }}
            >
              Confirm delete
            </button>
            <button
              className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
