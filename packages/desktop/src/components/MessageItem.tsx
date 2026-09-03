import { useEffect, useRef, useState } from 'react';
import { messagePermalink, type MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { MessageBody } from './MessageBody';
import { ReactionPicker, Reactions, InlineReactionButtons } from './Reactions';
import { Identity, StatusMark } from './Identity';
import { Attachments } from './Attachments';
import { Menu } from './Menu';

export function MessageItem({ message, inThread = false }: { message: MessageRow; inThread?: boolean }) {
  const author = useAppStore((s) => s.accounts[message.authorId]);
  const isMine = useAppStore((s) => s.me?.id === message.authorId);
  const isAdmin = useAppStore((s) => s.me?.isAdmin === true);
  const accounts = useAppStore((s) => s.accounts);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 링크로 방금 온 메시지인가. **스토어의 화면 상태**를 보고 그린다 — 이 사실을 message 에
  // 넣으면 서버에서 온 데이터와 지금 화면의 사정이 한 값에 섞인다(#178).
  const highlighted = useAppStore((s) => s.highlightedMessageId === message.id);
  const rowRef = useRef<HTMLDivElement>(null);

  // 강조만 하고 화면 밖에 두면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
  // jsdom 에는 scrollIntoView 가 없으므로 옵셔널 호출이다(ChannelPane 도 같은 이유로 그렇다).
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView?.(); }, [highlighted]);

  const isSystem = message.kind === 'system';
  const avcsType = typeof message.meta.avcsType === 'string' ? message.meta.avcsType : null;
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const lastReplyTime = message.lastReplyAt
    ? new Date(message.lastReplyAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const participantList = message.participantIds ?? [];
  const displayedParticipants = participantList.slice(0, 5);
  const remainingCount = participantList.length - 5;
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

  /**
   * 링크를 클립보드에 담는다(#178). **실패를 조용히 삼키지 않는다** — 삼키면 사람은
   * 붙여넣기를 시도하고 나서야 안 됐다는 것을 알고, 그때는 어느 메시지였는지도 잊는다.
   * 그래서 실패하면 링크 문자열 자체를 알림에 실어 손으로 복사할 길을 남긴다.
   */
  const copyLink = async () => {
    const link = messagePermalink(message.id);
    try {
      // clipboard 자체가 없는 환경(비보안 컨텍스트)도 실패다 — 같은 자리에서 잡는다.
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(link);
      useAppStore.getState().set({ notice: 'Link copied.' });
    } catch {
      useAppStore.getState().set({ notice: `Could not copy the link. Copy it by hand: ${link}` });
    }
  };

  const menuItems = [
    // 어떤 메시지든 가리킬 수 있다 — 남의 것도, system 메시지도 링크의 대상이다.
    { label: 'Copy link', onSelect: () => { void copyLink(); } },
    ...(canEdit ? [{ label: 'Edit', onSelect: () => setDraft(message.body) }] : []),
    ...(canDelete && !confirmingDelete ? [{ label: 'Delete', onSelect: () => setConfirmingDelete(true) }] : []),
  ];

  return (
    <div
      ref={rowRef}
      // 강조는 system 배경을 덮는다 — 둘 다 배경을 칠하면 어느 쪽이 이길지 클래스 문자열이
      // 정하지 못한다. 링크로 방금 왔다는 사실이 더 급한 정보다.
      className={`group relative flex gap-2 px-4 py-1.5 hover:bg-zinc-50 ${isSystem ? 'border-l-2 border-amber-400' : ''} ${highlighted ? 'bg-amber-100 ring-1 ring-amber-300' : isSystem ? 'bg-amber-50/50' : ''}`}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      {/* 작성자 아바타 거터 - 메시지 행 왼쪽에 고정폭 열로 배치. #161 2단계. 가로 예산:
          #143 호버 툴바가 right-full 로 왼쪽으로 자라고, #145 가 오른쪽에서 같은 예산을 쓴다.
          거터 폭은 32px(h-8 w-8)로 하고, Identity 컴포넌트의 className 로 크기를 조절한다. */}
      <div className="flex h-8 w-8 shrink-0 items-center justify-center">
        <Identity account={author} className="h-8 w-8 text-sm" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{author?.handle ?? '…'}</span>
          <Identity account={author} />
          {/* 작성 시점이 아니라 **지금**의 상태다 — 이 줄이 답하는 질문은 "이 사람에게
              지금 물어봐도 되는가"이지 "그때 무슨 상태였나"가 아니다(#186). */}
          <StatusMark account={author} />
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

      <div className="relative flex shrink-0 items-start gap-1">
        {!inThread && message.replyCount !== null && (
          <button
            // 답글이 달린 메시지는 호버 없이도 그 사실이 보여야 한다. 답글이 없을 때만 호버로
            // 드러나되, visibility 가 아니라 opacity 로 숨긴다 — visibility:hidden 은 접근성
            // 트리에서 요소를 제거해 키보드·스크린리더가 스레드에 도달할 길을 없앤다.
            //
            // **흐름 안에 둔다(absolute 로 띄우지 않는다)**: 이 버튼은 답글이 있으면 상시
            // 노출되므로, 절대 배치로 본문 위에 올리면 긴 한 줄 메시지를 가린다.
            //
            // #161 2단계: 서버의 replyCount 를 쓰고, 참여자 아바타와 마지막 답글 시각을 보여준다.
            // 참여자 얼굴은 장식이다 — 접근 가능한 이름은 버튼 하나에 붙는다.
            // 예: "51개의 답글, 마지막 답글 오후 8:24". 이미지가 각각 이름을 갖지 않도록
            // opacity 로 숨기고 sr-only 텍스트도 주지 않는다.
            className="self-start flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700"
            onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
            aria-label={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}${lastReplyTime ? `, last reply ${lastReplyTime}` : ''}`}
          >
            {/* 참여자 아바타 — 최대 5개, 나머지는 +N 으로 접는다. 장식 용도라 스크린리더가
                읽지 않도록 aria-hidden 처리하고 sr-only 도 안 준다. */}
            <span className="flex -space-x-1" aria-hidden="true">
              {displayedParticipants.map((id) => (
                <span key={id} className="ring-1 ring-white">
                  <Identity account={accounts[id]} className="h-4 w-4 text-[8px]" />
                </span>
              ))}
              {remainingCount > 0 && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-200 text-[8px] font-medium text-zinc-600 ring-1 ring-white">
                  +{remainingCount}
                </span>
              )}
            </span>
            <span>
              {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              {lastReplyTime && <span className="ml-1 text-zinc-500">{lastReplyTime}</span>}
            </span>
          </button>
        )}
        {!inThread && message.replyCount === null && (
          <button
            className={`self-start rounded border px-1.5 text-[11px] border-zinc-300 text-zinc-600 ${hoverOnly}`}
            onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
          >
            Reply in thread
          </button>
        )}
        {/* #121: 우상단 호버 툴바. #143: 기준을 **행이 아니라 답글 컨트롤**로 잡는다 —
            둘 다 행의 `right` 에 앵커되면 같은 자리를 다투고, 호버 시 툴바가 답글 pill 을
            덮어 스레드 진입이 막힌다. `right-full` 은 "내 우측 = 답글 컨트롤의 좌측"이라
            pill 텍스트 폭(`Reply in thread` ↔ `3 replies`)이 변해도 비겹침이 유지된다.
            흐름 밖에 남으므로 상시 여백을 예약하지도 않는다. 숨기는 방식은 반드시
            opacity 다 — visibility:hidden 은 접근성 트리에서 요소를 지워 키보드 경로를
            없앤다(Reactions.tsx 주석이 이미 그 비용을 기록한다). */}
        {draft === null && (
          <div role="group" aria-label="message toolbar" className={`absolute right-full top-0 mr-1 flex items-center gap-0.5 rounded border border-zinc-200 bg-white px-1 py-0.5 shadow-sm ${hoverOnly}`}>
            <InlineReactionButtons message={message} />
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
    </div>
  );
}
