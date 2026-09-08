import { useEffect, useMemo, useRef, useState } from 'react';
import { messagePermalink, readAskMeta, readModelMeta, type MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { AskCard } from './AskCard';
import { ThreadStateBadge } from './ThreadStateBadge';
import { threadStateFromFacts, isBlocking, threadStateLabel } from '../lib/threadState';
import { waitChainFromLinks, chainEnds } from '../lib/waitChain';
import { FailureCard } from './FailureCard';
import { ReportCard } from './ReportCard';
import { MessageBody } from './MessageBody';
import { ReactionPicker, Reactions, InlineReactionButtons } from './Reactions';
import { Identity, StatusMark } from './Identity';
import { TerminalChip } from './TerminalChip';
import { WakeRow } from './WakeRow';
import { NotifiedGapRow } from './NotifiedGapRow';
import { Attachments } from './Attachments';
import { Menu } from './Menu';
import { ConfirmDialog } from './ConfirmDialog';
import { bodyAsHandles, displayBody } from '../lib/mention';
import { accountOpen } from '../lib/accountOpen';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

/**
 * 얼굴 슬롯의 칸 수. **폭이 고정되는 것이 이 숫자의 일**이다 — 참여자가 늘어도 요약 줄이
 * 길어지지 않아야 채널을 훑을 수 있다(identity 문서).
 */
const FACE_SLOTS = 3;

/**
 * 출처 줄에 실을 뿌리 본문의 길이(#624 요구 2). 뿌리를 **알아보게** 하는 것이 이 줄의
 * 일이지 뿌리를 읽게 하는 것이 아니다 — 길어지면 사본의 본문보다 출처가 커진다.
 */
const ROOT_PREVIEW_CHARS = 40;

export function MessageItem({ message, inThread = false, onOpenDirectory, onOpenSettings }: {
  message: MessageRow;
  inThread?: boolean;
  /** 멘션을 눌렀을 때 갈 곳(#279). 넘기지 않으면 멘션은 버튼이 아니다 — `MessageBody` 참고. */
  onOpenDirectory?: (accountId: string | null) => void;
  onOpenSettings?: (section?: SectionId, targetId?: string) => void;
}) {
  const t = useT();
  const author = useActiveStore((s) => s.accounts[message.authorId]);
  const isMine = useActiveStore((s) => s.me?.id === message.authorId);
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  /**
   * 이름·얼굴을 눌렀을 때 갈 곳. **`@멘션` 칩과 같은 함수**를 지난다(`lib/accountOpen`) —
   * 화면에서 한 사람을 가리키는 자리는 셋(멘션 칩·이름줄·거터 아바타)인데 그 셋이 서로
   * 다른 곳으로 가면, 사람은 "어디를 눌러야 프로필이 나오는지"를 매번 시험해 봐야 한다.
   * 신호(`onOpenDirectory`·`onOpenSettings`)가 없는 자리에서는 `null` 이라 **버튼이 아니다**
   * — 눌러도 아무 일이 없는 컨트롤을 남기지 않는다(`MessageBody` 의 같은 규칙).
   */
  const authorOpen = accountOpen(author, { id: myId, isAdmin }, { onOpenDirectory, onOpenSettings }, t);
  // 생존 판정의 두 축 — `connected` 가 false 면 `online` 은 '아무도 없다'가 아니라 '모른다'다.
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // 링크로 방금 온 메시지인가. **스토어의 화면 상태**를 보고 그린다 — 이 사실을 message 에
  // 넣으면 서버에서 온 데이터와 지금 화면의 사정이 한 값에 섞인다(#178).
  const highlighted = useActiveStore((s) => s.highlightedMessageId === message.id);
  const rowRef = useRef<HTMLDivElement>(null);

  // 강조만 하고 화면 밖에 두면 긴 채널에서는 아무 일도 안 일어난 것과 같다.
  // jsdom 에는 scrollIntoView 가 없으므로 옵셔널 호출이다(ChannelPane 도 같은 이유로 그렇다).
  //
  // `block: 'nearest'` 인 이유는 `ChannelPane` 의 같은 호출에 적어 뒀다 — 무인자
  // (`'start'`)는 **문서까지** 밀어 앱 껍데기를 창 위로 끌어올린다. 인박스에서 줄을 눌러
  // 여기로 오는 길이 정확히 그 경로였다(실측 2026-09-08).
  useEffect(() => { if (highlighted) rowRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [highlighted]);

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

  /**
   * 이 답이 딸린 스레드의 **뿌리 메시지**(#624 요구 2). 뿌리는 같은 채널의 최상위
   * 메시지라 채널을 보고 있으면 보통 스토어에 이미 있다 — 없을 수도 있는데(뿌리가 지금
   * 불러온 페이지보다 오래됐다) 그때는 미리보기 없이 링크만 그린다.
   * `find` 가 돌려주는 것은 스토어에 든 그 객체이므로 셀렉터가 매번 새 값을 만들지 않는다.
   */
  const threadRoot = useActiveStore((s) => (
    !inThread && message.alsoInChannel && message.threadRootId
      ? (s.messages[message.channelId] ?? []).find((m) => m.id === message.threadRootId) ?? null
      : null
  ));
  /** 한 줄로 접은 뿌리 본문. 줄바꿈이 남으면 한 줄짜리 링크가 두 줄로 벌어진다. */
  const rootPreview = useMemo(() => {
    if (!threadRoot) return null;
    const text = displayBody(threadRoot, accounts).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > ROOT_PREVIEW_CHARS ? `${text.slice(0, ROOT_PREVIEW_CHARS)}…` : text;
  }, [threadRoot, accounts]);
  /**
   * 어느 모델이 이 말을 했는가(#600). **상시 픽셀은 0 이다** — 이름줄 hover 의 `title` 로만
   * 나오고, 어긋났을 때만 ⚠️ 한 글자가 선다.
   *
   * 왜 글자로 안 그리는가: 모델은 거의 언제나 설정대로이고, 언제나 맞는 정보를 모든 말
   * 옆에 세우면 이름줄이 배지밭이 된다(#488 이 강조색을 회수한 그 이유). 사람이 실제로
   * 묻는 순간("이 답을 뭐가 했지?")은 드물고, 그때는 hover 가 답한다. 반대로 **어긋남**은
   * 드물고 곧 문제이므로(간단한 일에 Opus, 어려운 일에 Fable) 그것만 눈에 보인다.
   */
  const model = readModelMeta(message.meta);
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
  /**
   * **답글이 달렸는가** — 답글 요약과 툴바 진입점이 **같은 하나의 판정**을 나눠 쓴다.
   *
   * `replyCount` 는 서버에서 두 가지 뜻을 갖는다
   * (`packages/server/src/services/messages.ts:216`,
   * `case when m.thread_root_id is null then thread_stats.reply_count end`):
   *
   * - `null` — 이 메시지는 **답글이다**(스레드 루트가 아니다). 답글 수를 셀 대상이 아니다.
   * - `0` — **스레드 루트인데 답글이 아직 없다.**
   *
   * 그리고 `0` 은 반드시 온다: 같은 파일 `:196` 의 `thread_stats` 가
   * `LEFT JOIN LATERAL (SELECT COUNT(*)::int …) ON true` 라 답글이 없어도 행이 하나 나오고
   * `COUNT(*)` 는 `0` 이다 — 루트의 `replyCount` 가 `null` 이 되는 경우는 없다.
   *
   * **`#396` 이 이 구분을 놓쳤다.** 두 자리를 `replyCount !== null` / `=== null` 로 갈라
   * 두어, 서버가 실제로 주는 `0` 이 **양쪽 어디에도 맞지 않았다** — 답글 요약이 `0 replies`
   * 를 그리고 툴바 진입점은 사라져, 문서가 위반 예시로 지목한 그 글자가 스레드로 가는
   * **유일한** 길이 돼 있었다(`docs/desktop-design-directions.pdf` 5쪽,
   * *위생 — 자리를 비운다* · *"0은 그리지 않는다"*).
   *
   * 그래서 판정을 **여기 한 곳**에 두고 두 자리가 이것의 참/거짓으로만 갈린다.
   * 조건을 양쪽에 손으로 적으면 배타성이 우연이 되고, `#396` 이 깨진 방식으로 다시
   * 어긋난다 — 한쪽만 고치는 것이 가능해지기 때문이다. 아래 답글 요약 주석이 지키라고
   * 한 *"같은 조건끼리는 서로 덮을 대상이 없다"* 는 성질이 이 한 줄로 성립한다:
   * 세 값(`null`·`0`·`> 0`) 전부에서 진입점은 정확히 하나다.
   */
  const hasReplies = (message.replyCount ?? 0) > 0;
  /**
   * **무언가 달렸는가** — 요약 줄과 툴바 진입점을 가르는 판정. `hasReplies` 와 갈라진
   * 이유(2026-09-09): `replyCount` 가 접힌 진행(`ProgressRow`)·대기 줄(`WakeRow`)을 더는
   * 세지 않으므로, 진행만 있는 스레드에서 그 값은 `0` 이다. 그 하나로 요약 줄을 가르면
   * **도는 스레드의 `작업 중` 배지가 통째로 사라진다** — 이 줄이 배지를 얹고 있는 유일한
   * 자리이고, 열어 보지 않은 스레드가 도는지 끝났는지는 오직 그 배지가 답한다.
   *
   * 그래서 판정을 둘로 가른다: **자리가 서는가**(이것)와 **글자를 그리는가**(`hasReplies`).
   * `0` 은 여전히 그려지지 않으므로(규칙 06 · `#396`) 진행뿐인 스레드의 요약 줄에는
   * 배지만 서고 `0개` 는 없다.
   */
  const hasActivity = (message.activityCount ?? message.replyCount ?? 0) > 0;
  /**
   * 얼굴 슬롯 — **아바타 셋까지, 나머지는 `+N`**(identity 문서 Task 13).
   *
   * 다섯이던 것을 셋으로 줄인다: **폭이 고정되어야** 참여자가 3이든 40이든 요약 줄의
   * 모양이 같다. 서버가 **마지막으로 말한 순**으로 주므로(`THREAD_STATS`) 앞에서 자르면
   * 방금 말한 사람이 항상 보인다 — 명단이 실제로 움직인다.
   */
  /**
   * 채널 요약 줄의 상태(Task 6 Step 2). 서버가 실어 준 집계로 판정한다 — 답글은 스레드를
   * 열 때만 로드되므로 여기서 메시지 배열로 판정하면 **열어 보지 않은 스레드가 전부
   * '끝남'** 이 된다(계획서가 경계한 거짓말).
   *
   * 생존은 `connected` 가 false 면 '모른다'다 — `ThreadPanel` 과 같은 규약.
   */
  const summaryState = useMemo(() => threadStateFromFacts({
    row: message,
    myAccountId: myId,
    isAgent: (id) => accounts[id]?.kind === 'agent',
    live: connected ? new Set(online) : null,
  }), [message, myId, accounts, connected, online]);

  /**
   * **말 슬롯**(identity 문서 Task 13) — "누가 누구를 기다린다".
   *
   * 문서가 이 줄을 "아직 만들 수 없다"고 적어 두었다: *"meta 에 되물음·선택의 수신자가
   * 들어 있어야 한다."* 그 전제는 `AskMeta.to` 로 충족됐고, **채널 목록에서 사슬을
   * 만드는 것**은 `openAskLinks`(#490)가 열었다.
   *
   * 이름은 **양 끝만** 쓴다(`chainEnds`) — 일곱이 답한 스레드에서도 이름은 둘이다.
   */
  const ends = useMemo(() => {
    const chain = waitChainFromLinks({
      links: message.openAskLinks ?? null,
      myAccountId: myId,
      live: connected ? new Set(online) : null,
    });
    const e = chain ? chainEnds(chain) : null;
    /**
     * **강조는 이 사슬 자신이 정한다.** `summaryState` 에서 읽지 않는 이유: 그것은
     * `openAskAccountIds` 를 보고 이 줄은 `openAskLinks` 를 보므로, 둘이 어긋나면
     * 화면이 **자기가 그린 문장과 다른 강조**를 준다. 같은 재료에서 나온 판정을 쓴다.
     */
    return e && chain ? { ...e, mine: chain.end === 'me' } : null;
  }, [message.openAskLinks, myId, connected, online]);

  /** 이름을 부르는 유일한 자리. 모르면 `…` 다 — 없는 이름을 지어내지 않는다. */
  const nameOf = (id: string): string => accounts[id]?.handle ?? '…';

  /**
   * 답글 요약 버튼의 접근 가능한 이름. **상태를 라벨에도 싣는다**(아래 그 자리 주석) —
   * `aria-label` 이 자식 글자를 덮으므로 배지가 화면에 보여도 여기 없으면 스크린리더에는
   * 없는 것이다.
   *
   * **틀을 넷으로 가른다.** 상태와 마지막 시각이 각각 없을 수 있는데, 한 틀에 `{state}` 를
   * 두고 빈 문자열을 넣으면 영어에서 `, 2 replies` 처럼 쉼표가 앞에 남는다. 어느 조각을
   * 어떻게 잇는지는 **그 언어의 일**이라 사전이 져야 하고, 화면은 어느 사실이 있는지만
   * 고른다.
   */
  const summaryLabel = ((): string => {
    const count = t('message.summary.replies', { count: message.replyCount ?? 0 });
    const state = summaryState ? threadStateLabel(summaryState, t) : null;
    /**
     * **읽을 답글이 없으면 수를 말하지 않는다.** 이 줄은 접힌 진행만 있는 스레드에도
     * 서므로(`hasActivity`), 여기서 `count` 를 그대로 실으면 화면에 없는 `0개의 답글` 이
     * 스크린리더에만 존재하게 된다 — 눈으로 읽든 귀로 듣든 같은 거짓이다. 그때 이 줄이
     * 말하는 사실은 상태 하나뿐이다.
     */
    if (!hasReplies) return state ?? t('message.replyInThread');
    if (state && lastReplyTime) {
      return t('message.summary.labelWithStateAndTime', { state, count, time: lastReplyTime });
    }
    if (state) return t('message.summary.labelWithState', { state, count });
    if (lastReplyTime) return t('message.summary.labelWithTime', { count, time: lastReplyTime });
    return t('message.summary.label', { count });
  })();

  const participantList = message.participantIds ?? [];
  const displayedParticipants = participantList.slice(0, FACE_SLOTS);
  const remainingCount = participantList.length - FACE_SLOTS;
  // system 메시지는 avcs 투영의 산물이라 사람이 고칠 수 없다 — 서버도 거절한다.
  const canEdit = isMine && !isSystem;
  // 삭제는 작성자 또는 admin — 서버가 그렇게 허용한다. UI가 작성자만 내주면 잘못 올라간
  // 비밀·스팸을 치울 경로가 admin 에게 없어, 서버가 열어 둔 조정 수단이 도달 불가가 된다.
  // 수정은 admin 에게도 열지 않는다: 남의 발언을 고칠 수 있으면 기록이 증거가 못 된다.
  const canDelete = (isMine || isAdmin) && !isSystem;
  /**
   * 채널로 함께 올린 스레드 답을 채널에서 거둔다(#231 되돌리기).
   *
   * 조건이 셋인 이유: 스레드 답이어야 하고(`threadRootId`), 지금 채널에도 보이고 있어야
   * 하고(`alsoInChannel`), 지울 수 있는 사람이어야 한다. 앞의 둘은 "지금 상태"라 이미
   * 거둔 메시지에는 항목이 아예 뜨지 않는다 — 눌러도 아무 일 없는 항목은 거짓 신호다
   * (design.md §4).
   *
   * 보관된 채널에서도 남긴다. 잘못 흘린 말을 치우는 길은 채널이 얼어붙은 뒤에도 있어야
   * 한다 — 서버의 삭제·핀 해제가 같은 이유로 보관을 보지 않는다.
   */
  const canRecall = canDelete && message.alsoInChannel && message.threadRootId !== null;
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
  /**
   * 이미 쓴 스레드 답을 나중에 채널로 올린다(거두기의 반대). 컴포저의 체크박스는 **쓸 때**
   * 한 번만 물으므로, 스레드에서 이야기가 끝난 뒤 "이건 채널도 봐야 한다"가 되면 지금까지는
   * 같은 말을 다시 쓰는 수밖에 없었다 — 그러면 스레드의 그 발언과 채널의 사본이 서로 다른
   * 메시지가 되어 리액션·답글이 갈린다.
   *
   * 조건이 넷이다. 스레드 답이어야 하고(`threadRootId`), 아직 채널에 안 보여야 하고
   * (`!alsoInChannel` — 이미 보이면 올릴 것이 없고 그 자리에는 거두기가 뜬다),
   * 보관된 채널이 아니어야 하고, **내가 쓴 글이어야** 한다.
   *
   * 마지막 조건이 `canDelete`(작성자 또는 admin)와 다른 것이 이 항목의 핵심이다: 거두기는
   * 잘못 흘린 말을 치우는 **조정**이라 admin 에게도 열려 있지만, 채널로 올리는 것은
   * **발화**다. 남이 스레드에만 쓰기로 한 말을 admin 이 채널로 퍼뜨릴 수 있으면 그 판단이
   * 지켜지지 않는다. 서버도 작성자만 허용하므로(`promoteToChannel`) 메뉴를 더 넓게 내주면
   * 눌릴 때마다 403 이 돌아온다.
   */
  const canPostToChannel = isMine && !isSystem && message.threadRootId !== null
    && !message.alsoInChannel && !isArchived;
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

  /**
   * 확인창에 보여 줄 대상 미리보기. 수정창(#271)과 같은 두 손질을 거친다 —
   * `displayBody` 로 시스템 문구의 계정 자리를 채우고, `bodyAsHandles` 로 저장된 정본의
   * `<@0f3c…>` 를 `@handle` 로 되돌린다. 날것을 그대로 두면 사람은 자기가 무엇을 지우는지
   * 읽지 못한 채 확인을 누르게 된다.
   */
  const deletePreview = bodyAsHandles(displayBody(message, accounts), accounts).trim();
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

  /**
   * 대기 줄(마이그레이션 040)은 말풍선이 아니다 — 발화가 아니므로 리액션·툴바·스레드
   * 컨트롤을 달지 않는다. 러너의 발화 판정도 이 종류를 세지 않으니
   * (agent/src/prompt.ts::countOwnPostsSince) 화면과 러너가 같은 것을 같게 본다.
   *
   * 분기를 **여기** 두는 이유: 채널과 스레드 두 곳이 같은 슬롯 함수를 공유하고, 분기를
   * 양쪽에 심으면 언젠가 한쪽만 고쳐진다. 종류로 갈리는 판정은 종류를 아는 한 곳에 둔다.
   *
   * 훅 뒤에 두는 것이 필수다 — 위의 훅들보다 앞에서 돌아서면 같은 컴포넌트가 렌더마다
   * 다른 개수의 훅을 부른다.
   *
   * 남는 경계: 에이전트 둘이 한 스레드에서 주고받는 구간에 대기 줄이 끼면
   * `groupAgentExchanges` 가 그것을 접힌 주고받기로 삼킬 수 있다. 그 자리에서는
   * "에이전트끼리는 접는다"(규칙 04)가 이기고, 사람을 막는 말이 아니므로 그대로 둔다.
   */
  if (message.kind === 'wake') return <WakeRow message={message} />;

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
    // 확인은 **겹창**으로 묻는다(#ConfirmDialog). 예전에는 툴바 안에 확인 버튼을 끼워 넣느라
    // `!confirmingDelete` 로 이 항목을 숨겨야 했다 — 같은 자리를 두 UI 가 나눠 썼기 때문이다.
    // 겹창은 툴바 밖이라 자리를 다투지 않으므로 조건은 권한 하나로 돌아온다.
    ...(canDelete ? [{ label: 'Delete', onSelect: () => setConfirmingDelete(true) }] : []),
    /**
     * #231 되돌리기. 문구가 'Delete' 가 아닌 이유를 문구 자체가 말해야 한다 — 이것은
     * 지우기가 아니라 **채널에서만** 거두는 일이고, 메시지는 스레드에 그대로 남는다.
     * 그래서 대상('from channel')을 문구에 박는다.
     *
     * 확인 단계를 두지 않는다: 지우기와 달리 본문이 사라지지 않는다. 다만 되돌린 것을
     * 다시 채널로 올리는 길은 없으므로(다시 쓰면 된다) 'Undo' 라고 부르지도 않는다.
     */
    ...(canRecall ? [{ label: 'Remove from channel', onSelect: () => { void getController().recallFromChannel(message.id); } }] : []),
    /**
     * 거두기와 **같은 자리, 반대 방향**이다. 둘은 조건이 배타적이라(`alsoInChannel`)
     * 한 메뉴에 함께 뜨는 일이 없다 — 지금 상태가 어느 쪽인지 항목 하나가 말한다.
     *
     * 확인 단계를 두지 않는다: 되돌리는 길(`Remove from channel`)이 바로 옆에 있다.
     */
    ...(canPostToChannel ? [{ label: 'Post to channel', onSelect: () => { void getController().postToChannel(message.id); } }] : []),
    // #219: 나중에 볼 것으로 담기. 담겨 있으면 문구가 해제로 바뀐다 — 같은 자리에 두 항목을
    // 나란히 두면 어느 것이 지금 상태인지 화면이 말하지 않는다.
    // 문구는 이 메뉴의 나머지(Pin·Edit·Delete…)와 같은 영문이다: 여기만 한국어로 두면
    // 한 메뉴 안에서 언어가 갈린다(#219 spec 은 UI 가 한국어라고 보고 "나중에 보기"를 적었다).
    ...(isSaved
      ? [{ label: 'Unsave', onSelect: () => { void getController().unsaveMessage(message.id); } }]
      : [{ label: 'Save for later', onSelect: () => { void getController().saveMessage(message.id); } }]),
  ];

  /**
   * **지워진 스레드 머리**(요청 2026-09-09). 여기서 갈라지는 이유는 이 행에 그릴 것이
   * 거의 없기 때문이다 — 본문·첨부·리액션·물음은 서버가 이미 떼어 냈고(`LIST_COLS`),
   * 남은 것은 "여기서 스레드가 시작했다"는 사실뿐이다. 아래 본문 열을 조건으로 누비면
   * 이름줄·툴바·메뉴가 전부 "지운 말에 대해서는 뭘 하나"를 따로 답해야 한다.
   *
   * 훅은 이 줄 위에서 모두 돌았으므로 호출 순서는 변하지 않는다.
   */
  if (message.deletedAt) return <DeletedMessageRow message={message} inThread={inThread} />;

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
      {/* 거터 자체가 누를 자리다 — 아바타를 버튼으로 **감싸지 않는다.** 감싸면 거터의
          첫 자식이 `Identity` 가 아니게 되어(회귀선이 그 자리를 잰다: `gutterOverflow
          Regression.test.tsx`) 32px 열의 계약이 마크업 한 겹 아래로 밀린다. 여기서
          바뀌는 것은 태그와 커서뿐이고, 상자·자식은 위 주석 그대로다.

          **보조기술에는 내지 않는다**(`aria-hidden` + `tabIndex={-1}`). 바로 옆 이름줄
          버튼이 **같은 곳**으로 가므로, 둘 다 내면 메시지마다 같은 이름의 버튼이 둘씩
          서서 목록과 탭 순서가 두 배가 된다. 잃는 것은 없다 — 키보드·스크린리더는
          이름줄로 가고, 여기는 얼굴을 눌러 여는 마우스 길이다. */}
      {authorOpen ? (
        <button
          type="button"
          data-testid="author-gutter"
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full"
          onClick={authorOpen.run}
          aria-hidden="true"
          tabIndex={-1}
        >
          <Identity account={author} className="h-8 w-8 text-sm" variant="avatar" />
        </button>
      ) : (
        <div data-testid="author-gutter" className="flex h-8 w-8 shrink-0 items-center justify-center">
          <Identity account={author} className="h-8 w-8 text-sm" variant="avatar" />
        </div>
      )}
      {/*
        본문 최대폭. **남는 자리를 쓰되, 무한히 늘리지는 않는다.**

        앞 판은 `max-w-[70ch]`(계획 Task 10 Step 4) 였다. 뿌리 글자 13px 에서 약 500px 이라,
        1300px 짜리 창에서도 글이 화면 한가운데서 끊기고 오른쪽이 통째로 비었다 — 스레드를
        열지 않고 채널만 보는 사람에게는 그 빈자리가 "고장"으로 읽힌다(2026-09-08 신고).
        읽기 좋은 줄 길이를 지키려던 값인데, 실제로 지킨 것은 *좁게 유지*뿐이고 넓은 창에서
        비어 있는 절반을 설명하지 못했다.

        그래서 **상한만** 남기고 자라는 일은 `flex-1` 에 맡긴다. 창이 좁으면 이 열이 곧 창
        폭이고(양옆 여백은 행의 `px-4` 가 준다), 넓어지면 상한까지 자란다. 자리가 남아도
        상한을 넘지 않으므로 4K 에서 글이 화면을 가로지르지는 않는다.

        **1280px 인 이유**: 32인치 4K 를 macOS 기본 배율(논리 폭 2560px)로 쓸 때 화면의
        정확히 절반이다 — 요청이 그 기준이었다("32인치 모니터 기준 반 정도"). 읽기 쪽으로도
        말이 된다: 한글은 글자폭이 글자 크기와 거의 같아 13px 에서 한 줄 약 98자다.
        값을 옮길 일이 생기면 **여기 한 곳**이다 — 보고·물음·실패 카드는 자기 상한을 갖지
        않고 이 열을 채운다(`ReportCard`·`AskCard`·`FailureCard`).

        `min-w-0` 은 그대로 둔다: 긴 코드·URL 이 flex 열을 밀어내는 것을 막는 것이 그 일이고,
        최대폭과는 다른 문제다.
      */}
      <div data-testid="message-body-column" className="min-w-0 max-w-[1280px] flex-1">
        <div className="flex items-baseline gap-2">
          {/* `data-testid` 를 두는 이유는 위 `author-gutter` 와 같다: 이 자리가 **작성자**의
              것이라는 사실을 회귀선이 클래스 문자열로 더듬지 않게 한다. 아바타(`Identity`)도
              handle 을 sr-only 로 내보내므로 글자로 찾으면 두 곳이 걸려, 이름줄이 다른
              사람을 가리키게 되어도 테스트가 무엇을 봤는지 말하지 못한다(#329). */}
          {/* **이름줄단 15px.** 4단(17 / 15 / 13 / 11)에서 둘째 단의 이름이 그대로
              "이름줄"이고, 그 이름이 가리키는 자리가 여기다 — 이 줄까지 본문단으로 두면
              4단이 실제로는 3단이 되고(15px 을 쓰는 자리가 하나도 없었다), 대화가 한
              덩어리로 흐른다. 같은 줄의 시각·배지는 아랫단 11px 이라 한 줄 안에 세 단이
              아니라 두 단이 선다: **누가**(15)와 **곁정보**(11), 본문은 그 아래 13. */}
          {/* 이름은 **누를 수 있다** — `@handle` 을 누르는 것과 같은 곳으로 간다.
              글자 크기·굵기는 위 문단이 정한 그대로이고(15px 이름줄), 누를 수 있다는
              것은 hover 밑줄과 커서로만 말한다: 여기에 색을 칠하면 이름마다 강조가
              하나씩 서서 정작 나를 막는 말의 색이 죽는다(규칙 04, #488 B2). */}
          {authorOpen ? (
            <button
              type="button"
              data-testid="author-name"
              className="cursor-pointer text-name font-semibold hover:underline"
              title={model ? t('message.model.tooltip', { id: model.id }) : undefined}
              // 접근 가능한 이름 앞에 **작성자**를 붙인다. 자기 이름을 부르는 말
              // (`@someone` 이 쓴 "@someone 확인했다")에서는 이름줄 버튼과 본문 멘션 칩이
              // 같은 곳으로 가는 **다른 두 자리**인데, 이름이 같으면 스크린리더 사용자는
              // 목록에 뜬 둘 중 어느 것이 어디인지 알 수 없다(회귀선이 실제로 그 충돌로
              // 빨개졌다: `mentionClick.test.tsx` 의 `getByRole` 이 둘을 찾았다).
              aria-label={t('message.authorLabel', { name: authorOpen.label })}
              onClick={authorOpen.run}
            >{author?.handle ?? '…'}</button>
          ) : (
            <span
              data-testid="author-name"
              className="text-name font-semibold"
              title={model ? t('message.model.tooltip', { id: model.id }) : undefined}
            >{author?.handle ?? '…'}</span>
          )}
          {/* 설정과 어긋난 모델(#600). 배지가 아니라 **경고**다 — 이 자리에 무언가 서 있는
              것 자체가 "확인해 봐라"는 뜻이고, 무엇을 확인하는지는 hover 가 말한다.
              설정값을 적지 않는 이유는 서버가 그것을 안 싣기 때문이다(admin·소유자만 보는
              값이다 — `shared/src/index.ts` 의 `ModelMeta`). */}
          {model?.mismatch && (
            <span
              data-testid="model-mismatch"
              className="text-meta text-warning"
              title={t('message.model.mismatchTooltip', { id: model.id })}
              aria-label={t('message.model.mismatchLabel', { id: model.id })}
            >⚠️</span>
          )}
          {/*
            **여기에 배지가 있었다**(🤖 + 소유자 핸들). 뺐다 — identity 문서:
            *"이름 옆 배지와 소유자 핸들은 뺀다. 아바타만으로 누가 에이전트인지 알 수
            없는 것이 **의도한 결과**다."*

            아바타가 사람과 같아진 뒤(#465)로 🤖 는 같은 말을 두 번 하는 것이었고,
            종류·소유자·하네스는 프로필(#475)이 답한다 — 그 자리가 생기기 전까지
            이 배지를 붙잡아 뒀던 이유가 그것이었다(계획서 Task 12 의 유예).

            덤으로 강조색도 하나 회수된다(#488 B2): 이 배지는 `bg-accent-surface
            text-accent` 라 **에이전트 이름마다 강조가 하나씩** 서 있었다.
          */}
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
          {/* #624 요구 1: 스레드에서 **채널에도** 함께 보낸 답. 스레드 안에서 이 사실이
              보여야 한다 — 안 보이면 "우리끼리 한 말"로 읽고 다음 말을 고르게 된다.
              채널 쪽 사본에는 이 표시를 달지 않는다: 거기서 필요한 것은 반대 사실
              (**어느 스레드에서 왔는가**)이고, 본문 위의 출처 줄이 그것을 말한다.
              배지이지 링크가 아니다 — 이미 그 스레드 안이라 갈 곳이 없다. */}
          {inThread && message.alsoInChannel && message.threadRootId && (
            <span data-testid="channel-echo-mark" className="text-meta text-fg-subtle">
              #↵ {t('message.channelEcho')}
            </span>
          )}
          {avcsType && <span className="rounded bg-warning-surface-strong px-1 text-meta text-warning">{avcsType}</span>}
          <span className="text-meta text-fg-muted">{time}</span>
          {message.editedAt && <span className="text-meta text-fg-muted">(edited)</span>}
        </div>

        {draft === null ? (
          <>
            {/* #624 요구 2: 채널에 함께 올라온 답은 **어느 스레드에서 왔는지**를 본문
                **위에** 달고 간다. 아래에 두면 앞뒤 없는 말을 먼저 읽고 나서 출처를 알게
                되는데, 이 사본이 필요한 정보는 읽기 전에 필요한 것이다.
                뿌리 본문 미리보기는 편의이고(없을 수 있다) 링크는 필수다 — 미리보기가
                없다고 링크를 지우면 이 사본이 앞뒤를 되찾을 길이 사라진다. */}
            {!inThread && message.alsoInChannel && message.threadRootId && (
              <button
                data-testid="thread-origin-link"
                // 아래 "최근 댓글 보기"와 **같은 처리**를 받는다(#488 B2): 스레드로 가는
                // 링크이지 나를 막는 말이 아니므로 색이 아니라 점선 밑줄이 링크임을 말한다.
                className="mb-0.5 -mx-1 flex max-w-full items-baseline gap-1 rounded px-1 py-0.5
                           text-meta text-fg-muted hover:bg-surface-hover"
                onClick={() => void getController().openThread(message.threadRootId!)}
                // 미리보기는 화면에서 접히므로(`truncate`) 귀로 듣는 쪽에는 온전히 실어 준다.
                aria-label={rootPreview ? `${t('message.threadOrigin')}: ${rootPreview}` : t('message.threadOrigin')}
              >
                <span className="shrink-0">{t('message.threadOrigin')}{rootPreview ? ':' : ''}</span>
                {rootPreview && (
                  <span className="truncate font-medium underline decoration-dotted underline-offset-2">
                    {rootPreview}
                  </span>
                )}
              </button>
            )}
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
                className="mt-1 rounded-lg border border-border px-2 py-1 text-meta font-medium
                           text-fg hover:bg-surface-hover"
                onClick={() => onOpenSettings('skills', skillSlug)}
              >
                {t('message.openSkillApproval')}
              </button>
            )}
            <Attachments attachments={message.attachments} />
            {/*
              **집합 호출의 결과**(정본 문서). 리액션·답글 요약보다 **앞**에 둔다: 이 줄은
              내가 방금 부른 것의 결과라 본문에 붙어 읽혀야 하고, 아래의 둘은 그 뒤에 남들이
              붙인 것이다. 덜 깼을 때만 스스로 렌더한다 — 조건을 여기 두지 않는 이유는
              `WakeRow` 와 같다: 종류로 갈리는 판정은 그것을 아는 한 곳에 둔다.
            */}
            <NotifiedGapRow messageId={message.id} />
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
                적용되지 않는다. 답글 요약은 여전히 절대 툴바로 올리지 않는다.)
                이 자리는 **답글이 있을 때만**(`hasReplies`) 그린다 — `0` 이면 `0 replies` 가
                되어 문서가 금지한 글자가 된다. 근거는 `hasReplies` 정의 주석에 있다. */}
            {!inThread && hasActivity && (
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
                           text-meta hover:bg-surface-hover"
                onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
                /*
                  **상태를 라벨에도 싣는다.** `aria-label` 은 자식 글자를 **덮어쓰므로**,
                  뱃지가 화면에 보여도 이 문자열에 없으면 스크린리더에는 존재하지 않는다 —
                  "열어야 하나"에 답하지 못하는 것은 눈으로 읽든 귀로 듣든 같은 결함이다.
                  화면과 같은 순서(상태 → 답장 수)로 둔다.
                */
                aria-label={summaryLabel}
              >
                {/* 참여자 아바타 — 최대 셋, 나머지는 +N 으로 접는다. 장식 용도라 스크린리더가
                    읽지 않도록 aria-hidden 처리하고 sr-only 도 안 준다. #277: variant="avatar" */}
                <span className="flex -space-x-1" aria-hidden="true">
                  {displayedParticipants.map((id) => (
                    // #471: 래퍼에 `rounded-full` 이 **있어야 한다**. 링을 그리는 것은 안쪽
                    // 아바타가 아니라 이 래퍼라, 곡률이 없으면 링이 사각형으로 그려지고
                    // 겹친 자리에서 그 세로 변이 앞 아바타 위에 선처럼 얹힌다. 링의 목적은
                    // 겹친 원들을 떼어 놓는 것인데 사각 링은 반대로 경계를 만든다.
                    <span key={id} className="rounded-full ring-1 ring-surface">
                      <Identity account={accounts[id]} className="h-4 w-4 text-[8px]" variant="avatar" />
                    </span>
                  ))}
                  {remainingCount > 0 && (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-hover text-[8px] font-medium text-fg-muted ring-1 ring-surface">
                      +{remainingCount}
                    </span>
                  )}
                </span>
                {/*
                  말 슬롯 — **이름을 나열하지 않는다**(identity 문서 Task 13). 얼굴이 "누가"를
                  이미 답하고 있으므로 글자는 **"무엇을 기다리는가"**만 말한다.
                  채널을 훑을 때의 질문은 "누가 있나"가 아니라 "열어야 하나"이고, 명단은
                  그 질문에 한 글자도 답하지 않는다.
                */}
                {/*
                  **상태가 먼저다**(Task 6 Step 2). 채널을 훑을 때의 질문은 "몇 개 달렸나"가
                  아니라 **"열어야 하나"** 이고, 답장 수는 그 질문에 답하지 않는다.
                  서버가 집계를 실어 주므로(#484) 열어 보지 않은 스레드도 판정할 수 있다 —
                  그 재료가 없으면(옛 서버·답글 행) 배지를 그리지 않고 답장 수만 남는다.
                */}
                {/*
                  **위에서부터 이긴다 — 하나의 스레드는 한 줄만 받는다**(문서).
                  사슬이 있으면 그것이 배지보다 구체적인 말이다: 배지는 "내 차례"까지만
                  말하고, 이 줄은 **누구를 기다리는지**까지 말한다.
                */}
                {ends ? (
                  <span
                    data-testid="speech-slot"
                    data-mine={ends.mine}
                    className={ends.mine ? 'font-medium text-state-turn' : 'text-fg-muted'}
                  >
                    {/*
                      **`waitChain.*` 을 부른다 — 새 키를 만들지 않는다.** 이 줄은 사슬의
                      같은 문장을 다른 재료(`openAskLinks`)에서 낼 뿐이고, 키를 따로 두면
                      스레드 패널의 사슬 줄과 이 줄이 언젠가 다른 말을 하게 된다.

                      조사는 이제 번역기가 푼다(`{waiter:이가}`) — `subjectParticle` 을
                      쓰던 마지막 자리가 여기였고, 그 함수와 `lib/particle.ts` 가 함께 사라졌다.
                    */}
                    {ends.blockedBy === null
                      // '사람 아무나'는 **다른 문장이다** — 이름 자리에 보통명사를 끼우면
                      // 조사가 어긋난다(그것이 `linkAnyone` 이 따로 있는 이유).
                      ? t('waitChain.linkAnyone', { waiter: nameOf(ends.waiter) })
                      : t('waitChain.link', {
                        waiter: nameOf(ends.waiter),
                        blockedBy: nameOf(ends.blockedBy),
                      })}
                  </span>
                ) : summaryState && <ThreadStateBadge state={summaryState} />}
                {/*
                  **답장 수는 강조색을 받지 않는다**(#488 B2). 문서: *"N replies 는
                  '현재 상태'이지 '급한 것'이 아니다."* 강조색은 나를 막는 말에만 쓴다 —
                  막는 것은 이미 왼쪽의 배지가 말하고 있다.
                */}
                {/* `data-testid` 를 두는 이유는 위 `author-gutter` 와 같다 — 회귀선이 이
                    조각을 클래스 문자열로 더듬지 않게 한다. 복수형은 **눈에 보이는 글자**로
                    재야 잡히므로(접근 이름만 재면 손수 복수형이 남아도 초록이다, 실측
                    2026-09-08) 그 조각을 이름으로 가리킬 수 있어야 한다. */}
                {/* `hasReplies` 로 다시 가른다 — 자리는 `hasActivity` 가 세우지만
                    **`0개` 는 글자로 그리지 않는다**(규칙 06). 진행만 있는 스레드에서 이
                    조각이 빠지면 줄에는 배지와 얼굴만 남는다. */}
                {hasReplies && (
                  <span
                    data-testid="reply-summary-count"
                    className={summaryState && isBlocking(summaryState)
                      ? 'text-fg-subtle'
                      : 'font-medium text-fg-muted underline decoration-dotted underline-offset-2'}
                  >
                    {/* **손수 복수형이 여기 있었다**(`=== 1 ? 'reply' : 'replies'`) —
                        영어만 맞는 판정이라 `Intl.PluralRules` 에 넘겼다. */}
                    {t('message.summary.replies', { count: message.replyCount ?? 0 })}
                  </span>
                )}
                {lastReplyTime && <span className="text-fg-subtle">{lastReplyTime}</span>}
              </button>
            )}
            {/* #396: 답글이 없을 때는 본문 아래에 버튼을 두지 않는다 — 답글이 달린 뒤의
                답글 요약(위 블록)과 같은 자리에 서서 "아직 아무 일도 없는 메시지"가
                "뭔가 달린 메시지"처럼 보였다. 진입점은 호버 툴바의 아이콘으로 옮겼다
                (아래 우상단 열, message toolbar 안). */}
            {/* #231: alsoInChannel 메시지는 채널에도 보이므로 스레드에서 왔을 때가 아니라
                채널에서 볼 때 이 버튼이 필요하다.
                #624 요구 3: 문구와 목적지를 바꾼다. 위의 출처 줄이 이미 "어느 스레드인가"에
                답하므로, 같은 자리에 스레드 **머리**로 가는 링크를 하나 더 두면 두 링크가
                같은 곳으로 간다. 이 버튼이 답하는 질문은 다른 것이다 — **이 말 뒤에 무슨
                말이 더 있었나.** 그래서 뿌리가 아니라 이 메시지 자리에 세운다. */}
            {!inThread && message.alsoInChannel && message.threadRootId && (
              <button
                // #424: 답글 요약과 같은 자리에 서는 링크이므로 상자도 함께 벗긴다 —
                // 한쪽만 상자면 두 진입점이 다른 종류처럼 보인다.
                // #488 B2: 답글 요약과 **같은 처리**를 받는다 — 스레드로 가는 링크이지
                // 나를 막는 말이 아니다. 색 대신 점선 밑줄이 링크임을 말한다.
                className="mt-0.5 self-start -mx-1 rounded px-1 py-0.5 text-meta font-medium
                           text-fg-muted underline decoration-dotted underline-offset-2
                           hover:bg-surface-hover"
                onClick={() => void getController().openThread(message.threadRootId!, message.id)}
              >
                {t('message.recentReplies')}
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
              <button className="rounded border border-border px-1.5 text-meta text-fg-muted" onClick={save}>Save</button>
              <button className="rounded border border-border px-1.5 text-meta text-fg-muted" onClick={() => setDraft(null)}>Cancel</button>
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
            {/* #396: 답글이 아직 **없는** 메시지의 스레드 진입점.
                답글이 달리면 본문 열의 답글 요약(위쪽, #161)이 상시 노출로 이 역할을 대신하므로
                그때는 여기 그리지 않는다 — 같은 진입을 두 곳에 두지 않는다. inThread 에서는
                스레드 안에서 또 스레드를 열 수 없으므로 아예 그리지 않는다(바깥 조건이 막는다).
                아이콘은 💬 를 쓰지 않는다 — 그건 에이전트 상태 신호 이모지라(#144,
                STATUS_SIGNAL_EMOJI) 사람이 누르는 버튼에 쓰면 신호의 뜻이 무너진다.
                조건이 `replyCount === null` 이었으나 **`0` 을 빠뜨렸다** — 서버는 답글 없는
                루트에 `0` 을 주므로 정작 이 아이콘이 가장 필요한 메시지에서 사라졌다.
                `!hasReplies` 로 `null` 과 `0` 을 함께 받는다(정의 주석 참고). */}
            {!inThread && !hasActivity && (
              <button
                className={iconBtn}
                title={t('message.replyInThread')}
                aria-label={t('message.replyInThread')}
                onClick={() => void getController().openThread(message.threadRootId ?? message.id)}
              >
                ↩
              </button>
            )}
            {
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
            }
          </div>
        )}
      </div>

      {/* 삭제는 되돌릴 수 없으니 한 번 더 묻는다. 확인은 **툴바 밖 겹창**이다 — 툴바 안에
          두면 (1) 확인 버튼이 들어오면서 아이콘들이 밀려 커서 아래에서 버튼이 갈리고,
          (2) 툴바가 호버로만 보이는 탓에 커서가 행을 벗어나는 순간 질문이 조용히 사라진다.
          겹창은 무엇을 지우는지 본문째 보여 주기까지 한다(`ConfirmDialog` 주석). */}
      {confirmingDelete && (
        <ConfirmDialog
          title="Delete message?"
          // 본문이 빈 메시지(첨부만 올린 것)에서는 미리보기를 아예 그리지 않는다 —
          // 빈 상자는 "본문이 이렇다"가 아니라 "못 읽었다"로 보인다.
          detail={deletePreview === '' ? undefined : (
            <span className="line-clamp-3 whitespace-pre-wrap break-words">{deletePreview}</span>
          )}
          confirmLabel="Delete"
          danger
          onConfirm={() => { setConfirmingDelete(false); void getController().deleteMessage(message.id); }}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

/**
 * 지워진 스레드 머리의 자리(요청 2026-09-09).
 *
 * **왜 자리가 남는가:** 스레드를 시작한 말을 지우면 답글은 그대로 살아 있다. 그 한 행까지
 * 목록에서 빼면 채널에서는 스레드가 통째로 없어진 것으로 보이고, 안에 남은 히스토리로
 * 들어갈 문이 사라진다. 반대로 답글까지 함께 지우면 남의 말이 내 삭제로 사라진다.
 * 그래서 **머리 자리만** 남긴다 — 서버가 본문·첨부·리액션·meta 를 떼어 보내므로
 * (`services/messages.ts` 의 `LIST_COLS`) 여기서 새어 나갈 내용은 애초에 없다.
 * 답글이 하나도 없는 머리는 이 행조차 오지 않는다(그냥 지워진다).
 *
 * **아무것도 곁들이지 않는다:** 이름·얼굴·시각·툴바가 없다. 지운 말의 작성자와 시각은
 * 지운 말의 일부이고, 지운 말에는 고칠 것도 리액션할 것도 없다. 남기는 컨트롤은
 * **스레드로 들어가는 문** 하나다 — 그것이 이 행이 존재하는 이유다.
 */
function DeletedMessageRow({ message, inThread }: { message: MessageRow; inThread: boolean }) {
  const t = useT();
  const replyCount = message.replyCount ?? 0;
  return (
    <div data-testid="deleted-message" className="group relative flex gap-2 px-4 py-1.5">
      {/* 아바타 거터의 폭을 비워 둔다 — 얼굴은 그리지 않지만 본문 열이 위아래 메시지와
          같은 자리에서 시작해야 목록이 한 칸 밀려 보이지 않는다. */}
      <div className="h-8 w-8 shrink-0" aria-hidden="true" />
      <div className="min-w-0 max-w-[1280px] flex-1">
        <div className="text-body italic text-fg-subtle">{t('message.deleted')}</div>
        {/* 스레드 안에서는 그리지 않는다 — 이미 그 스레드 안이라 갈 곳이 없다
            (`message.channelEcho` 배지와 같은 판단). */}
        {!inThread && replyCount > 0 && (
          <button
            data-testid="deleted-message-replies"
            className="mt-0.5 -mx-1 rounded px-1 py-0.5 text-meta font-medium text-fg-muted
                       underline decoration-dotted underline-offset-2 hover:bg-surface-hover"
            onClick={() => void getController().openThread(message.id)}
          >
            {t('message.summary.replies', { count: replyCount })}
          </button>
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
  const t = useT();
  const myId = useActiveStore((s) => s.me?.id ?? null);
  const accounts = useActiveStore((s) => s.accounts);
  const ask = readAskMeta(message.meta);
  if (!ask || ask.answeredWith != null) return null;

  const forMe = ask.to.kind === 'human' ? myId != null : ask.to.accountId === myId;
  // 화살표는 문구가 진다 — **방향을 말하는 기호**라 이름과 떨어지면 뜻을 잃는다.
  const label = forMe
    ? t('message.audience.me')
    : ask.to.kind === 'account'
      ? t('message.audience.agent', {
        name: accounts[ask.to.accountId]?.handle ?? t('message.audience.unknownAgent'),
      })
      : t('message.audience.person');
  return (
    <span
      data-testid="audience-badge"
      data-for-me={forMe}
      className={`rounded px-1 text-meta font-medium ${
        forMe ? 'bg-accent-surface text-state-turn' : 'text-fg-agent'
      }`}
    >
      {label}
    </span>
  );
}
