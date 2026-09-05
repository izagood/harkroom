import { useEffect, useRef, useState } from 'react';
import { messagePermalink, readAskMeta, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { AskCard } from './AskCard';
import { FailureCard } from './FailureCard';
import { ReportCard } from './ReportCard';
import { MessageBody } from './MessageBody';
import { ReactionPicker, Reactions, InlineReactionButtons } from './Reactions';
import { Identity, StatusMark } from './Identity';
import { TerminalChip } from './TerminalChip';
import { Attachments } from './Attachments';
import { Menu } from './Menu';
import { bodyAsHandles, displayBody } from '../lib/mention';
import type { SectionId } from './settings/sections';

export function MessageItem({ message, inThread = false, onOpenDirectory, onOpenSettings }: {
  message: MessageRow;
  inThread?: boolean;
  /** 멘션을 눌렀을 때 갈 곳(#279). 넘기지 않으면 멘션은 버튼이 아니다 — `MessageBody` 참고. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}) {
  const author = useActiveStore((s) => s.accounts[message.authorId]);
  const isMine = useActiveStore((s) => s.me?.id === message.authorId);
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 링크로 방금 온 메시지인가. **스토어의 화면 상태**를 보고 그린다 — 이 사실을 message 에
  // 넣으면 서버에서 온 데이터와 지금 화면의 사정이 한 값에 섞인다(#178).
  const highlighted = useActiveStore((s) => s.highlightedMessageId === message.id);
  const rowRef = useRef<HTMLDivElement>(null);

  // 강조만 하고 화면 밖에 두면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
  // jsdom 에는 scrollIntoView 가 없으므로 옵셔널 호출이다(ChannelPane 도 같은 이유로 그렇다).
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView?.(); }, [highlighted]);

  // 강조가 계속 남으면 같은 채널에서 진짜 강조가 필요한 순간에 신호가 죽는다(#397).
  // 몇 초 뒤에 자동으로 해제한다 — 사용자가 확인하고 있다는 신호다.
  useEffect(() => {
    if (!highlighted) return;
    const timeout = setTimeout(() => {
      const store = useActiveStore.getState();
      if (store.highlightedMessageId === message.id) {
        store.set({ highlightedMessageId: null });
      }
    }, 5000);
    return () => clearTimeout(timeout);
  }, [highlighted, message.id]);

  const isSystem = message.kind === 'system';
  /**
   * 그릴 본문(#329). 시스템 메시지는 본문에 이름이 없고 자리표시자만 있으므로,
   * `displayBody` 가 `meta.accountId` 로 지금의 handle 을 찾아 채운다 — 본문을 보여 주는
   * 네 자리가 **같은 함수**를 지난다(`lib/mention.ts` 주석 참고).
   *
   * **이름줄이 아니라 본문에 채운다.** 이름줄은 이 메시지를 **쓴 사람**의 자리이고, 바로
   * 옆의 아바타·배지·상태 표시(`Identity`·`StatusMark`·`TerminalChip`)가 전부 `author` 를
   * 그린다. 거기에 대상의 이름을 넣으면 admin 이 내보낸 메시지가 내보내진 사람의 말처럼
   * 보이고, 한 줄 안에서 이름과 아바타가 서로 다른 사람을 가리킨다.
   */
  const shownBody = displayBody(message, accounts);
  const avcsType = typeof message.meta.avcsType === 'string' ? message.meta.avcsType : null;
  /**
   * 스킬 제안 알림에서 승인 화면으로 가는 진입점(#311 요구 5).
   *
   * **본문 글자를 파싱하지 않는다** — 서버가 `meta.skillSlug` 로 표시한다. 알림 문구를
   * 정규식으로 더듬으면 문구를 한 글자 다듬는 순간 진입점이 조용히 사라진다.
   * 신호는 `#279` 의 `onOpenSettings(section, targetId)` 를 **재사용**한다(새 신호를
   * 만들지 않는다). 대상까지 넘기므로 설정이 그 스킬의 본문을 펼친 채로 열린다.
   */
  const skillSlug = isSystem && typeof message.meta.skillSlug === 'string'
    ? message.meta.skillSlug
    : null;
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
  /**
   * 이 메시지의 핀(#218). 핀은 **채널 전역 사실**이라 메시지 행이 아니라 채널별 목록에서
   * 찾는다 — `MessageRow` 에 넣으면 같은 사실이 두 곳에 생기고, 남이 고정했을 때 한쪽만
   * 갱신되는 갈라짐이 난다(리액션과 달리 핀은 델타 이벤트가 없다).
   */
  const pin = useActiveStore((s) => (s.pins[message.channelId] ?? []).find((p) => p.messageId === message.id));
  // 해제는 고정한 사람 또는 admin — 서버가 그렇게 판정한다. UI 가 더 넓게 내주면 누를 때마다
  // 403 이 돌아오고, 더 좁게 내주면 admin 의 조정 수단이 도달 불가가 된다.
  const canUnpin = pin !== undefined && (pin.pinnedBy === myId || isAdmin);
  // 보관된 채널은 읽기 전용이라 고정이 거절된다(서버의 `channelPostGate`).
  const isArchived = useActiveStore((s) => s.channels.find((c) => c.id === message.channelId)?.archivedAt != null);
  // #219: 담긴 상태는 **id 집합**(open+done 전부)으로 본다. 패널이 받아 온 한 탭의 행들로
  // 판단하면 '완료' 탭을 한 번 열어 본 뒤로 open 인 메시지가 담기지 않은 것으로 읽힌다.
  const savedIds = useActiveStore((s) => s.savedIds);
  const isSaved = savedIds.includes(message.id);

  const save = () => {
    const next = draft ?? '';
    setDraft(null);
    if (next.trim() && next !== message.body) void getController().editMessage(message.id, next);
  };

  const hoverOnly = 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100';
  const iconBtn = 'rounded p-1 text-fg-subtle hover:bg-surface-raised';

  /**
   * 클립보드에 담는다(#178). **실패를 조용히 삼키지 않는다** — 삼키면 사람은
   * 붙여넣기를 시도하고 나서야 안 됐다는 것을 알고, 그때는 어느 메시지였는지도 잊는다.
   * 실패 문구를 부르는 쪽이 정하는 이유는 손으로 복사할 길이 대상마다 다르기 때문이다(#179).
   */
  const copyToClipboard = async (text: string, ok: string, fail: string) => {
    try {
      // clipboard 자체가 없는 환경(비보안 컨텍스트)도 실패다 — 같은 자리에서 잡는다.
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      useActiveStore.getState().set({ notice: ok });
    } catch {
      useActiveStore.getState().set({ notice: fail });
    }
  };

  // 링크는 화면 어디에도 안 보인다 — 그래서 실패하면 링크 문자열 자체를 알림에 실어야
  // 손으로 복사할 길이 남는다.
  const copyLink = () => {
    const link = messagePermalink(message.id);
    return copyToClipboard(link, 'Link copied.', `Could not copy the link. Copy it by hand: ${link}`);
  };

  /**
   * 본문 복사(#179). 복사하는 것은 `MessageBody` 가 그린 형태가 아니다 — 링크·코드
   * 렌더를 지나지 않은 본문이다.
   *
   * **다만 멘션은 `@handle` 로 되돌린다**(#271). 이 주석은 원래 "원본 `body` 를 그대로
   * 복사한다"였고 근거는 "렌더 결과는 다시 붙여넣을 수 없다"였다. 정본이 `<@id>` 가 된
   * 뒤로 그 전제가 뒤집혔다: 다시 붙여넣을 수 없는 쪽이 `<@0f3c…>` 이고, 붙여넣으면
   * 서버가 그 사람을 다시 찾아 주는 쪽이 `@handle` 이다. 모르는 id 는 토큰으로 남으므로
   * (`bodyAsHandles`) 원문으로 되돌릴 길도 사라지지 않는다.
   *
   * 실패 문구에 본문을 싣지 않는다 — 본문은 이미 화면에 그려져 있어 손으로 고를 수 있고,
   * 긴 메시지를 알림에 통째로 밀어 넣으면 알림이 화면을 덮는다.
   */
  const copyBody = () =>
    copyToClipboard(bodyAsHandles(message.body, accounts), 'Message copied.', 'Could not copy the message. Select it in the message and copy by hand.');

  const menuItems = [
    // 어떤 메시지든 가리킬 수 있다 — 남의 것도, system 메시지도 링크의 대상이다.
    { label: 'Copy link', onSelect: () => { void copyLink(); } },
    // 복사는 **권한 게이트가 없다**(#179) — 읽을 수 있으면 이미 본문을 눈으로 옮길 수 있다.
    // Edit·Delete 와 성격이 다르니 그 둘의 조건을 따라가지 않는다.
    { label: 'Copy text', onSelect: () => { void copyBody(); } },
    /**
     * 여기부터 안 읽음(#179). #154 의 `PUT /channels/:id/unread` 를 그대로 부른다.
     *
     * 보내는 것은 **이 메시지의 seq** 다. 다음 메시지의 seq 를 보내면 경계가 이 메시지
     * 뒤로 가서, 사람이 표시한 그 메시지가 읽은 것으로 남고 돌아왔을 때 보이지 않는다.
     *
     * 내가 쓴 메시지에는 만들지 않는다 — 미읽음 셈은 내 발화를 애초에 빼므로
     * (`readPositions.ts` 의 `author_id <> $1`) 눌러도 숫자가 그대로다. 아무 일도
     * 일어나지 않는 항목은 거짓 신호다(design.md §4).
     */
    ...(!isMine ? [{ label: 'Mark unread from here', onSelect: () => { void getController().markChannelUnread(message.channelId, message.seq); } }] : []),
    // 고정은 **글을 쓸 수 있는 사람 누구나** 한다(#218) — 그래서 작성자·admin 조건이 없다.
    // 보관된 채널에서만 뺀다: 서버가 거절하는 것을 메뉴에 남겨 두면 없는 것을 있다고
    // 표시하는 셈이다(design.md §4). 해제는 보관된 채널에서도 남는다 — 잘못 올라간 핀을
    // 치울 길이 있어야 한다(서버의 DELETE 도 보관을 보지 않는다).
    ...(!pin && !isArchived ? [{ label: 'Pin', onSelect: () => { void getController().pinMessage(message.channelId, message.id); } }] : []),
    ...(canUnpin ? [{ label: 'Unpin', onSelect: () => { void getController().unpinMessage(message.channelId, message.id); } }] : []),
    // #271: 수정창에는 `@handle` 을 채운다 — 저장된 정본은 `<@id>` 라, 그대로 넣으면
    // 사람이 `<@0f3c…>` 를 고치게 된다. 저장할 때 서버가 다시 정규화한다.
    ...(canEdit ? [{ label: 'Edit', onSelect: () => setDraft(bodyAsHandles(message.body, accounts)) }] : []),
    ...(canDelete && !confirmingDelete ? [{ label: 'Delete', onSelect: () => setConfirmingDelete(true) }] : []),
    // #219: 나중에 볼 것으로 담기. 담겨 있으면 문구가 해제로 바뀐다 — 같은 자리에 두 항목을
    // 나란히 두면 어느 것이 지금 상태인지 화면이 말하지 않는다.
    // 문구는 이 메뉴의 나머지(Pin·Edit·Delete…)와 같은 영문이다: 여기만 한국어로 두면
    // 한 메뉴 안에서 언어가 갈린다(#219 spec 은 UI 가 한국어라고 보고 "나중에 보기"를 적었다).
    ...(isSaved
      ? [{ label: 'Unsave', onSelect: () => { void getController().unsaveMessage(message.id); } }]
      : [{ label: 'Save for later', onSelect: () => { void getController().saveMessage(message.id); } }]),
  ];

  return (
    <div
      ref={rowRef}
      // 강조는 system 배경을 덮는다 — 둘 다 배경을 칠하면 어느 쪽이 이길지 클래스 문자열이
      // 정하지 못한다. 링크로 방금 왔다는 사실이 더 급한 정보다.
      className={`group relative flex gap-2 px-4 py-1.5 hover:bg-surface ${isSystem ? 'border-l-2 border-warning-border' : ''} ${highlighted ? 'bg-warning-surface-strong ring-1 ring-warning-border' : isSystem ? 'bg-warning-surface' : ''}`}
      data-highlighted={highlighted ? 'true' : undefined}
    >
      {/* 작성자 아바타 거터 - 메시지 행 왼쪽에 고정폭 열로 배치. #161 2단계.
          #254 이후 답글 컨트롤이 본문 열로 이동하고 툴바는 행 기준 right-2 top-1 에
          앵커한다. 거터 폭은 32px(h-8 w-8)로 하고, Identity 컴포넌트의 className 로
          크기를 조절한다. #277 에서 variant="avatar" 로 거터 자리를 명시한다 — 이 열은
          32px 고정이라 안에 든 것이 넓어지면 열을 넘친다(그것이 #277 의 결함이었다).
          `data-testid` 는 회귀 테스트가 이 열을 클래스 문자열로 더듬지 않게 하려고 둔다 —
          클래스로 찾으면 스타일을 조금 손보는 순간 테스트가 조용히 아무것도 안 지킨다. */}
      <div data-testid="author-gutter" className="flex h-8 w-8 shrink-0 items-center justify-center">
        <Identity account={author} className="h-8 w-8 text-sm" variant="avatar" />
      </div>
      {/*
        본문 최대폭(계획 Task 10 Step 4). 넓은 창에서 보고문이 한 줄 100자를 넘어 읽기가
        무너진다 — 읽히는 말(완료 보고)이 이 열에 살기 때문에 `ch` 로 상한을 둔다.
        `min-w-0` 은 그대로 둔다: 긴 코드·URL 이 flex 열을 밀어내는 것을 막는 것이 그 일이고,
        최대폭과는 다른 문제다.
      */}
      <div className="min-w-0 max-w-[70ch] flex-1">
        <div className="flex items-baseline gap-2">
          {/* `data-testid` 를 두는 이유는 위 `author-gutter` 와 같다: 이 자리가 **작성자**의
              것이라는 사실을 회귀선이 클래스 문자열로 더듬지 않게 한다. 아바타(`Identity`)도
              handle 을 sr-only 로 내보내므로 글자로 찾으면 두 곳이 걸려, 이름줄이 다른
              사람을 가리키게 되어도 테스트가 무엇을 봤는지 말하지 못한다(#329). */}
          <span data-testid="author-name" className="font-semibold">{author?.handle ?? '…'}</span>
          <Identity account={author} variant="badge" />
          {/* 작성 시점이 아니라 **지금**의 상태다 — 이 줄이 답하는 질문은 "이 사람에게
              지금 물어봐도 되는가"이지 "그때 무슨 상태였나"가 아니다(#186). */}
          <StatusMark account={author} />
          {/* 수신자 배지(규칙 04) — 이 말이 **누구에게 갔는지**. `→ 나` 만 강조색을 받고
              남에게 간 것은 무채색이다. 지금은 선택 요청만 수신자를 싣지만 배지 자체는
              되물음·실패도 쓸 것이므로 `AskCard` 밖(이름줄)에 둔다. */}
          <AudienceBadge message={message} />
          {/* #141: 진행 중인 터미널 진입점. 소유자·admin 이 아니면 렌더 자체가 없다
              (TerminalChip 이 판정한다) — 이름줄에 두는 이유는 소유자 배지와 같다:
              32px 거터에 넣으면 넘친다(#277). */}
          <TerminalChip account={author} message={message} />
          {avcsType && <span className="rounded bg-warning-surface-strong px-1 text-[10px] text-warning">{avcsType}</span>}
          <span className="text-[11px] text-fg-muted">{time}</span>
          {message.editedAt && <span className="text-[11px] text-fg-muted">(edited)</span>}
        </div>

        {draft === null ? (
          <>
            {shownBody.trim() && <MessageBody body={shownBody} messageId={message.id} onOpenDirectory={onOpenDirectory} onOpenSettings={onOpenSettings} />}
            {/* 선택지는 본문 **바로 아래**에 붙는다 — 답할 자리가 말 옆에 있어야 한다(규칙 05).
                형식을 못 알아보면 `AskCard` 가 스스로 아무것도 그리지 않는다. */}
            <AskCard message={message} />
            {/* 실패도 본문 바로 아래다 — 고치는 경로가 말 옆에 있어야 한다(규칙 05). */}
            <FailureCard message={message} inThread={inThread} />
            {/* 완료 보고 — 읽히는 말이므로 강조를 받지 않는다(규칙 03). */}
            <ReportCard message={message} inThread={inThread} />
            {skillSlug && onOpenSettings && (
              <button
                className="mt-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium
                           text-fg hover:bg-surface-hover"
                onClick={() => onOpenSettings('skills', skillSlug)}
              >
                스킬 승인 화면 열기
              </button>
            )}
            <Attachments attachments={message.attachments} />
            <Reactions message={message} />
            {/* #254: 답글이 **있을 때**의 상시 답글 요약(#424 로 상자를 벗긴 텍스트 링크)은
                **본문 열**에 둔다 — 리액션 칩 바로 뒤, 왼쪽 정렬. 우상단 열에는 툴바만 남으므로 `right-full`("내 우측 = 답글 컨트롤의
                좌측")은 가리킬 대상이 없어져 뜻을 잃는다. 그래서 툴바는 행 기준
                `right-2 top-1` 로 앵커한다. 이 답글 요약과 툴바가 **다른 컨테이너**에 있어
                구조적으로 겹칠 수 없으므로, #143 이 풀던 "호버 툴바가 답글 pill 을 덮어
                스레드 진입이 막힌다"는 더 이상 발생할 수 없다 — 앵커를 행으로 되돌려도
                마찬가지다. 이 사실을 적어 두는 이유는, **이 답글 요약을** 다시 오른쪽 열(툴바)로
                올리는 순간 #143 이 그대로 되살아나기 때문이다.
                (#396: 답글이 **없을 때**의 진입점은 애초에 호버에서만 보이는 툴바 아이콘이라
                조건이 툴바와 같다 — 같은 조건끼리는 서로 덮을 대상이 없으므로 이 경고는
                적용되지 않는다. 답글 요약은 여전히 절대 툴바로 올리지 않는다.) */}
            {!inThread && message.replyCount !== null && (
              <button
                // 답글이 달린 메시지는 호버 없이도 그 사실이 보여야 한다(#161). 답글이 없을
                // 때만 호버로 드러나되, visibility 가 아니라 opacity 로 숨긴다 —
                // visibility:hidden 은 접근성 트리에서 요소를 제거해 키보드·스크린리더가
                // 스레드에 도달할 길을 없앤다(Reactions.tsx 주석이 그 비용을 기록한다).
                //
                // **흐름 안에 둔다(absolute 로 띄우지 않는다)**: 이 버튼은 답글이 있으면
                // 상시 노출되므로, 절대 배치로 본문 위에 올리면 긴 한 줄 메시지를 가린다.
                //
                // #161 2단계: 서버의 replyCount 를 쓰고, 참여자 아바타와 마지막 답글 시각을
                // 보여준다. 참여자 얼굴은 장식이다 — 접근 가능한 이름은 버튼 하나에 붙는다.
                // 예: "51개의 답글, 마지막 답글 오후 8:24". 이미지가 각각 이름을 갖지
                // 않도록 opacity 로 숨기고 sr-only 텍스트도 주지 않는다.
                // #424: 상자(테두리+옅은 면)를 벗긴다 — 채널을 스크롤하면 답글이 달린 메시지마다
                // 파란 상자가 줄줄이 서서 본문보다 먼저 눈에 띄었다. Slack 처럼 참여자 얼굴 +
                // 강조색 텍스트 링크로만 두고, 면은 hover 에서만 옅게 깔아 클릭 대상임을 알린다.
                className="mt-0.5 self-start -mx-1 flex items-center gap-1.5 rounded px-1 py-0.5
                           text-[11px] hover:bg-surface-hover"
                onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
                aria-label={`${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}${lastReplyTime ? `, last reply ${lastReplyTime}` : ''}`}
              >
                {/* 참여자 아바타 — 최대 5개, 나머지는 +N 으로 접는다. 장식 용도라 스크린리더가
                    읽지 않도록 aria-hidden 처리하고 sr-only 도 안 준다. #277: variant="avatar" */}
                <span className="flex -space-x-1" aria-hidden="true">
                  {displayedParticipants.map((id) => (
                    <span key={id} className="ring-1 ring-surface">
                      <Identity account={accounts[id]} className="h-4 w-4 text-[8px]" variant="avatar" />
                    </span>
                  ))}
                  {remainingCount > 0 && (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-hover text-[8px] font-medium text-fg-muted ring-1 ring-surface">
                      +{remainingCount}
                    </span>
                  )}
                </span>
                <span className="font-medium text-accent">
                  {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
                </span>
                {lastReplyTime && <span className="text-fg-subtle">{lastReplyTime}</span>}
              </button>
            )}
            {/* #396: 답글이 없을 때는 본문 아래에 버튼을 두지 않는다 — 답글이 달린 뒤의
                답글 요약(위 블록)과 같은 자리에 서서 "아직 아무 일도 없는 메시지"가
                "뭔가 달린 메시지"처럼 보였다. 진입점은 호버 툴바의 아이콘으로 옮겼다
                (아래 우상단 열, message toolbar 안). */}
            {/* #231: alsoInChannel 메시지는 채널에도 보이므로 스레드에서 왔을 때가 아니라
                채널에서 볼 때 이 버튼이 필요하다. "View in thread" 로 표시한다. */}
            {!inThread && message.alsoInChannel && message.threadRootId && (
              <button
                // #424: 답글 요약과 같은 자리에 서는 링크이므로 상자도 함께 벗긴다 —
                // 한쪽만 상자면 두 진입점이 다른 종류처럼 보인다.
                className="mt-0.5 self-start -mx-1 rounded px-1 py-0.5 text-[11px] font-medium
                           text-accent hover:bg-surface-hover"
                onClick={() => void getController().openThread(message.threadRootId!)}
              >
                View in thread
              </button>
            )}
          </>
        ) : (
          <div className="space-y-1">
            <textarea
              className="w-full resize-none rounded border border-border bg-field px-2 py-1"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
                if (e.key === 'Escape') setDraft(null);
              }}
            />
            <div className="flex gap-1">
              <button className="rounded border border-border px-1.5 text-[11px] text-fg-muted" onClick={save}>Save</button>
              <button className="rounded border border-border px-1.5 text-[11px] text-fg-muted" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="relative flex shrink-0 items-start gap-1">
        {/* #121: 우상단 호버 툴바. #254 이후 답글 컨트롤이 본문 열로 이동해서 둘이 같은
            자리를 다투지 않으므로, 툴바는 행 기준 `right-2 top-1` 로 앵커한다.
            숨기는 방식은 반드시 opacity 다 — visibility:hidden 은 접근성 트리에서
            요소를 지워 키보드 경로를 없앤다(Reactions.tsx 주석이 그 비용을 기록한다). */}
        {draft === null && (
          <div role="group" aria-label="message toolbar" className={`absolute right-2 top-1 flex items-center gap-0.5 rounded border border-border bg-surface-raised px-1 py-0.5 shadow-sm ${hoverOnly}`}>
            <InlineReactionButtons message={message} />
            <ReactionPicker message={message} />
            {/* #396: 답글이 아직 없는 메시지(replyCount === null)의 스레드 진입점.
                답글이 달리면 본문 열의 답글 요약(위쪽, #161)이 상시 노출로 이 역할을 대신하므로
                그때는 여기 그리지 않는다 — 같은 진입을 두 곳에 두지 않는다. inThread 에서는
                스레드 안에서 또 스레드를 열 수 없으므로 아예 그리지 않는다(바깥 조건이 막는다).
                아이콘은 💬 를 쓰지 않는다 — 그건 에이전트 상태 신호 이모지라(#144,
                STATUS_SIGNAL_EMOJI) 사람이 누르는 버튼에 쓰면 신호의 뜻이 무너진다. */}
            {!inThread && message.replyCount === null && (
              <button
                className={iconBtn}
                title="스레드에 답글 달기"
                aria-label="스레드에 답글 달기"
                onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
              >
                ↩
              </button>
            )}
            {confirmingDelete ? (
              // 삭제는 되돌릴 수 없으니 한 번 더 묻는다. 확인은 **메뉴 밖**에 둔다 — 메뉴 안에
              // 두면 항목을 누르는 순간 메뉴가 닫히면서 확인 단계가 사라진다.
              <>
                <button
                  className="rounded border border-danger-border bg-danger-surface px-1.5 text-[11px] text-danger"
                  onClick={() => { setConfirmingDelete(false); void getController().deleteMessage(message.id); }}
                >
                  Really delete
                </button>
                <button
                  className="rounded border border-border px-1.5 text-[11px] text-fg-muted"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              // 항목이 하나도 없으면 트리거를 만들지 않는다 — 열어도 비어 있는 메뉴는
              // "할 수 있는 게 있다"는 거짓 신호다(design.md §4).
              //
              // #178 이후 이 조건은 **실제로는 거짓이 되지 않는다**: "Copy link" 는 어떤
              // 메시지에도 있으므로 목록이 비지 않는다. 그래도 남겨 둔다 — 항목이 다시
              // 전부 조건부가 되는 순간(예: 링크를 admin 에게만 여는 결정) 이 가드가
              // 없으면 빈 메뉴가 조용히 생긴다. 지금 지키는 것이 없다는 사실을 적어 두는
              // 이유는, 이 줄을 읽고 "여기서 걸러진다"고 믿는 사람이 없게 하기 위해서다.
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

/**
 * `→ 나` / `→ forge`. **강조는 나에게 온 것에만 간다**(규칙 04) — 이 배지 하나로 팀
 * 스레드의 "무엇이 내 일인가"가 풀린다.
 *
 * 이미 답이 있으면 그리지 않는다: 끝난 물음의 수신자는 더 이상 아무도 기다리게 하지 않고,
 * 남겨 두면 끝난 스레드가 계속 나를 부른다.
 */
function AudienceBadge({ message }: { message: MessageRow }) {
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  const ask = readAskMeta(message.meta);
  if (!ask || ask.answeredWith != null) return null;

  const forMe = ask.to.kind === 'human' ? myId != null : ask.to.accountId === myId;
  const label = forMe
    ? '\u2192 나'
    : `\u2192 ${ask.to.kind === 'account' ? (accounts[ask.to.accountId]?.handle ?? '다른 에이전트') : '사람'}`;
  return (
    <span
      data-testid="audience-badge"
      data-for-me={forMe}
      className={`rounded px-1 text-[10px] font-medium ${
        forMe ? 'bg-accent-surface text-state-turn' : 'text-fg-agent'
      }`}
    >
      {label}
    </span>
  );
}
