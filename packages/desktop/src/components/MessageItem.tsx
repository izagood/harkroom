import { useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageBody } from './MessageBody';
import { ReactionPicker, Reactions } from './Reactions';
import { Attachments } from './Attachments';
import { Menu } from './Menu';

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

      <div className="flex shrink-0 items-start gap-1">
        {!inThread && (
          <button
            // 답글이 달린 메시지는 호버 없이도 그 사실이 보여야 한다. 답글이 없을 때만 호버로
            // 드러나되, visibility 가 아니라 opacity 로 숨긴다 — visibility:hidden 은 접근성
            // 트리에서 요소를 제거해 키보드·스크린리더가 스레드에 도달할 길을 없앤다.
            //
            // **흐름 안에 둔다(absolute 로 띄우지 않는다)**: 이 버튼은 답글이 있으면 상시
            // 노출되므로, 절대 배치로 본문 위에 올리면 긴 한 줄 메시지를 가린다.
            className={`self-start rounded border px-1.5 text-[11px] ${
              replyCount > 0
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                : `border-zinc-300 text-zinc-600 ${hoverOnly}`
            }`}
            onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
          >
            {replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply in thread'}
          </button>
        )}
      </div>

      {/* #121: 메시지 우상단에 앵커된 호버 툴바. 상시 노출되는 것이 없으므로 절대 배치로
          본문을 가리지 않는다(호버할 때만 나타난다). 숨기는 방식은 반드시 opacity 다 —
          visibility:hidden 은 접근성 트리에서 요소를 지워 키보드 경로를 없앤다
          (docs/roadmap.md §층1, Reactions.tsx 주석이 이미 그 비용을 기록한다). */}
      {draft === null && (
        <div role="group" aria-label="message toolbar" className={`absolute right-3 top-0 flex items-center gap-0.5 rounded border border-zinc-200 bg-white px-1 py-0.5 shadow-sm ${hoverOnly}`}>
          <ReactionPicker message={message} />
          {confirmingDelete ? (
            // 삭제는 되돌릴 수 없으니 한 번 더 묻는다. 확인은 **메뉴 밖**에 둔다 — 메뉴 안에
            // 두면 항목을 누르는 순간 메뉴가 닫히면서 확인 단계가 사라진다.
            <>
              <button
                className="rounded border border-red-300 bg-red-50 px-1.5 text-[11px] text-red-700"
                onClick={() => { setConfirmingDelete(false); void getController().deleteMessage(message.id); }}
              >
                Really delete
              </button>
              <button
                className="rounded border border-zinc-300 px-1.5 text-[11px] text-zinc-600"
                onClick={() => setConfirmingDelete(false)}
              >
                Keep
              </button>
            </>
          ) : (
            // 항목이 하나도 없으면 트리거를 만들지 않는다 — 열어도 비어 있는 메뉴는
            // "할 수 있는 게 있다"는 거짓 신호다(design.md §4).
            menuItems.length > 0 && (
              <Menu
                renderTrigger={(props) => (
                  <button {...props} className={iconBtn} aria-label="More actions">⋯</button>
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
