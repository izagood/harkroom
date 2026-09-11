import { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { MAX_MESSAGE_BODY_CHARS, messagePermalink, parseMessagePermalink, type ScheduledMessageView } from '@harkroom/shared';
import type { AccountView, AgentTeamRow, AttachmentRow, HandleGroupRow } from '@harkroom/shared';
import { useActiveStore } from '../state/communities';
import { NO_TEAMS } from '../state/appStore';
import { getController } from '../state/controller';
import { ApiError } from '../lib/api';
import { GroupBadge, TeamBadge } from './Identity';
import { AttachmentThumb, formatSize } from './Attachments';
import {
  mentionQueryAt, applyMention, withStickyMentions, keepMentioned, bodyRecipients,
  type MentionQuery,
} from '../lib/mention';
import { undoSendStorage } from '../lib/prefs';
// 붙여넣기가 누구를 부르는지 · 인용으로 바꾸는 방법. 판정은 서버가 쓰는 것과 같은
// 함수 하나(`mentionedHandles`)에 얹혀 있다 — 그 파일의 주석이 근거다.
import { callsInText, quoteText, MANY_CALLS } from '../lib/pasteCalls';
// 입력 중인 코드에 면을 깔고(겹판), ⌘E 로 감싸거나 벗긴다. 무엇이 코드인지는 보낸 뒤
// 메시지를 그리는 것과 **같은 함수**(`splitCode`)가 정한다 — 그 파일의 주석이 근거다.
import { ComposerCode, COMPOSER_BOX } from './ComposerCode';
import { toggleCode } from '../lib/codeMarks';
// 하이퍼링크를 **쓰는** 쪽(⌘K · 고른 글 위에 주소 붙여넣기). 그리는 쪽은 #216 부터 있었다 —
// 무엇이 링크 문법인지는 렌더러가 쓰는 함수(`linkAt`)가 정한다. 그 파일의 주석이 근거다.
import { toggleLink, linkFromPaste, applyPastedLink, type PastedLink } from '../lib/linkMarks';
// 파일 드래그의 판정은 창 전체 안전망(`useFileDropGuard`)과 **같은 함수**를 쓴다.
import { isFileDrag } from '../lib/fileDrag';
import { ConfirmDialog } from './ConfirmDialog';
import { useT } from '../i18n/useT';

/**
 * 남은 글자를 세어 보이기 시작하는 지점 — 상한의 9할이다.
 *
 * 항상 보이게 두지 않는 이유: 평소 대화는 한두 줄이고, 그때 `7,912자 남음` 은 아무에게도
 * 필요 없는 숫자가 컴포저에 상주하는 것이다. 사람이 상한을 알아야 하는 순간은 상한이 손에
 * 잡힐 때뿐이고, 9할이면 남은 800자로 문장을 마무리할지 나눌지 판단할 여유가 있다.
 */
const BODY_COUNT_FROM = Math.floor(MAX_MESSAGE_BODY_CHARS * 0.9);

/**
 * 고정이 없는 자리가 읽는 빈 목록. **모듈 상수인 것이 요점이다** — 읽는 자리에서 `?? []`
 * 를 적으면 렌더마다 새 배열이 나고, 그것을 의존에 둔 `useMemo` 가 매 렌더 다시 돈다
 * (`appStore.ts::NO_TEAMS` 와 같은 근거).
 */
const NO_STICKY: string[] = [];

/**
 * 이만큼 긴 글을 붙여넣으면 **파일로 넘길 길을 제안한다.**
 *
 * 상한(`MAX_MESSAGE_BODY_CHARS`)이 아니라 그보다 훨씬 앞인 이유: 상한은 서버가 받아 주는
 * 한계이고, 이 수는 **대화가 읽히는 한계**다. 코드 파일이나 로그를 통째로 붙여넣으면
 * 상한 안이어도(2천~8천자) 그 한 통이 채널을 몇 화면 밀어내서, 그 앞뒤의 대화가 스크롤
 * 밖으로 사라진다 — 붙여넣은 사람이 잃는 것이 아니라 **읽는 사람이** 잃는다.
 *
 * 2,000자로 잡은 근거: 이 앱의 메시지 한 통은 대략 60자에 한 줄이고(`messageWidth`),
 * 2,000자면 30줄 남짓이라 노트북 화면 하나를 그 한 통이 채운다. 그보다 짧으면 대화가
 * 밀린다고 말하기 어렵고, 더 길게 잡으면 이미 밀린 뒤에 제안하는 셈이 된다.
 *
 * **막지 않는다 — 제안만 한다.** 붙여넣은 글은 그대로 초안에 들어가고, 파일로 옮기는 것은
 * 사람이 버튼을 누를 때만 일어난다(붙여넣기의 규칙: `onPaste` 주석).
 */
const PASTE_AS_FILE_CHARS = 2_000;

/**
 * 목록에 담는 후보의 상한. **목록의 높이는 이 수가 아니라 상자가 정한다** — 아래
 * 후보 목록은 `max-h-*` + `overflow-y-auto` 로 스크롤되는 상자다.
 *
 * 8 이었다. 그때 이 수의 뜻은 "화면을 덮지 않을 만큼" 이었고, 그래서 계정이 아홉만
 * 있어도 아홉째부터는 **조용히 사라졌다** — 목록은 여덟 줄에서 끝나고 스크롤할 것도
 * 없으니, 있는 상대를 찾을 길이 화면에 남지 않았다(실측: 8 개만 보이고 스크롤이 안
 * 된다는 신고). 화면을 덮지 않게 하는 일은 상자의 높이가 이미 하고 있으므로 여기서
 * 두 번 하지 않는다. 이제 이 수는 **한 번에 그리는 항목 수의 상한**이다.
 */
const MAX_SUGGESTIONS = 50;

/**
 * '입력 중' 갱신 간격. 글자마다 소켓으로 보내면 한 문장에 수십 번 오간다. 서버의 만료
 * 창(6초)보다 넉넉히 짧게만 갱신하면 한 번 놓쳐도 표시가 끊기지 않는다.
 */
const TYPING_THROTTLE_MS = 3_000;

/**
 * 후보 목록에서 집합에 **미리 떼어 두는 자리**(#285).
 *
 * 자리를 떼지 않으면 계정이 여덟 개 걸리는 흔한 질의(`@a`)에서 집합이 목록에 아예
 * 나타나지 않는다 — 있는데 안 보이는 것이 가장 나쁜 상태다. 반대로 양쪽을 각자
 * `MAX_SUGGESTIONS` 까지 담으면 목록이 두 배가 되어 위 주석의 약속(화면을 덮지 않는다)이
 * 깨진다. 그래서 총량은 그대로 두고 집합에 앞자리 몇 개를 예약한다.
 *
 * 집합이 없는 워크스페이스에서는 예약이 0 이므로 목록은 **글자 하나도 달라지지 않는다.**
 *
 * 3 이었다 — 목록 전체가 8 줄일 때의 몫이다. 목록이 스크롤되게 된 뒤로는 그 수가
 * **집합·팀을 감추는 쪽**으로만 일했다(팀이 넷인데 셋만 서는 화면). 그래서 뜻을 바꿔
 * 목록의 절반으로 둔다: 집합·팀이 목록을 다 차지하는 것은 막고(나머지 절반은 늘 계정
 * 자리다), 그 아래에서는 있는 것을 다 보인다.
 */
const MAX_GROUP_SUGGESTIONS = MAX_SUGGESTIONS / 2;

/** 에이전트를 먼저 세운다 — murmur 에서 @ 를 치는 주된 이유다. 그 안에서는 이름순. */
function rank(a: AccountView, b: AccountView): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  return a.handle.localeCompare(b.handle);
}

/**
 * **이 채널이 데리고 있는 에이전트를 맨 위에 세운다**(마이그레이션 048 의 `available`).
 *
 * 목록을 자르지 않고 순서만 바꾸는 이유: 다른 에이전트를 못 부르게 하는 것이 아니다
 * (멘션은 전역이고 그래야 한다). 이 채널에 처음 들어온 사람이 **여기서 누구를 부르면
 * 되는지**를 목록의 첫 줄에서 읽게 하는 것이 전부다.
 *
 * `channelHandles` 가 비면 비교가 늘 무승부라 `rank` 그대로다 — 자동 멘션이 없는 채널의
 * 목록은 글자 하나도 달라지지 않는다.
 */
function rankWithChannelFirst(channelHandles: readonly string[]) {
  return (a: AccountView, b: AccountView): number => {
    const inA = channelHandles.includes(a.handle.toLowerCase());
    const inB = channelHandles.includes(b.handle.toLowerCase());
    if (inA !== inB) return inA ? -1 : 1;
    return rank(a, b);
  };
}

/**
 * 서버가 준 사유를 사람이 읽을 문구로. `ApiError` 는 사유를 `message` 에 들고 온다
 * (`code` 는 프로그램용이다) — 다른 예외는 기본 문구로 떨어뜨린다.
 */
function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * 클립보드에서 온 파일에 이름을 붙인다.
 *
 * 스크린샷을 붙여넣으면 OS 는 이름 없는 바이트만 준다 — 웹뷰에 따라 전부 `image.png` 하나로
 * 고정되기도 한다. 그대로 올리면 채널 파일 목록(#232)이 `image.png` 열 개가 되어 **어느 것이
 * 어느 것인지 구분할 수 없다.** 올린 순간의 시각을 이름에 박아 그 구분을 되살린다.
 *
 * 시각은 **로컬 시각**이다. UTC 를 박으면 방금 붙여넣은 사람이 자기 시계와 다른 숫자를 보고
 * 그 파일이 자기 것인지부터 의심한다 — 이름의 쓸모는 사람이 알아보는 데 있다.
 */
/**
 * 붙여넣은 **글**을 첨부 파일로 만든다(코드 전체·로그 전체를 넘기는 길).
 *
 * `.txt` 로 고정한다. 내용을 보고 `.ts`·`.py` 를 맞혀 붙이는 쪽이 친절해 보이지만, 맞히기가
 * 틀리는 순간 파일 이름이 **내용에 대한 거짓말**이 된다. 그리고 확장자를 바꿔도 얻는 것이
 * 없다: 미리보기 화이트리스트는 이미지뿐이고(`Attachments.tsx::PREVIEWABLE`), 받는 사람은
 * 어느 확장자든 내려받아 자기 편집기로 연다.
 *
 * 이름에 시각을 박는 것은 스크린샷과 같은 이유다 — 한 채널에 `pasted.txt` 가 열 개면
 * 파일 목록(#232)에서 어느 것이 어느 것인지 구분할 수 없다.
 */
export function pastedTextFile(text: string, at: Date): File {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}`
    + `-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
  // `text/plain;charset=utf-8` 로 담는다 — 한글이 든 글을 charset 없이 올리면 받는 쪽
  // 브라우저가 제 기본 인코딩으로 읽어 깨진다.
  return new File([text], `pasted-${stamp}.txt`, { type: 'text/plain;charset=utf-8' });
}

export function nameClipboardFile(file: File, at: Date, seq = 0): File {
  // 사람이 진짜 파일을 복사해 붙여넣은 경우다 — 그 이름이 시각보다 언제나 낫다.
  if (file.name && file.name !== 'image.png') return file;
  const ext = file.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}`
    + `-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
  // 한 번에 여러 장을 붙여넣으면 초까지 같다. 순번이 없으면 이름이 통째로 겹쳐서
  // 목록에서 서로를 가린다 — 첫 장만 이름을 그대로 두고 나머지에 번호를 붙인다.
  const tail = seq > 0 ? `-${seq + 1}` : '';
  return new File([file], `screenshot-${stamp}${tail}.${ext}`, { type: file.type });
}

/**
 * 후보 하나. 계정과 집합이 **한 목록에 섞여 서고 키보드도 하나**이므로, 어느 쪽에서 온
 * 항목인지를 목록을 만들 때 태그로 붙인다.
 *
 * 렌더 시점에 필드 유무(`'createdAt' in item` 같은 것)로 되짚지 않는 이유: 계정에 같은
 * 이름의 필드가 하나 생기는 순간 판정이 조용히 갈리고, 그때 깨지는 것은 타입이 아니라
 * 화면이다. 태그는 컴파일러가 지킨다.
 */
type Candidate =
  | { kind: 'account'; id: string; handle: string; account: AccountView }
  | { kind: 'group'; id: string; handle: string; group: HandleGroupRow }
  // 에이전트 팀(#172). 집합과 나란히 선다 — 둘 다 "한 이름으로 여럿을 부른다"이고,
  // 부를 수 있는 이름이 후보에 없으면 사람은 그것을 배울 방법이 없다.
  | { kind: 'team'; id: string; handle: string; team: AgentTeamRow };

const asAccountCandidates = (list: AccountView[]): Candidate[] =>
  list.map((a) => ({ kind: 'account', id: a.id, handle: a.handle, account: a }));

const asGroupCandidates = (list: HandleGroupRow[]): Candidate[] =>
  list.map((g) => ({ kind: 'group', id: g.id, handle: g.handle, group: g }));

// 팀은 `name` 을 handle 자리에 넣는다 — 서버가 그 이름을 계정 handle 과 **같은
// 네임스페이스**에 두고 같은 문법으로 검사하므로(`teamRoutes.ts` 의 `HANDLE_PATTERN`),
// 멘션으로 쓰이는 문자열은 이것 하나다.
const asTeamCandidates = (list: AgentTeamRow[]): Candidate[] =>
  list.map((t) => ({ kind: 'team', id: t.id, handle: t.name, team: t }));

interface Props {
  /**
   * 실패를 reject 로 알리면 초안을 되돌린다 — 쓴 글이 조용히 사라지지 않게.
   * 두 번째 인자는 이미 업로드된 첨부의 id 들이다(업로드는 파일을 고른 순간 끝나 있다).
   */
  onSend: (body: string, attachmentIds: string[]) => void | Promise<unknown>;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  /**
   * 고정 멘션을 담아 두는 대화의 이름. 채널을 옮기면 부르던 상대도 달라진다 —
   * 앞 채널의 에이전트를 끌고 가면 엉뚱한 곳에서 깨어난다.
   */
  scopeKey?: string;
  /**
   * 예약 발송(#222)이 글을 올릴 채널. **"이 작성창이 채널에 직접 올린다"**는 뜻이다 —
   * 없으면 예약 표면을 아예 그리지 않는다(눌러도 아무 일이 없는 죽은 버튼이 되므로).
   *
   * 스레드 작성창은 이것을 넘기지 않는다: `POST /channels/:id/scheduled` 는 스레드 뿌리를
   * 받지 않으므로, 스레드에서 예약하면 답글이 **채널 본문으로** 나가 스레드가 조용히
   * 사라진다. 그래서 자동 멘션에 필요한 채널 열쇠는 아래 `autoMentionChannelId` 로 따로
   * 받는다 — 두 뜻을 한 prop 에 얹으면 스레드에 채널을 알려 주는 순간 예약 버튼이 되살아난다.
   */
  channelId?: string;
  /**
   * 자동 멘션(#173)을 찾을 채널. 채널이 자동으로 멘션하는 에이전트를 스토어에서 찾는 열쇠다.
   *
   * `scopeKey` 와 다른 값인 이유: 스레드의 scopeKey 는 `thread:<rootId>` 지만 자동 멘션은
   * 채널의 사실이라 스레드 안에서도 그 채널의 것을 봐야 한다. 없으면 자동 멘션은 없다.
   */
  autoMentionChannelId?: string;
}

/**
 * 보낼 예정이지만 **아직 서버로 나가지 않은** 메시지(#223).
 *
 * 왜 서버 지연이 아니라 클라이언트 보류인가 — 멘션 알림은 `postMessage` 트랜잭션 **안에서**
 * 즉시 `insertInbox` 한다. 즉시 삽입을 그대로 두고 창만 UI 에 얹으면 "알림은 이미 갔는데
 * 되돌렸다는 표시만 뜨는" 거짓 안전감이 된다. 그렇다고 삽입을 미룰 수도 없다: 이 서버에는
 * 스케줄러도 지연 작업 장치도 없고, 그것을 세우는 일은 #222(예약 발송)와 같은 기반이 필요한
 * 별개의 작업이다.
 *
 * 그래서 **클라이언트가 아예 보내지 않는다.** 되돌리면 서버도, 알림도, 에이전트도 이 메시지를
 * 본 적이 없다 — 되돌리기가 정직해진다. 이슈가 걱정한 "롱폴이 즉시 반환된다"도 서버 지연
 * 방식에서만 생기는 문제라 여기서는 아예 발생하지 않는다.
 */
interface HeldMessage {
  /** 서버로 갈 본문 — 고정 멘션까지 붙은 최종형이다. */
  body: string;
  /** 사람이 직접 친 것. 되돌리면 **이것만** 입력창으로 돌아간다(접두사까지 되돌리면 다음 전송에서 두 번 붙는다). */
  typed: string;
  attachments: AttachmentRow[];
  /** 이 글을 쓴 자리. 실패해서 되돌릴 때 **쓴 자리로** 돌려놓기 위해 들고 있는다. */
  scope: string;
  /**
   * 보낼 자리를 든 함수. **타이머가 터질 때의 `onSend` prop 을 쓰면 안 된다** — 컴포저
   * 인스턴스는 채널 전환에도 살아 있어서(ChannelPane 이 같은 자리에 렌더한다) 그때의 prop 은
   * 이미 새 채널을 가리킨다. 그러면 A 에서 쓴 것이 B 로 나간다 — #184 가 닫은 결함이다.
   */
  send: Props['onSend'];
}

export function Composer({
  onSend, placeholder, rows = 2, autoFocus, scopeKey = '', channelId, autoMentionChannelId,
}: Props) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const groups = useActiveStore((s) => s.groups);
  /**
   * 스토어의 `null` 은 *"목록을 못 받았다"* 다(`appStore.ts::teams`). **후보를 만드는 이
   * 자리에서는 빈 목록이 사실이다** — 그 목록을 안 주는 서버는 `@팀` 을 해석하지도
   * 못하므로(#172 가 디렉터리와 멘션을 한 커밋에 넣었다) 지금 부를 수 있는 팀이 없다.
   * 없는 이름을 후보에 세우면 눌러서 보낸 발화가 아무도 안 깨운다.
   */
  const teams = useActiveStore((s) => s.teams) ?? NO_TEAMS;
  const myId = useActiveStore((s) => s.me?.id);
  // 채널이 자동으로 멘션하는 에이전트(#173). 키가 없으면 아직 못 받은 것이고 그때는 칩도 접두도 없다.
  const autoRows = useActiveStore((s) => (autoMentionChannelId ? s.channelAutoMentions[autoMentionChannelId] : undefined));
  // `MessageBody` 와 같은 자리에서 읽는다 — 자기 멘션 판정이 두 화면에서 달라지면 안 된다.
  const myHandle = useActiveStore((s) => s.me?.handle?.toLowerCase() ?? null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  /**
   * 고정 멘션은 **초안과 같은 자리에 산다**(#706, `appStore.ts::stickyMentions`). 지역
   * state 였을 때는 스레드 패널이 언마운트되는 것만으로 사라졌다 — 다른 채널을 한 번 누르면
   * `threadRootId` 가 `null` 이 되고 패널이 통째로 빠진다(`Workspace.tsx`). 초안은 스토어에
   * 남아 돌아오므로 사람은 글은 그대로인데 칩만 없는 입력창을 보고, 그 상태로 Enter 를 누르면
   * 아무도 깨지 않는다.
   *
   * 저장된 것(raw)과 그리는 것(`sticky`)을 갈라 둔다: 걸러내기는 화면과 접두에만 걸고,
   * **쓰기는 raw 를 기준으로** 한다(`choose`·`drop`·전송). 걸러진 목록으로 되쓰면 계정
   * 목록이 아직 안 온 순간에 보낸 한 줄이 고정을 전부 지운다.
   */
  const stickyRaw = useActiveStore((s) => s.stickyMentions[scopeKey]) ?? NO_STICKY;
  const setSticky = (handles: string[]): void => {
    useActiveStore.getState().setStickyMentions(scopeKey, handles);
  };
  /**
   * **이번 메시지에서만** 뺀 자동 멘션(#173). 칩의 × 는 설정을 지우지 않는다 — 설정은 admin 의
   * 것이고, 사람이 매번 필요한 것은 "이 한 줄은 에이전트를 부르지 않고 쓰기"다. 보내면 비운다:
   * 다음 메시지에는 다시 나타난다.
   */
  const [skippedAutoByScope, setSkippedAutoByScope] = useState<Record<string, string[]>>({});
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 코드 겹판. 입력칸이 굴러간 만큼 이 판도 옮겨야 하므로(`onScroll`) 부모가 들고 있다.
  const codeLayerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 업로드는 파일을 고른 순간 끝난다. 전송 시점에 올리면 Enter 를 누르고 기다려야 하고,
  // 실패했을 때 본문까지 붙잡힌다.
  const [pending, setPending] = useState<AttachmentRow[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /**
   * 전송이 실패한 사유. **자리별로 둔다**(`Record<scopeKey, string>`) — 초안 되돌리기가
   * 자리를 지키는 것과 같은 이유다(`dispatch` 주석). 보냄 취소 창이 도는 동안 채널을
   * 옮겼다면 실패는 **글을 쓴 그 채널**의 사실이고, 옮겨 온 채널의 컴포저에 남의 실패
   * 사유가 서면 사람은 방금 자기가 누른 것이 실패한 줄로 읽는다. 되돌아오면 복원된 초안과
   * 사유가 함께 그 자리에 있다.
   */
  const [sendErrorByScope, setSendErrorByScope] = useState<Record<string, string>>({});
  /**
   * 지금 파일이 컴포저 위에 떠 있는가. 놓을 자리를 그리는 데만 쓴다 — 표시가 없으면 사람은
   * 여기가 받는 자리인지 모른 채 손을 놓고, 그 파일은 웹뷰가 열어 앱 화면을 갈아치운다.
   */
  const [dragging, setDragging] = useState(false);
  /**
   * `dragleave` 는 **자식 위로 옮겨갈 때도** 난다. 그 한 번으로 표시를 끄면 컴포저 안에서
   * 손을 움직이는 동안 오버레이가 깜빡인다. 그래서 enter/leave 를 세어 0 이 될 때만 끈다 —
   * 그때가 경계를 실제로 벗어난 순간이다.
   */
  const dragDepth = useRef(0);
  // 마지막으로 '입력 중'을 보낸 시각. 0 이면 지금 입력 중이 아니라는 뜻이다.
  const lastTypingAt = useRef(0);
  // 삽입 후 커서를 옮겨야 한다. React 는 value 만 되돌리므로 DOM 을 직접 만진다.
  const pendingCaret = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 후보 목록(스크롤되는 상자). 키보드로 옮긴 항목을 이 안으로 끌어오는 데만 쓴다. */
  const listRef = useRef<HTMLUListElement>(null);
  const prevScopeKey = useRef(scopeKey);
  // 지금 그려진 스코프. 타이머와 언마운트 정리 함수는 렌더 클로저 밖에서 돌기 때문에
  // 그 자리에서 현재 자리를 알려면 ref 여야 한다.
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  // 대기 중인 메시지. 화면에 그리려면 state 가, 타이머·정리 함수에서 최신 값을 보려면
  // ref 가 필요하다 — 둘은 같은 것을 가리킨다.
  const [held, setHeld] = useState<HeldMessage | null>(null);
  /**
   * 붙여넣은 퍼머링크. **이동 제안을 그리기 위한 것이고, 이동 그 자체는 아니다.**
   * 붙여넣기가 곧 이동이었던 동안(#228) 링크를 인용하거나 이어서 물어보려던 사람은
   * 붙여넣을 때마다 화면이 끌려가서, 링크를 채팅에 남기는 방법이 아예 없었다.
   */
  const [pastedLink, setPastedLink] = useState<string | null>(null);
  /**
   * 고른 글 **위에** 주소를 붙여넣은 것(하이퍼링크 요청, 2026-09-10). 덮어쓴 글을 이름으로
   * 삼아 `[이름](주소)` 로 바꿀 것을 제안한다.
   *
   * **덮어쓴 글을 여기서 들고 있어야 하는 이유**: 붙여넣기의 기본 동작이 이미 그 글을
   * 지웠으므로, 붙여넣은 뒤에는 이름이 될 것이 화면 어디에도 없다. 붙여넣기 직전에
   * 선택 범위에서 읽어 두는 것이 유일한 기회다.
   *
   * 여기서도 `preventDefault` 를 하지 않는다 — 이 파일이 링크·멘션에 대해 세운 규칙
   * (*"붙여넣기는 붙여넣기로 끝난다"*)이 그대로 적용된다. 주소를 그냥 남기려던 사람의
   * 글을 붙여넣기가 조용히 링크로 고쳐 쓰면, 그 사람은 되돌릴 방법을 화면에서 찾지 못한다.
   */
  const [pastedHref, setPastedHref] = useState<PastedLink | null>(null);
  /**
   * 방금 붙여넣은 글이 **부르는 이름들**과 그 원문(2단계). 링크 제안 줄과 같은 모양의
   * 제안 줄을 세우고, 인용으로 바꾸는 버튼이 여기 담긴 원문을 초안에서 찾아 갈아 끼운다.
   *
   * 원문을 함께 드는 이유: 인용은 **붙여넣은 조각에만** 걸려야 한다. 초안 전체를 인용으로
   * 바꾸면 사람이 직접 쓴 문장과 부른 이름까지 인용에 먹혀, 정작 보내려던 호출이 사라진다.
   */
  const [pastedCalls, setPastedCalls] = useState<{ text: string; handles: string[] } | null>(null);
  /**
   * 보내기 전 확인이 필요한 다수 호출(2단계). `null` 이 아니면 겹창이 서 있고, 초안은
   * **그대로 남아 있다** — 취소하면 사람이 이름을 지우고 다시 보낼 수 있어야 한다.
   */
  const [manyCalls, setManyCalls] = useState<string[] | null>(null);
  /**
   * 방금 붙여넣은 **긴 글**. 파일로 넘길 것을 제안하기 위한 것이고, 그 자체로는 아무것도
   * 하지 않는다 — 링크 제안(`pastedLink`)과 같은 규약이다.
   *
   * 글자를 그대로 들고 있는 이유: 파일로 옮길 때 **초안에서 그 부분만** 지워야 하는데,
   * 위치(offset)로 들고 있으면 그 뒤에 한 글자만 쳐도 어긋난다. 글자 자체를 들고 있으면
   * 초안에 아직 있는지도(`draft.includes`) 같은 값으로 판정된다.
   */
  const [pastedText, setPastedText] = useState<string | null>(null);
  /** 파일로 올리는 중. 두 번 누르면 같은 글이 두 개 붙는다. */
  const [movingToFile, setMovingToFile] = useState(false);
  const heldRef = useRef<HeldMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 예약 발송 상태(#222)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [scheduleMin, setScheduleMin] = useState('');
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessageView[]>([]);
  const [scheduledExpanded, setScheduledExpanded] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);

  // 초안은 **스코프 키로 스토어에 산다.** 지역 state 로 두면 컴포넌트 인스턴스가 채널
  // 전환에도 유지되기 때문에(ChannelPane 이 같은 자리에 렌더한다) A 에 쓴 글이 B 입력창에
  // 남고 B 로 나간다 — 그게 #184 다. 스토어가 영속까지 책임진다.
  const draft = useActiveStore((s) => s.drafts[scopeKey] ?? '');
  const setDraftLocal = (next: string | ((current: string) => string)): void => {
    const store = useActiveStore.getState();
    const current = store.drafts[scopeKey] ?? '';
    store.setDraft(scopeKey, typeof next === 'function' ? next(current) : next);
  };

  // #142 의 잔여 증상: 스코프가 바뀌면 자동완성 목록을 닫는다. 초안과 달리 **복원하지
  // 않는다** — 채널을 옮긴 직후에 남의 후보 목록이 떠 있으면 안 된다.
  useEffect(() => {
    if (prevScopeKey.current === scopeKey) return;
    prevScopeKey.current = scopeKey;
    // 채널을 옮기는 것도 화면을 떠나는 것이다 — 대기 중인 것을 여기서 내보낸다(#223).
    // 항목이 자기 자리를 들고 있으므로 **옮기기 전 채널로** 나간다.
    flushRef.current();
    setQuery(null);
    setPicking(false);
    setActive(0);
    // 이동 제안은 초안과 달리 **복원하지 않는다** — 옮겨 온 채널의 초안에 없는 링크를
    // 가리키는 버튼이 남으면, 누른 사람은 자기가 방금 붙여넣은 것으로 읽는다.
    setPastedLink(null);
    // 파일 제안도 같다 — 남의 채널에 붙여넣은 글을 이 채널의 첨부로 만들면 안 된다.
    setPastedText(null);
  }, [scopeKey]);

  // 예약 메시지 목록 조회(#222). 채널이 바뀔 때마다 새로 받는다.
  //
  // 실패를 **빈 배열로 삼키지 않는다**: 조회가 실패한 것과 예약이 하나도 없는 것은
  // 사람에게 같은 화면이면 안 된다 — "예약이 사라졌다"로 읽힌다. 앞 채널의 목록이
  // 남지 않게 비우고, 사유를 줄로 남긴다.
  useEffect(() => {
    if (!channelId) return;
    let alive = true;
    setListError(null);
    getController().api.scheduledMessages(channelId)
      .then((rows) => { if (alive) setScheduledMessages(rows); })
      .catch((err: unknown) => {
        if (!alive) return;
        setScheduledMessages([]);
        setListError(errorText(err, t('composer.schedule.listFailed')));
      });
    return () => { alive = false; };
  }, [channelId]);

  /**
   * 자동 멘션 handle(#173). 디렉터리에서 그 계정을 다시 확인한다 — 설정된 뒤 비활성화된
   * 에이전트는 붙이지 않는다(깨어나지 못하는 상대를 매 줄에 붙이면 죽은 handle 만 남는다).
   * 고정 멘션이 "계정이 사라지면 빠진다"는 것과 같은 규칙이다.
   */
  const liveAutoRows = useMemo(
    () => (autoRows ?? [])
      .filter((r) => { const a = accounts[r.agentAccountId]; return !!a && !a.disabled && a.id !== myId; }),
    [autoRows, accounts, myId],
  );
  /** 매 줄에 접두가 붙는 에이전트(`always`). 지금까지의 자동 멘션이 이것이다. */
  const autoHandles = useMemo(
    () => liveAutoRows.filter((r) => r.mode === 'always').map((r) => r.handle.toLowerCase()),
    [liveAutoRows],
  );
  /**
   * 접두는 붙지 않지만 **이 채널이 데리고 있는** 에이전트(`available`). 눌러서 부른다 —
   * 누르면 고정 칩이 되고(`choose` 와 같은 자리), 그때부터는 사람이 부른 것과 구분되지
   * 않는다. 그것이 맞다: 부른 것은 사람이다.
   */
  const availableHandles = useMemo(
    () => liveAutoRows.filter((r) => r.mode === 'available').map((r) => r.handle.toLowerCase()),
    [liveAutoRows],
  );
  const matches = useMemo((): Candidate[] => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    const groupMatches = groups
      .filter((g) => g.handle.toLowerCase().startsWith(q))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, MAX_GROUP_SUGGESTIONS);
    /**
     * 팀도 같은 예약 자리를 쓴다(#172). 집합과 **합쳐서** `MAX_GROUP_SUGGESTIONS` 개다 —
     * 각자 세 자리를 주면 총량이 늘어 `MAX_GROUP_SUGGESTIONS` 주석의 약속(목록이 화면을
     * 덮지 않는다)이 깨진다. 팀이 뒤 자리를 받는 것은 아래 정렬 순서와 같은 이유다.
     *
     * **이름이 집합과 겹치면 팀을 후보에서 뺀다.** 세 네임스페이스가 배타가 아니라는 것을
     * 서버 테스트가 고정했고(`teamMention.test.ts`), 겹친 이름을 부르면 서버는 집합을
     * 펼친다(`services/messages.ts` 의 해석 순서: 계정 → 집합 → 팀). 그때 후보에 팀이
     * 서면 그것을 골라 보낸 사람은 자기가 부른 것과 다른 명단이 깨는 것을 본다 — 후보는
     * 알림이 가는 쪽을 따라야 한다(`bodyRecipients` 의 같은 원칙).
     */
    const groupNames = new Set(groups.map((g) => g.handle.toLowerCase()));
    const teamMatches = teams
      .filter((t) => t.name.toLowerCase().startsWith(q) && !groupNames.has(t.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_GROUP_SUGGESTIONS - groupMatches.length);
    const reserved = groupMatches.length + teamMatches.length;
    const accountMatches = Object.values(accounts)
      // 비활성 계정은 부를 수 없다 — 디렉터리에는 남아 있다(과거 메시지의 작성자 이름을
      // 풀어야 하므로). 후보에서 빼는 것이 이쪽 책임이다(shared 의 AccountView.disabled 주석).
      .filter((a) => a.id !== myId && !a.disabled && a.handle.toLowerCase().startsWith(q))
      .sort(rankWithChannelFirst(availableHandles))
      .slice(0, MAX_SUGGESTIONS - reserved);
    // 계정이 먼저, 집합·팀이 뒤다 — 사람·에이전트를 부르는 것이 흔한 쪽이고, 여럿을
    // 부르는 이름은 목록 아래에 모여 있어야 "이 아래는 여러 명"이라고 한눈에 읽힌다.
    return [
      ...asAccountCandidates(accountMatches),
      ...asGroupCandidates(groupMatches),
      ...asTeamCandidates(teamMatches),
    ];
  }, [accounts, groups, teams, myId, query, availableHandles]);

  // 고정 칩이 살아남는 조건 — 없는 이름을 붙이면 멘션이 아니라 그냥 글자다. 팀도
  // 부를 수 있으므로 여기 든다(#172).
  const known = useMemo(
    () => new Set([
      ...Object.values(accounts).filter((a) => a.id !== myId).map((a) => a.handle.toLowerCase()),
      ...groups.map((g) => g.handle.toLowerCase()),
      ...teams.map((t) => t.name.toLowerCase()),
    ]),
    [accounts, groups, teams, myId],
  );

  const skippedAuto = skippedAutoByScope[scopeKey] ?? [];
  /** 이번 메시지에 실제로 붙을 자동 멘션 — 설정에서 이번만 뺀 것을 제하고 남은 것. */
  const autoActive = useMemo(
    () => autoHandles.filter((h) => !skippedAuto.includes(h)),
    [autoHandles, skippedAuto],
  );

  // 계정이 사라지면 고정도 사라진다 — 없는 handle 을 붙이면 멘션이 아니라 그냥 글자다.
  // 자동 멘션인 handle 은 고정에서 뺀다 — 같은 상대에 칩이 둘 서면 × 하나로 어느 쪽이
  // 빠지는지 알 수 없다. 자동 칩이 그 자리를 대신한다.
  const sticky = useMemo(
    () => stickyRaw.filter((h) => known.has(h) && !autoHandles.includes(h)),
    [stickyRaw, known, autoHandles],
  );

  /**
   * **서버로 나갈 본문 그 자체** — 자동·고정 멘션 접두까지 붙은 것이다. 길이를 여기서 재는
   * 이유: 접두는 발송 시점에 본문에 들어가므로(`send` 의 `withStickyMentions`), 사람이 친
   * 글자만 세면 화면은 여유가 있다고 보고 서버는 상한을 넘겼다고 거절한다. **같은 함수로
   * 만든 같은 문자열**을 재는 것이 그 어긋남을 없애는 유일한 방법이다.
   */
  /**
   * 지금 눌러서 부를 수 있는 채널 에이전트. 이미 고정된 것은 뺀다 — 눌러도 달라지는 것이
   * 없는 버튼은 눌러 보고서야 그것을 알게 된다.
   */
  const callableChannelAgents = useMemo(
    () => availableHandles.filter((h) => !sticky.includes(h)),
    [availableHandles, sticky],
  );

  const outgoing = useMemo(
    () => withStickyMentions(draft, [...autoActive, ...sticky]),
    [draft, autoActive, sticky],
  );
  const overBy = outgoing.length - MAX_MESSAGE_BODY_CHARS;
  const tooLong = overBy > 0;
  const sendError = sendErrorByScope[scopeKey] ?? null;

  // 아래 두 목록은 `MessageBody` 가 `splitMentions` 에 주는 것과 **같은 인자**다(#278).
  // 자기 계정도 뺀 것이 없다 — 인자가 달라지면 같은 함수를 써도 판정이 갈라진다.
  const allHandles = useMemo(() => Object.values(accounts).map((a) => a.handle), [accounts]);
  /**
   * `splitMentions`·`bodyRecipients` 가 "여럿을 부르는 이름" 으로 볼 목록. **집합과 팀을
   * 한 배열로 준다**(#172).
   *
   * 인자를 하나 더 늘리지 않는 이유: 그 두 함수가 이 목록으로 하는 일은 *"이것은 한 사람이
   * 아니다"* 하나다(`isGroup` → `kind: 'group'`). 팀에도 그 판정이 똑같이 맞으므로 종류를
   * 나눠 넘기면 두 함수가 쓰지 않는 구분을 실어 다니게 되고, `splitMentions` 주석이 경고한
   * "새 인자는 더한다, 끼우지 않는다" 를 지키느라 서명만 길어진다. 종류가 실제로 필요한
   * 곳은 **수를 세는 자리**뿐이고, 거기서는 `calledGroups` 가 두 목록을 따로 받는다.
   */
  const groupHandleList = useMemo(
    () => [...groups.map((g) => g.handle), ...teams.map((t) => t.name)],
    [groups, teams],
  );

  // 지금 본문이 부를 상대(#278). 판정은 `bodyRecipients` 하나에 있고 그것은 `MessageBody`
  // 와 같은 `splitMentions` 를 쓴다 — 여기에 조건을 더하면 그 단일 판정이 깨진다.
  //
  // **고정된 handle 을 빼지 않는다.** 칩은 사람이 명시적으로 고정한 것이고 이 줄은 본문에서
  // 해석된 것이다. 겹칠 때 이 줄에서 지우면 이 줄이 고정 상태에 따라 달라져 "본문 기준" 이
  // 아니게 되고, 칩을 지우는 순간 항목이 갑자기 나타난다.
  const bodyMentionList = useMemo(
    () => bodyRecipients(draft, allHandles, groupHandleList, myHandle),
    [draft, allHandles, groupHandleList, myHandle],
  );

  /**
   * handle → 구성원 수. "부를 상대" 줄이 집합 옆에 수를 적는 데 쓴다.
   *
   * 소문자 키로 두는 이유: `bodyRecipients` 는 handle 을 소문자로 낸다(`splitMentions` 이
   * 그렇게 판정한다). 원본 대소문자로 찾으면 `@Release` 를 쓴 사람의 집합에서 수가 사라진다.
   */
  const groupMemberCounts = useMemo(() => {
    // 집합을 먼저 넣고 팀이 **덮지 않게** 한다 — 이름이 겹치면 서버는 집합을 펼치므로
    // (`services/messages.ts` 의 해석 순서) 화면도 집합의 수를 말해야 한다.
    const m = new Map(groups.map((g) => [g.handle.toLowerCase(), g.memberCount]));
    for (const t of teams) {
      const key = t.name.toLowerCase();
      if (!m.has(key)) m.set(key, t.memberCount);
    }
    return m;
  }, [groups, teams]);

  // @ 버튼으로 여는 목록. 첫 줄을 보내기 전에도 상대를 정해 둘 수 있어야 한다.
  // 이미 고정된(또는 채널이 자동으로 부르는) 상대는 뺀다 — 다시 골라도 달라지는 것이 없다.
  const pickable = useMemo((): Candidate[] => {
    const groupsList = groups
      .filter((g) => !sticky.includes(g.handle.toLowerCase()))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, MAX_GROUP_SUGGESTIONS);
    // @ 버튼으로 여는 목록도 팀을 보여야 한다 — 이 목록은 **첫 줄을 보내기 전에** 상대를
    // 정하는 자리이고, 팀이 여기 없으면 그것을 아는 사람만 손으로 칠 수 있다.
    // 겹친 이름과 예약 자리의 규칙은 위 `matches` 와 같은 것 하나다.
    const groupNames = new Set(groups.map((g) => g.handle.toLowerCase()));
    const teamsList = teams
      .filter((t) => !sticky.includes(t.name.toLowerCase()) && !groupNames.has(t.name.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_GROUP_SUGGESTIONS - groupsList.length);
    const accountsList = Object.values(accounts)
      .filter((a) => a.id !== myId
        && !sticky.includes(a.handle.toLowerCase())
        && !autoHandles.includes(a.handle.toLowerCase()))
      .sort(rankWithChannelFirst(availableHandles))
      .slice(0, MAX_SUGGESTIONS - groupsList.length - teamsList.length);
    return [
      ...asAccountCandidates(accountsList),
      ...asGroupCandidates(groupsList),
      ...asTeamCandidates(teamsList),
    ];
  }, [accounts, groups, teams, myId, sticky, autoHandles, availableHandles]);

  // 두 목록은 한자리에 뜨고 키보드도 하나다 — 동시에 열리면 Enter 가 어디로 갈지 모른다.
  const options = picking ? pickable : matches;
  // 후보가 없으면 목록은 없는 것과 같다 — Enter 를 붙잡아 두면 메시지를 못 보낸다.
  const open = options.length > 0 && (picking || query !== null);

  /**
   * 키보드로 옮긴 후보를 목록 안으로 끌어온다.
   *
   * 목록은 넘치면 스크롤되는 상자이고 강조는 `active` 라는 숫자다 — 끌어오지 않으면
   * ↓ 를 계속 누른 사람은 **화면 밖의 항목이 골라진 상태로** Enter 를 누른다. 무엇이
   * 골라졌는지 보이지 않으니 목록이 여덟 줄에서 멈춘 것처럼 읽히고(실측 신고), 마지막
   * 항목에서 첫 항목으로 돌아가는 순환(`% options.length`)도 화면에는 나타나지 않는다.
   *
   * `block: 'nearest'` 여서 **이미 보이는 항목에는 아무 일도 하지 않는다** — 마우스를
   * 목록 위로 굴리면 hover 가 `active` 를 바꾸는데(`onMouseEnter`), 여기서 매번
   * 스크롤하면 손으로 굴린 것을 코드가 되돌려 목록이 떨린다.
   *
   * jsdom 에는 `scrollIntoView` 가 없다 — 없는 환경에서 목록이 죽지 않게 옵셔널로 부른다.
   */
  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, options.length]);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [draft]);

  const closeLists = () => {
    setQuery(null);
    setPicking(false);
    setActive(0);
  };

  /**
   * #142: 포커스가 컴포저 **밖**으로 나가면 목록을 닫는다.
   *
   * 그냥 blur 로 닫을 수 없는 이유가 있다 — 아래 세 컨트롤(후보 버튼, 멘션 칩의 ×,
   * `@` 버튼)은 `onMouseDown` 에서 `preventDefault` 를 해서 **일부러 blur 를 막는다**
   * (누르는 동안 textarea 가 blur 되면 커서 자리가 사라진다). 그래서 판정은 "blur 가
   * 났나"가 아니라 **"포커스가 어디로 갔나"** 여야 한다.
   *
   * `relatedTarget` 이 `null` 인 경우도 닫는다. `related &&` 는 널 가드가 아니다 —
   * 창이 포커스를 잃거나 포커스가 body 로 가면 `null` 이고, 그때도 포커스는 컴포저
   * 밖이다.
   */
  const onContainerBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && containerRef.current?.contains(related)) return;
    closeLists();
  };

  /**
   * #142: 바깥 클릭으로도 닫는다. 위 blur 경로와 **중복이 아니다** — 포커스를 받지 않는
   * 요소(스크롤 영역, 일반 div)를 클릭하면 포커스가 이동하지 않아 blur 가 아예 발생하지
   * 않는다. 그 구멍을 이 경로가 덮는다. 둘 중 하나만 두면 목록이 남는 경우가 생긴다.
   *
   * `open` 일 때만 붙인다 — 닫혀 있을 때 document 리스너를 들고 있을 이유가 없다.
   * `open` 은 자동완성(`query`)과 `@` 버튼 목록(`picking`) 둘 다를 덮는다.
   */
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      closeLists();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  /**
   * 입력 상태를 서버에 알린다. 초안이 비면 즉시 멈춤을 보낸다 — 만료를 기다리면 지운 뒤에도
   * 몇 초 동안 '입력 중'으로 남는다.
   */
  const signalTyping = (text: string) => {
    // 입력 중 표시는 없어도 대화가 되는 기능이다. 여기서 실패가 새면 onChange 가 죽고
    // **글을 쓸 수 없게 된다** — 부가 기능이 본 기능을 막는 것은 어떤 경우에도 잘못이다.
    try {
      if (!text.trim()) {
        if (lastTypingAt.current !== 0) {
          lastTypingAt.current = 0;
          getController().notifyTyping(false);
        }
        return;
      }
      const now = Date.now();
      if (now - lastTypingAt.current < TYPING_THROTTLE_MS) return;
      lastTypingAt.current = now;
      getController().notifyTyping(true);
    } catch { /* 표시가 안 되는 것이 입력을 막는 것보다 낫다 */ }
  };

  const recompute = (text: string, caret: number | null) => {
    const nextQuery = caret === null ? null : mentionQueryAt(text, caret);
    if (query === null && nextQuery !== null) {
      // 자동완성이 열리는 순간에만 당겨온다 — 여는 동안 글자마다 부르지 않는다. 폭주 방지는
      // 컨트롤러의 최소 간격 가드가 책임진다(controller.ts::refreshAccounts).
      //
      // `.catch` 가 반드시 필요하다: refreshAccounts 는 실패를 스스로 삼키지 않고 거부된
      // 프로미스를 그대로 돌려준다(컨트롤러 내부 호출부가 전부 `swallow()` 로 감싸는 이유).
      // try/catch 는 동기 예외(컨트롤러 미초기화)만 잡지 비동기 거부는 못 잡는다 — 그것만
      // 두면 디렉터리 조회가 실패할 때마다 unhandled rejection 이 난다.
      try {
        void getController().refreshAccounts().catch(() => {});
      } catch { /* 목록을 못 갱신해도 캐시된 후보로 자동완성은 계속 동작해야 한다 */ }
    }
    setQuery(nextQuery);
    // 글을 쓰기 시작하면 @ 버튼으로 연 목록은 자리를 비켜야 한다.
    setPicking(false);
    setActive(0);
  };

  const pick = (handle: string) => {
    if (!query) return;
    const next = applyMention(draft, query, handle);
    setDraftLocal(next.text);
    pendingCaret.current = next.caret;
    // 고른 뒤에는 닫는다 — 열린 채로 두면 다음 Enter 가 전송으로 가지 못한다.
    setQuery(null);
    setActive(0);
    ref.current?.focus();
  };

  /** 목록에서 하나 고른다. @ 버튼으로 연 목록은 초안을 건드리지 않고 곧바로 고정한다. */
  const choose = (handle: string) => {
    if (!picking) return pick(handle);
    const picked = handle.toLowerCase();
    if (!stickyRaw.includes(picked)) setSticky([...stickyRaw, picked]);
    setPicking(false);
    setActive(0);
    ref.current?.focus();
  };

  const drop = (handle: string) => {
    setSticky(stickyRaw.filter((h) => h !== handle));
    ref.current?.focus();
  };

  /**
   * 채널이 데리고 있는 에이전트를 **이번 발화에** 부른다(마이그레이션 048 `available`).
   *
   * `choose` 가 `@` 버튼 목록에서 하는 것과 **같은 일**이다 — 고정 칩이 된다. 별도의
   * 상태를 만들지 않는 이유: 누른 뒤의 뜻은 "사람이 이 상대를 불렀다"이고, 그것은 이미
   * 고정 칩이 말하는 사실이다. 상태를 하나 더 두면 × 가 무엇을 지우는지가 칩마다 달라진다.
   */
  const callChannelAgent = (handle: string) => {
    if (!stickyRaw.includes(handle)) setSticky([...stickyRaw, handle]);
    ref.current?.focus();
  };

  /** 자동 멘션을 **이번 메시지에서만** 뺀다(#173). 설정은 그대로다 — 보내면 다시 나타난다. */
  const skipAuto = (handle: string) => {
    setSkippedAutoByScope((prev) => ({ ...prev, [scopeKey]: [...skippedAuto, handle] }));
    ref.current?.focus();
  };

  /**
   * 파일을 올려 대기 목록에 붙인다. 📎 로 고르든, 붙여넣든, 끌어다 놓든 **이 함수 하나를**
   * 지난다 — 경로가 셋으로 갈리면 실패 문구도, 대기 칩도, 크기 제한 안내도 셋으로 갈라지고
   * 그중 하나만 고치는 날이 온다.
   */
  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploadError(null);
    for (const file of files) {
      try {
        // 업로드는 파일을 고른 순간 끝난다. 전송 시점에 올리면 Enter 를 누르고 기다려야 하고,
        // 실패했을 때 본문까지 붙잡힌다.
        const row = await getController().upload(file);
        setPending((cur) => [...cur, row]);
      } catch {
        // 조용히 사라지면 사용자는 파일이 갔다고 믿는다.
        setUploadError(t('composer.attach.uploadFailed', { filename: file.name }));
      }
    }
  };

  const pickFiles = async (files: FileList | null) => {
    await uploadFiles(files ? Array.from(files) : []);
    // 같은 파일을 다시 고를 수 있어야 한다 — value 를 비우지 않으면 change 가 안 난다.
    if (fileRef.current) fileRef.current.value = '';
  };

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    // 막지 않으면 웹뷰가 기본 동작으로 **그 파일을 열어** 앱 화면을 통째로 갈아치운다.
    // 그 순간 쓰던 초안도 함께 사라진다.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    // 깊이를 0 으로 되돌린다 — drop 뒤에는 leave 가 오지 않으므로 빼기만으로는 남는다.
    dragDepth.current = 0;
    setDragging(false);
    void uploadFiles(Array.from(e.dataTransfer.files ?? []));
  };

  /** 대기를 끝낸다 — 타이머를 걷고 표시를 지운다. 보낼지 버릴지는 부르는 쪽이 정한다. */
  const clearHold = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    heldRef.current = null;
    setHeld(null);
  };

  /** 여기를 지나야만 메시지가 존재하기 시작한다 — 그 전에는 서버도 알림도 이 글을 모른다. */
  const dispatch = (item: HeldMessage) => {
    void Promise.resolve(item.send(item.body, item.attachments.map((a) => a.id))).catch((err: unknown) => {
      /**
       * **사유를 말한다.** 여기서 실패를 삼키면 화면에는 아무 일도 일어나지 않은 것으로
       * 보인다 — 초안만 조용히 돌아오므로, 사람은 글이 안 나갔다는 것조차 모른 채 답을
       * 기다린다. 실제로 그랬다: 8000자를 넘긴 본문은 서버가 400 으로 거절하는데 화면은
       * 침묵했다. 길이만의 문제가 아니다(보관된 채널·잘못된 첨부·끊긴 연결이 같은 길로
       * 온다). 사유는 `ApiError.message` 에 서버가 담아 준다.
       */
      setSendErrorByScope((prev) => ({
        ...prev, [item.scope]: errorText(err, t('composer.send.failed')),
      }));
      // 실패하면 사용자가 친 것만 되돌린다 — 접두사까지 남기면 다음 전송에서 두 번 붙는다.
      // **쓴 자리로** 되돌린다: 대기 중에 채널을 옮겼다면 지금 입력창은 남의 자리다.
      const store = useActiveStore.getState();
      if (!(store.drafts[item.scope] ?? '')) store.setDraft(item.scope, item.typed);
      // 첨부 목록은 그 자리에 그대로 있을 때만 되돌린다 — 파일 자체는 이미 서버에 있으므로
      // 잃는 것은 목록뿐이고, 남의 자리에 남의 첨부를 세우는 편이 더 나쁘다.
      if (item.scope === scopeRef.current) {
        setPending((current) => (current.length ? current : item.attachments));
      }
    });
  };

  /**
   * 대기 중인 것을 지금 내보낸다(#223).
   *
   * **사람이 쓴 것을 잃는 것이 가장 나쁘다.** 창이 끝나기 전에 화면을 떠나거나 앱을 닫아도,
   * 되돌린 것이 아니면 반드시 나간다.
   */
  const flush = () => {
    const item = heldRef.current;
    if (!item) return;
    clearHold();
    dispatch(item);
  };

  // 언마운트 정리 함수와 타이머는 **만들어진 시점의** flush 를 붙잡는다. 그때 대기 항목은
  // 아직 없으므로, 실제로 부를 것은 언제나 최신 flush 여야 한다.
  const flushRef = useRef(flush);
  flushRef.current = flush;

  /**
   * 되돌린다 — **서버는 이 메시지를 본 적이 없다.** 알림도, 에이전트도 마찬가지다.
   *
   * 원문을 입력창으로 돌려놓는 것까지가 되돌리기다: 되돌리는 이유는 대개 "이렇게 보내면
   * 안 됐다"이지 "안 보내고 싶다"가 아니라서, 고쳐 다시 보낼 수 있어야 한다. 그 사이에
   * 새로 쓴 글이 있으면 덮지 않는다.
   */
  const undoSend = () => {
    const item = heldRef.current;
    if (!item) return;
    clearHold();
    setDraftLocal((current) => (current ? current : item.typed));
    setPending((current) => (current.length ? current : item.attachments));
    ref.current?.focus();
  };

  /**
   * 언마운트·창 닫기에서도 내보낸다(#223). `beforeunload` 뒤에 POST 가 끝나는 것을 보장할
   * 수는 없지만, 시도조차 하지 않고 버리는 것보다 낫다.
   */
  useEffect(() => {
    const onUnload = () => { flushRef.current(); };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      flushRef.current();
    };
  }, []);

  /**
   * @param confirmed 다수 호출 확인을 이미 받았는가(겹창의 [보내기]가 참으로 다시 부른다).
   *   **초안을 겹창에 넘기지 않는다** — 여기서 되돌아가도 초안이 그대로라 같은 값이 다시
   *   계산된다. 넘기면 겹창이 뜬 사이의 편집이 무시되어, 화면에 보이는 글과 다른 글이 나간다.
   */
  const send = (confirmed = false) => {
    // 고정 멘션만으로는 보낼 것이 없다 — 빈 Enter 가 '@fizz' 하나만 던지면 사고다.
    // 다만 파일만 보내는 것은 자연스럽다.
    if (!draft.trim() && !pending.length) return;
    /**
     * 상한을 넘으면 **왕복하지 않는다.** 버튼은 이미 흐려져 있지만 Enter 는 그 버튼을 지나지
     * 않으므로 이 가드가 없으면 키보드로만 상한을 넘길 수 있다. 사유를 함께 세우는 이유는,
     * 키보드로 누른 사람은 버튼이 왜 흐려졌는지 볼 기회가 없었기 때문이다.
     */
    if (tooLong) {
      setSendErrorByScope((prev) => ({
        ...prev,
        [scopeKey]: t('composer.send.tooLong', {
          over: overBy.toLocaleString(), max: MAX_MESSAGE_BODY_CHARS.toLocaleString(),
        }),
      }));
      return;
    }
    // 다시 누른 순간 앞의 사유는 지난 일이다 — 남겨 두면 성공한 뒤에도 붉은 줄이 남는다.
    if (sendError) setSendErrorByScope((prev) => ({ ...prev, [scopeKey]: '' }));
    const typed = draft;
    /**
     * 접두는 **여기, 발송 시점에** 본문에 들어간다(#173, design.md §4 "접두는 실제 본문에
     * 들어간다"). 서버가 저장 직후 본문에 접두하는 방식은 에이전트가 MCP 로 올린 답에도
     * 접두를 붙여 그 에이전트가 자기 답에 다시 불리는 루프가 된다 — 그래서 사람이 쓰는
     * 이 작성창만 붙이고, 에이전트가 올리는 메시지에는 적용되지 않는다. 그것이 의도다.
     * 서버의 알림 판정은 이 본문을 평범한 멘션으로 읽는다. 이미 본문이 부르고 있는 handle
     * 은 `withStickyMentions` 가 건너뛴다. 자동이 먼저, 고정이 뒤다.
     */
    const body = withStickyMentions(typed, [...autoActive, ...sticky]);
    /*
      **셋 이상을 부르면 한 번 묻는다**(2단계).

      세는 것은 `body` 가 아니라 **사람이 이 줄에 쓴 글(`typed`)** 이다. 자동 멘션(#173)과
      고정 멘션은 사람이 **이미 내린 결정**이다 — 채널이 셋을 자동으로 부르도록 해 둔
      사람에게 매 발화마다 같은 확인을 내면 그 확인은 곧 눈이 감기는 장식이 되고, 그러면
      정작 붙여넣기가 넷을 부르는 날에도 반사적으로 넘긴다. 이 문이 막으려는 것은
      **이 줄에서 새로 생긴 호출**이고, 복사한 본문은 언제나 그쪽에 있다.

      `mentionedHandles` 가 인용 줄·코드 블록을 이미 걷어내므로, 붙여넣기를 인용으로
      바꾼 글은 이 문에 걸리지 않는다 — 두 장치가 같은 판정 위에 서 있다는 뜻이다.
    */
    const calls = callsInText(typed, known);
    if (!confirmed && calls.length >= MANY_CALLS) { setManyCalls(calls); return; }
    setManyCalls(null);
    const attachments = pending;
    // 앞의 것이 아직 대기 중이면 **먼저 내보낸다.** 한 번에 하나만 들 수 있으므로 덮으면
    // 앞의 글을 잃고, 사람이 친 순서도 이 편이 지켜진다.
    flush();
    // 초안을 먼저 비우는 이유는 창이 도는 동안에도 다음 글을 쓸 수 있어야 하기 때문이다.
    setDraftLocal('');
    setPending([]);
    setQuery(null);
    // 보냈으면 입력이 끝났다. 만료를 기다리면 자기 메시지 아래에 '입력 중'이 남는다.
    lastTypingAt.current = 0;
    try { getController().notifyTyping(false); } catch { /* 위와 같은 이유 */ }
    // 이번에 부른 상대는 다음 줄부터 고정이다. 한 번 부른 뒤 매번 @ 를 다시 치게 하면
    // 사용자는 잊어버리고, 잊으면 에이전트는 깨어나지 않는다.
    setSticky(keepMentioned(stickyRaw, typed, known));
    // 이번만 뺀 자동 멘션은 이 메시지로 끝이다 — 다음 줄에는 다시 붙는다(#173).
    if (skippedAuto.length) setSkippedAutoByScope((prev) => ({ ...prev, [scopeKey]: [] }));

    // `onSend` 를 **지금** 붙잡는다. 타이머가 터질 때 읽으면 그 사이 옮긴 채널을 가리킨다.
    const item: HeldMessage = { body, typed, attachments, scope: scopeKey, send: onSend };
    const windowMs = undoSendStorage.loadWindowMs();
    // 0 이면 창을 끈 것이다 — 예전처럼 누른 즉시 나간다.
    if (windowMs <= 0) {
      dispatch(item);
      return;
    }
    heldRef.current = item;
    setHeld(item);
    timerRef.current = setTimeout(() => { flushRef.current(); }, windowMs);
  };

  /**
   * 붙여넣기는 **붙여넣기로 끝난다.** 퍼머링크 하나만 붙여넣어도 글자가 그대로 초안에
   * 들어가고, 이동은 그 아래 제안 줄의 버튼을 누를 때만 일어난다.
   *
   * 왜 뒤집었나: #228 은 붙여넣기 자체를 이동으로 삼았다. 그래서 "이 스레드 이어서
   * 보자"고 링크를 **채팅에 남기려는** 사람은 붙여넣을 때마다 화면이 끌려가고 글자는
   * 들어가지 않아, 링크를 붙여넣는 것 자체가 불가능했다. 이동은 되지만 인용이 안 되면
   * 링크는 반쪽이다 — 그리고 이동은 명시적인 행동일 때 잃는 것이 없다.
   *
   * 판정은 그대로 `parseMessagePermalink` 다. 그 함수는 **전체 일치만** 링크로 보므로
   * 문장 속에 섞인 링크에는 제안이 서지 않는다 — 그 경우는 애초에 인용이다.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text');
    /**
     * 클립보드에 파일이 들어 있으면 첨부로 올린다 — 스크린샷 붙여넣기가 이 길로 온다.
     *
     * **글자가 함께 있으면 손대지 않는다.** 표·문서·에디터에서 글을 복사하면 많은 앱이 같은
     * 클립보드에 그림 표현(`image/png`)을 함께 싣는다. 파일이 있다는 이유만으로 가로채면
     * 문장을 붙여넣으려던 사람이 난데없이 이미지 첨부를 받고 글은 들어가지 않는다 — 잃는
     * 쪽이 훨씬 크다. 스크린샷 클립보드에는 글자가 없으므로 이 한 줄로 갈린다.
     */
    const files = Array.from(e.clipboardData.files ?? []);
    if (files.length && !text.trim()) {
      // 가로챘으면 기본 동작을 막는다. 애초에 들어갈 글자는 없지만, 웹뷰가 이미지를
      // 제 나름대로 처리하려 드는 것까지 여기서 끊는다.
      e.preventDefault();
      // 시각은 **한 번만** 읽는다. 장마다 다시 읽으면 초 경계를 넘는 순간 한 붙여넣기가
      // 두 시각으로 갈려서, 같이 온 것들이 목록에서 떨어져 보인다.
      const at = new Date();
      void uploadFiles(files.map((f, i) => nameClipboardFile(f, at, i)));
      return;
    }
    /*
      **붙여넣은 글이 누구를 부르는지 알려 준다**(2단계). 여기서도 `preventDefault` 를
      하지 않는다 — 글자는 웹뷰가 그대로 넣고, 인용으로 바꾸는 것은 제안 줄의 버튼을
      누를 때만 일어난다. 이 파일이 링크에 대해 세운 규칙(*"붙여넣기는 붙여넣기로
      끝난다"*)을 멘션에도 같게 적용하는 것이다: 붙여넣기가 사람 글을 조용히 고쳐 쓰면,
      인용이 싫은 사람은 되돌릴 방법을 화면에서 찾지 못한다.

      부를 이름이 없으면 줄을 세우지 않는다 — 평범한 붙여넣기에 매번 줄이 뜨면 그 줄은
      곧 아무도 안 읽는 장식이 된다.
    */
    const calls = callsInText(text, known);
    if (calls.length) setPastedCalls({ text, handles: calls });
    /*
      **고른 글 위에 주소를 붙여넣었으면 링크로 만들 것을 제안한다.** 선택 범위는 지금
      읽어야 한다 — 기본 동작이 곧 그 글을 주소로 갈아 끼우므로, 이 줄 뒤에는 이름이 될
      글자가 남아 있지 않다.

      `linkFromPaste` 가 `null` 이면 줄을 세우지 않는다: 고른 것이 없거나(평범한 붙여넣기다)
      여러 줄이거나(링크 이름은 한 줄이다) 붙여넣은 것이 열리는 주소가 아닌 경우다.
    */
    const el = e.currentTarget;
    const offer = linkFromPaste(
      el.value.slice(el.selectionStart, el.selectionEnd),
      text,
      el.selectionStart,
    );
    if (offer) setPastedHref(offer);
    /**
     * 긴 글은 **파일로 넘길 길을 제안한다**(막지 않는다 — 글자는 그대로 들어간다).
     * 판정을 붙여넣은 조각으로 하는 이유: 초안 전체 길이로 재면 여러 번 나눠 붙여넣거나
     * 길게 쓴 글에도 제안이 서는데, 사람이 직접 쓴 글은 파일로 옮길 대상이 아니다.
     * 옮길 만한 것은 **한 덩어리로 온 것**(코드 파일·로그·문서 전체)이다.
     */
    if (text.length >= PASTE_AS_FILE_CHARS) setPastedText(text);
    const messageId = parseMessagePermalink(text);
    // 링크가 아니면 아무것도 하지 않는다 — 평범한 붙여넣기다.
    if (!messageId) return;
    // **기본 동작을 막지 않는다.** 글자는 웹뷰가 넣고, 우리는 이동할 길만 열어 둔다.
    setPastedLink(messageId);
  };

  /**
   * 붙여넣은 링크로 **실제로** 이동한다. 이 자리를 부르는 것은 제안 줄의 버튼 하나뿐이다 —
   * 이동이 일어나는 지점이 한 곳이어야 "내가 눌렀을 때만 간다"가 화면에서도 참이 된다.
   *
   * 초안은 **그대로 둔다.** 이동은 링크를 소비하는 것이 아니다 — 갔다 와서 그 링크를
   * 인용해 글을 쓸 수도 있고, 지우는 것은 사람이 할 일이다.
   */
  const openPastedLink = (messageId: string): void => {
    let controller: ReturnType<typeof getController> | null = null;
    try { controller = getController(); } catch { /* 아직 없다 — 누를 것도 없었던 셈이다 */ }
    // 제안은 눌린 순간 역할이 끝난다. 이동에 실패해도 다시 세워 두지 않는다 —
    // 사유는 아래에서 줄로 말하고, 남은 링크는 초안에 그대로 있다.
    setPastedLink(null);
    if (!controller) return;
    // 링크가 가리키는 메시지를 못 여는 사유(사라짐·볼 수 없음·연결 실패)는 openMessage 가
    // 스스로 사람 앞에 세운다. 여기서 남는 것은 그보다 뒤에서 터진 경우(채널·스레드를
    // 여는 중 연결이 끊김)뿐이고, 그것도 조용히 삼키면 링크를 누른 사람은 앱이 멈춘 줄 안다.
    void controller.openMessage(messageId).catch(() => {
      useActiveStore.getState().set({
        notice: 'Could not open that message. Check your connection and try again.',
      });
    });
  };

  /**
   * 이동 제안을 그릴 것인가. **초안에서 파생한다** — 붙여넣은 링크를 지운 사람에게
   * 제안이 남아 있으면 그 버튼은 초안에 없는 것을 가리킨다.
   */
  const linkOffer = pastedLink && draft.includes(messagePermalink(pastedLink)) ? pastedLink : null;
  /*
    붙여넣은 조각이 **아직 초안에 그대로 있을 때만** 제안한다. 링크 제안(`linkOffer`)이
    같은 판정을 쓰는 이유와 같다: 사람이 지웠거나 고쳐 쓴 뒤에도 줄이 남아 있으면, 그
    줄의 버튼은 찾을 수 없는 글을 인용하려 든다.
  */
  const callOffer = pastedCalls && draft.includes(pastedCalls.text) ? pastedCalls : null;
  /**
   * 링크로 만들 것을 제안할까. **적용해 봐서 판정한다** — `applyPastedLink` 가 `null` 이면
   * 붙여넣은 주소가 초안에 더는 없다는 뜻이고, 그때 이 줄의 버튼은 없는 글을 가리킨다
   * (`linkOffer`·`callOffer` 와 같은 규약이다: 제안은 초안에서 파생한다).
   */
  const hrefOffer = pastedHref && applyPastedLink(draft, pastedHref) ? pastedHref : null;
  /**
   * 붙여넣은 주소를 `[이름](주소)` 로 갈아 끼운다. 커서는 링크 **뒤**로 둔다 — 이름과
   * 주소가 둘 다 채워져 있어 더 채울 빈 자리가 없고, 사람은 대개 이어서 문장을 쓴다.
   */
  const makePastedLink = (offer: PastedLink): void => {
    const next = applyPastedLink(draft, offer);
    setPastedHref(null);
    if (!next) return;
    setDraftLocal(next.text);
    recompute(next.text, next.end);
    // 커서 복원은 렌더 뒤다(⌘E · `quotePastedCalls` 와 같은 이유): 초안을 바꾼 렌더가
    // 끝나기 전에 선택 범위를 주면 옛 글자 수 기준으로 잡혀 자리가 어긋난다.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };
  /**
   * 붙여넣은 조각을 인용으로 갈아 끼운다. **부르는 것을 멈추는 정본 수단**이다 —
   * 서버가 인용 줄의 `@handle` 을 부르지 않기 때문이고(#592), 그래서 이 버튼은 문구가
   * 아니라 실제 판정을 바꾼다.
   *
   * 커서는 갈아 끼운 조각의 **끝**으로 둔다. 초안 앞쪽이 길어지면 커서가 뒤로 밀려
   * 사람이 이어 쓰던 자리를 잃는다.
   */
  const quotePastedCalls = (offer: { text: string; handles: string[] }): void => {
    const at = draft.indexOf(offer.text);
    if (at < 0) { setPastedCalls(null); return; }
    const quoted = quoteText(offer.text);
    setDraftLocal(draft.slice(0, at) + quoted + draft.slice(at + offer.text.length));
    setPastedCalls(null);
    const caret = at + quoted.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  /**
   * 파일로 옮길 것을 제안할 글. 둘 중 하나다.
   *
   * - **붙여넣은 덩어리** — 아직 초안에 그대로 있을 때만이다(링크 제안과 같은 규칙:
   *   지운 글을 가리키는 버튼이 남아 있으면 안 된다).
   * - **본문 전체** — 상한을 넘긴 경우다. 이때는 붙여넣은 것이 없어도 제안한다: 사람이
   *   여러 번에 걸쳐 넣었거나 직접 쓴 글이 넘긴 것이고, 그 상태에서 사람이 할 수 있는
   *   일이 "직접 줄이기" 하나뿐이면 코드 전체를 전하려던 목적은 어차피 못 이룬다.
   */
  const fileOffer = pastedText && draft.includes(pastedText)
    ? pastedText
    : (tooLong ? draft : null);

  /**
   * 제안을 받아들인다 — 그 글을 `.txt` 첨부로 올리고 **초안에서 뺀다.**
   *
   * **올린 뒤에 뺀다.** 순서를 뒤집으면 업로드가 실패한 순간 사람이 붙여넣은 글이 어디에도
   * 없다 — 클립보드는 이미 다른 것으로 바뀌어 있을 수 있고, 그러면 통째로 잃는다.
   * 그래서 실패하면 초안은 손대지 않고 사유만 남긴다(첨부 실패와 같은 줄이다).
   */
  const moveToFile = async (text: string) => {
    if (movingToFile) return;
    setMovingToFile(true);
    setUploadError(null);
    const file = pastedTextFile(text, new Date());
    try {
      const row = await getController().upload(file);
      setPending((cur) => [...cur, row]);
      // 뺀 자리에 공백만 남기지 않는다 — 첨부만 보내는 것은 자연스럽고(서버도 허용한다),
      // 남은 초안이 공백뿐이면 전송 버튼은 첨부를 보고 살아 있다.
      setDraftLocal((current) => current.replace(text, '').trim());
      setPastedText(null);
    } catch {
      setUploadError(t('composer.attach.uploadFailed', { filename: file.name }));
    } finally {
      setMovingToFile(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // 계정이든 집합이든 본문에 들어가는 것은 `@핸들` 하나다(멘션은 본문 문자열 —
        // docs/design.md). 그래서 고르는 자리에서 둘을 갈라 다룰 것이 없다.
        choose(options[active]!.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLists();
        return;
      }
    }
    /*
      ⌘E / Ctrl+E — 고른 글을 코드로 감싸거나, 이미 코드면 벗긴다.

      **왜 열쇠 하나를 더 두는가**: 백틱을 손으로 치면 커서를 두 번 옮겨야 하고, 그 사이에
      자동완성이 열리거나 커서가 밀리면 짝이 어긋나 백틱 하나만 남는다 — 그때
      `splitCode` 는 코드가 아니라고 판정하므로(닫히지 않은 것은 코드가 아니다) 보낸 뒤에
      백틱이 그대로 보인다. 한 번에 감싸면 그 실패가 성립하지 않는다.

      `e.key === 'e'` 는 **자동완성 목록보다 뒤에 본다** — 목록이 열려 있을 때의 열쇠는
      위에서 이미 처리되고, 여기 오는 것은 글을 쓰는 중의 ⌘E 다.

      커서 복원은 `requestAnimationFrame` 뒤다(`quotePastedCalls` 와 같은 이유): 초안을
      바꾼 렌더가 끝나기 전에 선택 범위를 주면 옛 글자 수 기준으로 잡혀 자리가 어긋난다.
    */
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'e') {
      e.preventDefault();
      const el = e.currentTarget;
      const next = toggleCode(el.value, el.selectionStart, el.selectionEnd);
      setDraftLocal(next.text);
      recompute(next.text, next.end);
      requestAnimationFrame(() => {
        const box = ref.current;
        if (!box) return;
        box.focus();
        box.setSelectionRange(next.start, next.end);
      });
      return;
    }
    /*
      ⌘K / Ctrl+K — 고른 글을 링크로 감싸거나, 이미 링크면 벗긴다(하이퍼링크 요청,
      2026-09-10). ⌘E 와 같은 이유로 열쇠를 둔다: `[글자](주소)` 를 손으로 치는 것은
      기호 넷과 커서 이동 세 번이고, 그 사이에 멘션 자동완성이 열리거나 커서가 밀리면
      짝이 어긋나 링크가 아닌 대괄호만 남는다.

      **⌘K 는 브라우저·OS 의 열쇠가 아니다**(⌘L 은 주소창, ⌘K 는 웹앱들이 쓰는 자리다).
      데스크탑 앱의 입력칸이라 우리가 가져도 잃는 것이 없고, 링크에 ⌘K 를 쓰는 것은
      사람들이 이미 다른 앱에서 익힌 자리다.

      여러 줄을 고른 경우 `toggleLink` 는 `null` 이다 — 링크 이름은 개행을 넘지 못한다.
      그때 **조용히 넘기지 않고 사유를 말한다**: 눌렀는데 아무 일도 없으면 사람은 열쇠가
      없는 줄로 알거나 앱이 멈춘 줄로 안다. 초안은 손대지 않는다.
    */
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'k') {
      e.preventDefault();
      const el = e.currentTarget;
      const next = toggleLink(el.value, el.selectionStart, el.selectionEnd);
      if (!next) {
        useActiveStore.getState().set({ notice: t('composer.link.oneLine') });
        return;
      }
      setDraftLocal(next.text);
      recompute(next.text, next.end);
      requestAnimationFrame(() => {
        const box = ref.current;
        if (!box) return;
        box.focus();
        box.setSelectionRange(next.start, next.end);
      });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // 예약 발송 핸들러(#222)
  const openScheduleModal = () => {
    if (!channelId) return;
    // 기본값을 **지금**으로 두면 사람이 그대로 눌렀을 때 이미 과거라 서버가 400 을 준다.
    // 10분 뒤로 연다. `datetime-local` 은 지역 시각을 받으므로 오프셋을 빼서 채운다.
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    const min = now.toISOString().slice(0, 16);

    const at = new Date(Date.now() + 10 * 60 * 1000);
    at.setMinutes(at.getMinutes() - at.getTimezoneOffset());
    setScheduleMin(min);
    setScheduleDateTime(at.toISOString().slice(0, 16));
    setScheduleError(null);
    setScheduleModalOpen(true);
  };

  const handleSchedule = async () => {
    if (!channelId || !scheduleDateTime || !draft.trim()) return;
    // 예약 표면(`POST /channels/:id/scheduled`)은 `attachmentIds` 를 받지 않는다. 그런데도
    // 예약하고 `pending` 을 비우면 이미 업로드된 첨부가 **어디에도 안 붙은 채** 사라진다 —
    // 사람은 첨부까지 예약됐다고 믿는다. 그래서 거절하고 이유를 말한다: 첨부는 컴포저에
    // 그대로 남으므로 떼거나 지금 보내는 두 길이 다 열려 있다.
    if (pending.length > 0) {
      setScheduleError(t('composer.schedule.hasAttachments'));
      return;
    }
    const api = getController().api;
    setScheduleError(null);
    setIsScheduling(true);
    try {
      const sendAt = new Date(scheduleDateTime).toISOString();
      await api.scheduleMessage(channelId, draft, sendAt);
    } catch (err: unknown) {
      // 서버가 준 사유(`send_at_in_past`·`send_at_too_far`·`agents_cannot_schedule`)를
      // 그대로 보인다. `ApiError` 는 사유를 `message` 에 들고 오지 `error.message` 가
      // 아니다 — 초판이 그 자리를 잘못 읽어 늘 "예약에 실패했다"만 떴다.
      setScheduleError(errorText(err, t('composer.schedule.failed')));
      return;
    } finally {
      setIsScheduling(false);
    }
    setDraftLocal('');
    setScheduleModalOpen(false);
    // 목록 재조회는 **예약이 끝난 뒤의 별개 일**이다. 이것을 위 try 안에 두면 재조회
    // 실패가 `scheduleError` 로 들어가는데 모달은 이미 닫혀 있어 사유가 보이지 않는다 —
    // 예약은 성공했는데 화면에 줄이 안 뜨고 아무 말도 없는 모양이 된다. 예약 줄 쪽
    // (`listError`)에 적는다.
    try {
      setScheduledMessages(await api.scheduledMessages(channelId));
    } catch (err: unknown) {
      setListError(errorText(err, t('composer.schedule.listFailed')));
    }
  };

  const handleCancelScheduled = async (id: string) => {
    if (!channelId) return;
    const api = getController().api;
    setListError(null);
    try {
      await api.cancelScheduledMessage(id);
      setScheduledMessages(await api.scheduledMessages(channelId));
    } catch (err: unknown) {
      // 취소가 실패했는데 줄이 그대로 남으면 "눌렀는데 안 지워진다"만 보인다. 사유를 적는다.
      setListError(errorText(err, t('composer.schedule.cancelFailed')));
    }
  };

  const pendingScheduled = scheduledMessages.filter(
    (m) => !m.sentMessageId && !m.failedReason && !m.canceledAt,
  );
  const failedScheduled = scheduledMessages.filter((m) => m.failedReason);

  const listId = 'mention-suggestions';

  return (
    <div
      ref={containerRef}
      /*
        **포커스·클릭의 경계**다(#142) — 이 안에서 일어난 blur·mousedown 은 자동완성을 닫지
        않는다. 그 경계를 테스트가 집을 이름을 붙여 둔다: 예전에는 `.closest('.relative')`
        로 찾았고, 입력칸이 코드 겹판을 얹으려고 자기 `relative` 상자를 갖게 된 뒤로 그
        선택자는 **더 이상 하나를 가리키지 않는다**(안쪽 상자가 먼저 걸린다).
      */
      data-testid="composer"
      className="relative"
      onBlur={onContainerBlur}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div
          data-testid="drop-zone"
          /* 오버레이는 **이벤트를 받지 않는다**(pointer-events-none). 받으면 손이 이 위로
             들어서는 순간 컨테이너 기준으로 dragleave 가 나면서 표시가 꺼지고, 그 꺼진
             자리에 drop 이 떨어진다 — 보이는 것과 받는 것이 갈린다. */
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded border-2 border-dashed border-accent bg-accent-surface/90 font-medium text-accent"
        >
          {t('composer.attach.drop')}
        </div>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={picking ? 'Mentions to keep' : 'Mention suggestions'}
          ref={listRef}
          /* 상자가 목록의 높이를 정한다 — 후보 수는 `MAX_SUGGESTIONS` 까지 늘어나고
             넘치는 것은 여기서 스크롤된다. `vh` 를 함께 두는 이유: 고정 높이만 두면
             창이 낮을 때 목록이 화면 위로 잘려 나가고, 잘린 쪽은 스크롤로도 닿지 않는다.
             `overscroll-contain` 은 목록의 끝에서 굴린 것이 뒤의 대화를 밀지 않게 한다. */
          className="absolute bottom-full left-0 z-10 mb-1 max-h-[min(22rem,60vh)] w-72 overflow-y-auto overscroll-contain rounded border border-border bg-surface-raised py-1 shadow-lg"
        >
          {options.map((item, i) => (
            <li key={item.id}>
              <button
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                type="button"
                // 핸들을 속성으로 노출한다. 테스트가 textContent 에서 핸들을 뽑으면
                // 장식(에이전트 표시 등)이 하나 늘 때마다 깨진다 — 실제로 그랬다.
                data-handle={item.handle}
                // 계정인지 집합인지 팀인지도 속성으로 노출한다(#285·#172). 같은 이유다:
                // 배지 문구가 바뀌면 문구로 종류를 확인하던 테스트가 깨진다.
                data-kind={item.kind}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-accent-surface' : ''}`}
                // mousedown 을 막지 않으면 클릭 전에 textarea 가 blur 되어 커서 위치가 사라진다.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item.handle)}
              >
                <span className="font-medium">@{item.handle}</span>
                {item.kind === 'group' ? (
                  <>
                    <GroupBadge group={item.group} className="ml-1" />
                    {/* 집합에는 표시 이름을 함께 보인다 — `@release` 만으로는 그것이 무엇을
                        묶은 것인지 알 수 없고, 부르기 직전이 그것을 확인하는 자리다. 계정에는
                        붙이지 않는다: 사람·에이전트는 핸들이 곧 이름으로 통한다. */}
                    <span className="ml-1 truncate text-meta text-fg-subtle">{item.group.displayName}</span>
                  </>
                ) : item.kind === 'team' ? (
                  /**
                   * 팀(#172)에는 배지만 붙인다 — 팀에는 표시 이름이 없다(`AgentTeamRow` 는
                   * `name` 하나뿐이고, 그 이름이 곧 부르는 문자열이다). 없는 필드를 위해
                   * 빈 칸을 두지 않는다(규칙 06).
                   */
                  <TeamBadge team={item.team} className="ml-1" />
                ) : (
                  /* 계정 후보에는 아무것도 덧붙이지 않는다. 여기 있던 `Identity`
                     배지(🤖 + 소유자 @핸들)를 뺐다 — 화면은 부르려는 상대가 사람인지
                     에이전트인지 말하지 않는다(design doc 2, #455). 사람 후보는 이미
                     핸들만 서 있었고(#365), 이제 둘이 같은 줄로 선다. 소유자를 확인해야
                     하면 프로필(#475)을 연다. */
                  null
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/*
        이 채널이 데리고 있는 에이전트(마이그레이션 048 `available`). 칩과 **다른 줄**이다:
        칩은 "이번 글이 갈 곳"이고 이 줄은 "여기서 부를 수 있는 상대"다. 누르면 칩이 되어
        위로 옮겨 간다 — 그 이동이 눌렀다는 사실을 말한다.

        점선 테두리로 그린다. 칠해 두면 이미 부른 것처럼 읽힌다.
      */}
      {callableChannelAgents.length > 0 && (
        <ul
          data-testid="channel-agents"
          aria-label={t('composer.mention.channelAgentsLabel')}
          className="mb-1 flex flex-wrap items-center gap-1 text-meta text-fg-muted"
        >
          <li>{t('composer.mention.channelAgents')}</li>
          {callableChannelAgents.map((h) => (
            <li key={`channel:${h}`}>
              <button
                type="button"
                data-testid="channel-agent"
                data-handle={h}
                title={t('composer.mention.channelAgentTitle')}
                className="rounded border border-dashed border-border px-1.5 py-0.5 font-medium text-fg-muted hover:border-accent hover:text-accent"
                // 목록·칩의 버튼과 같은 이유로 blur 를 막는다 — 누른 뒤에도 커서는 글 안에 있어야 한다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => callChannelAgent(h)}
              >
                @{h}
              </button>
            </li>
          ))}
        </ul>
      )}
      {(autoActive.length > 0 || sticky.length > 0) && (
        <ul className="mb-1 flex flex-wrap items-center gap-1" aria-label="Kept mentions">
          {/* 자동 멘션 칩(#173). 고정 칩과 같은 줄을 쓰되 '자동' 배지와 색으로 구분한다 —
              사람이 부른 것과 채널이 부르는 것이 같아 보이면 × 가 무엇을 지우는지 알 수 없다.
              × 는 이번 메시지에서만 뺀다. 설정을 지우는 자리는 채널의 멤버 패널이다. */}
          {autoActive.map((h) => (
            <li
              key={`auto:${h}`}
              data-testid="auto-mention"
              data-handle={h}
              title={t('composer.mention.autoTitle')}
              // 멘션 칩은 **아랫단 11px** — 안의 `자동` 배지가 이미 11px 이라 칩 자체를
              // 본문단으로 두면 칩 하나 안에 두 단이 섰다. 아래 입력칸과 전송·첨부는
              // 본문단이다: 여기서 사람이 읽고 쓰는 것은 글이고, 칩은 그 글이 누구에게
              // 가는지 알려 주는 꼬리표다.
              className="flex items-center gap-1 rounded border border-accent bg-accent-surface px-1.5 py-0.5 text-meta font-medium text-accent"
            >
              <span>@{h}</span>
              <span className="rounded bg-accent px-1 text-meta font-normal text-fg-on-strong">{t('composer.mention.autoBadge')}</span>
              <button
                type="button"
                aria-label={`Skip @${h} this time`}
                className="rounded px-0.5 text-accent hover:bg-surface-hover"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => skipAuto(h)}
              >
                ×
              </button>
            </li>
          ))}
          {sticky.map((h) => (
            <li
              key={h}
              data-testid="sticky-mention"
              data-handle={h}
              className="flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-meta font-medium text-fg"
            >
              <span>@{h}</span>
              <button
                type="button"
                aria-label={`Remove @${h}`}
                className="rounded px-0.5 text-fg-subtle hover:bg-surface-hover"
                // 목록의 버튼과 같은 이유로 blur 를 막는다 — 지운 뒤에도 커서는 글 안에 있어야 한다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => drop(h)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {/*
        부를 상대(#278). 아무도 없으면 **줄 자체를 그리지 않는다** — 빈 자리를 만들면 사람은
        거기에 무엇이 있었는지를 매번 확인해야 한다.

        위의 고정 칩과 **다른 요소**다. 칩은 사람이 명시적으로 고정한 것이고 이 줄은 본문에서
        해석된 것이라 뜻이 다르다. 한 줄에 섞으면 지울 때 어느 쪽이 사라지는지 알 수 없다.

        항목에 버튼을 달지 않는 것도 그 때문이다: 이 줄의 근거는 본문이므로 여기서 지울 수
        있게 하면 본문과 화면이 어긋난다(또는 우리가 몰래 본문을 고쳐야 한다). 지우려면 본문을
        고친다 — 그것이 이 줄이 말하는 유일한 사실이다.
      */}
      {bodyMentionList.length > 0 && (
        <ul
          data-testid="body-mentions"
          aria-label={t('composer.mention.reachingLabel')}
          className="mb-1 flex flex-wrap items-center gap-1 text-meta text-fg-muted"
        >
          {/* 콜론은 **화면이 붙인다** — 언어마다 갈릴 만한 어순이 여기엔 없고,
              사전에 넣으면 그 문장부호를 번역하는 사람이 지우게 된다. */}
          <li>{t('composer.mention.reaching')}:</li>
          {bodyMentionList.map((r) => (
            <li
              key={r.handle}
              data-handle={r.handle}
              data-kind={r.kind}
              className={`flex items-center gap-0.5 font-medium ${
                r.kind === 'account' ? 'text-fg' : 'text-teal-700'
              }`}
            >
              <span>@{r.handle}</span>
              {/*
                집합·채널 전체는 **사람 하나가 아니라는 것이 보여야 한다** — `@oncall` 이
                사람 이름처럼 보이면 몇 명을 부르는지 모르고 보낸다.

                **구성원 수를 적는다.** 이 자리의 옛 주석은 *"`HandleGroupRow` 에 수가 없고"*
                라고 적었는데 그것은 이제 틀렸다 — #285 가 `memberCount` 를 **옵셔널이 아닌
                필수 필드**로 넣었고 `GET /accounts` 가 계정 목록과 함께 실어 준다. 그 필드의
                주석이 이 자리를 이름으로 지목한다: *"자동완성 후보가 `@release` 를 부르기
                직전에 그것이 한 사람인지 스무 사람인지 보여야 하는 유일한 자리"*.

                정본 문서가 요구하는 것의 **앞 절반**이 이것이다 — *"집합 호출 — 보내기 전엔
                몇 명인지, 보낸 뒤엔 누가 깼는지."* 뒤 절반은 `NotifiedGapRow` 가 맡는다.

                여전히 **명단은 받지 않는다**: `GET /handle-groups/:id` 만 명단을 주고 그
                라우트는 `requireAdmin` 이다(`handleGroupRoutes.ts:61`). 그래서 이름이 아니라
                수만 말한다 — 글자마다 명단을 조회하는 것도 이 줄이 살 값이 아니다.
              */}
              {r.kind === 'group' && (
                <span className="text-fg-subtle">
                  {t('composer.mention.groupCount', { count: groupMemberCounts.get(r.handle) ?? 0 })}
                </span>
              )}
              {r.kind === 'channel' && <span className="text-fg-subtle">{t('composer.mention.channelAll')}</span>}
            </li>
          ))}
        </ul>
      )}
      {uploadError && (
        <p role="alert" className="mb-1 text-meta text-danger">{uploadError}</p>
      )}
      {/* 전송 실패 사유. `role="alert"` 로 두어 **색을 못 보는 사람에게도** 읽힌다 —
          첨부 실패 줄과 같은 규칙이다. */}
      {sendError && (
        <p role="alert" data-testid="send-error" className="mb-1 text-meta text-danger">{sendError}</p>
      )}

      {pending.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {pending.map((a) => (
            <span
              key={a.id}
              /* 이름만 있는 칩은 **무엇을 붙였는지 확인해 주지 못한다** — 스크린샷 파일명은
                 서로 거의 같아서(`screenshot-20260908-151256.png`) 눈으로 가릴 수 없다.
                 그래서 이미지면 칩 안에 작은 그림을 세운다. 이 그림은 방금 올라간 **서버의
                 바이트**를 받아 그린다: 고른 파일이 아니라 실제로 붙은 것을 보여야 한다. */
              className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-meta text-fg"
            >
              <AttachmentThumb attachment={a} />
              {a.filename}
              <span className="text-fg-subtle">{formatSize(a.sizeBytes)}</span>
              <button
                aria-label={`Remove ${a.filename}`}
                className="rounded px-0.5 text-fg-muted hover:bg-surface-hover"
                onClick={() => setPending((cur) => cur.filter((x) => x.id !== a.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {callOffer && (
        /* 붙여넣은 글이 부르는 이름을 말하는 줄. 링크 제안 줄과 **같은 자리·같은 모양**이다 —
           둘 다 "컴포저가 지금 무엇을 들고 있는가"를 말하고, 사람은 한 자리를 익혀 둘을 읽는다. */
        <div
          role="status"
          data-testid="pasted-calls"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('composer.paste.calls', { handles: callOffer.handles.map((h) => `@${h}`).join(' ') })}
          </span>
          <button
            type="button"
            data-testid="pasted-calls-quote"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover"
            // 커서를 지킨다 — 누른 뒤에도 초안을 이어서 쓰는 사람이 있다(링크 줄과 같은 이유).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => quotePastedCalls(callOffer)}
          >
            {t('composer.paste.quote')}
          </button>
          <button
            type="button"
            data-testid="pasted-calls-dismiss"
            aria-label={t('composer.paste.keep')}
            title={t('composer.paste.keep')}
            className="rounded px-1 text-fg-muted hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPastedCalls(null)}
          >
            ×
          </button>
        </div>
      )}
      {hrefOffer && (
        /* 붙여넣은 주소를 이름 붙은 링크로 바꿀 것을 말하는 줄. 링크·호출 제안 줄과
           **같은 자리·같은 모양**이다 — 셋 다 "컴포저가 지금 무엇을 들고 있는가"를 말하고,
           사람은 한 자리를 익혀 셋을 읽는다.

           이 줄이 ⌘K 를 가르치는 자리이기도 하다. 열쇠는 눈에 보이지 않지만, 고른 글 위에
           주소를 붙여넣는 것은 사람이 이미 하는 행동이라 여기서 한 번은 마주친다. */
        <div
          role="status"
          data-testid="pasted-href"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('composer.link.pastedOver', { label: hrefOffer.label })}
          </span>
          <button
            type="button"
            data-testid="pasted-href-link"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover"
            // 커서를 지킨다 — 누른 뒤에도 초안을 이어서 쓰는 사람이 있다(다른 제안 줄과 같다).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => makePastedLink(hrefOffer)}
          >
            {t('composer.link.make')}
          </button>
          <button
            type="button"
            data-testid="pasted-href-dismiss"
            aria-label={t('composer.paste.keep')}
            title={t('composer.paste.keep')}
            className="rounded px-1 text-fg-muted hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPastedHref(null)}
          >
            ×
          </button>
        </div>
      )}
      {manyCalls && (
        /* 되돌릴 수 있는 지점에 세운 확인이다 — 보내고 나면 턴은 이미 떴고 그때는 중단밖에
           남지 않는다. `danger` 를 주지 않는 이유: 여럿을 부르는 것은 파괴가 아니라
           **비싼 일**이다. 빨간 버튼은 지우기·종료에 남겨 둔다. */
        <ConfirmDialog
          title={t('composer.paste.confirmTitle', { count: manyCalls.length })}
          detail={t('composer.paste.confirmDetail', { handles: manyCalls.map((h) => `@${h}`).join(' ') })}
          confirmLabel={t('composer.paste.confirmSend')}
          cancelLabel={t('composer.paste.confirmCancel')}
          onConfirm={() => { setManyCalls(null); send(true); }}
          onCancel={() => setManyCalls(null)}
        />
      )}
      {fileOffer && (
        /* 붙여넣기 제안 줄과 **같은 모양**이다(`pasted-link`) — 둘 다 "컴포저가 지금 무엇을
           들고 있는가"를 말하는 줄이라 사람은 한 자리를 익혀 둘을 읽는다. 상한을 넘겨
           전송이 막힌 경우 이 줄이 유일한 출구이므로, 오류 줄(`send-error`) 바로 위에
           서도록 순서를 잡았다. */
        <div
          role="status"
          data-testid="paste-as-file"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('composer.paste.long', { chars: fileOffer.length.toLocaleString() })}
          </span>
          <button
            type="button"
            data-testid="paste-as-file-move"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover disabled:opacity-40"
            // 커서를 지킨다 — 옮긴 뒤에도 초안을 이어서 쓰는 사람이 있다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void moveToFile(fileOffer)}
            disabled={movingToFile}
          >
            {movingToFile ? t('composer.paste.moving') : t('composer.paste.asFile')}
          </button>
          {/* 제안을 물린다. **상한을 넘긴 본문에는 물릴 자리를 주지 않는다** — 그때 이 줄은
              제안이 아니라 전송이 막힌 이유에 대한 답이고, 지워 두면 사람은 막힌 채로 남는다. */}
          {pastedText !== null && !tooLong && (
            <button
              type="button"
              aria-label="Dismiss long paste"
              className="rounded px-1 text-fg-muted hover:bg-surface-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPastedText(null)}
            >
              ×
            </button>
          )}
        </div>
      )}

      {linkOffer && (
        /* 붙여넣은 링크는 **글자로 남고**, 이 줄이 이동할 길이다. 대기 줄(아래)과 같은
           모양으로 두는 이유: 둘 다 "컴포저가 지금 무엇을 들고 있는가"를 말하는 줄이고,
           사람은 한 자리를 익혀 두 가지를 읽는다. */
        <div
          role="status"
          data-testid="pasted-link"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">{t('composer.link.pasted')}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover"
            // 커서를 지킨다 — 누른 뒤에도 초안을 이어서 쓰는 사람이 있다(@·첨부 버튼과 같은 이유).
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openPastedLink(linkOffer)}
          >
            {t('composer.link.open')}
          </button>
          <button
            type="button"
            aria-label="Dismiss pasted link"
            className="rounded px-1 text-fg-muted hover:bg-surface-hover"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setPastedLink(null)}
          >
            ×
          </button>
        </div>
      )}

      {held && (
        /* 대기 중인 것은 **메시지 목록에 그리지 않는다.** "서버가 받아들인 뒤에만 화면이
           바뀌므로 화면은 언제나 서버와 같다"(Reactions.tsx)는 규칙을 깨면 화면과 서버가
           갈라지고, 되돌렸을 때 목록에서 빼는 경로가 하나 더 생긴다. 그래서 대기 상태는
           컴포저 자리에만 선다. */
        <div
          role="status"
          data-testid="undo-send"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-meta text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            {t('composer.send.sending')}{' '}
            {held.typed || t('composer.send.attachmentsOnly', { count: held.attachments.length })}
          </span>
          <button
            type="button"
            aria-label="Undo send"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover"
            // 누른 뒤 원문이 입력창으로 돌아오므로 커서를 지켜야 한다 — @·첨부 버튼과 같은 이유다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={undoSend}
          >
            {t('composer.send.undo')}
          </button>
        </div>
      )}

      {/* 예약 줄(#222). **실패한 것도 세어** 연다 — 대기 중인 것이 하나도 남지 않고
          실패만 있을 때 줄 전체가 사라지면, 작성자는 자기 글이 안 나갔다는 것을 영영
          모른다. 목록 조회·취소가 실패한 경우도 여기서 말한다. */}
      {(pendingScheduled.length > 0 || failedScheduled.length > 0 || listError) && (
        <div className="mb-1 flex flex-col rounded bg-accent-surface px-2 py-1 text-meta text-accent">
          {listError && <p role="alert" className="text-danger">{listError}</p>}
          {(pendingScheduled.length > 0 || failedScheduled.length > 0) && (
            <button
              type="button"
              className="flex items-center justify-between text-left"
              aria-expanded={scheduledExpanded}
              onClick={() => setScheduledExpanded(!scheduledExpanded)}
            >
              <span>
                {t('composer.schedule.summary', { count: pendingScheduled.length })}
                {failedScheduled.length > 0
                  && t('composer.schedule.summaryFailed', { count: failedScheduled.length })}
              </span>
              <span aria-hidden="true">{scheduledExpanded ? '▼' : '▶'}</span>
            </button>
          )}
          {scheduledExpanded && (
            <div className="mt-1 flex flex-col gap-1">
              {pendingScheduled.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded bg-surface-raised px-2 py-1 text-fg">
                  <span className="min-w-0 flex-1 truncate">{m.body}</span>
                  <span className="ml-2 shrink-0 text-fg-subtle">{new Date(m.sendAt).toLocaleString()}</span>
                  <button
                    type="button"
                    aria-label={t('composer.schedule.cancelOne')}
                    className="ml-2 rounded px-1 text-danger hover:bg-danger-surface-strong"
                    onClick={() => void handleCancelScheduled(m.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {failedScheduled.map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded bg-danger-surface px-2 py-1 text-danger">
                  <span className="min-w-0 flex-1 truncate">{m.body}</span>
                  {/* 사유는 **글로도** 보여야 한다 — 색만으로 실패를 말하면 색을 못 보는
                      사람에게는 평범한 줄이다. */}
                  {/* 사유는 **서버가 준 것**이다 — 사전은 그것을 감싸는 앞말만 진다. */}
                  <span className="ml-2 shrink-0">
                    {t('composer.schedule.notSent', { reason: m.failedReason ?? '' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/*
        입력칸과 코드 겹판은 **같은 상자를 겹쳐 쓴다.** 면(`bg-field`)이 입력칸이 아니라
        이 감싸는 칸에 있는 것이 요점이다 — 입력칸은 겹판보다 나중에 그려져 위에 오므로,
        입력칸이 불투명한 면을 들고 있으면 그 아래 코드 면이 통째로 가려진다. 그래서 면은
        아래에, 글자와 테두리는 위에 둔다.
      */}
      <div className="relative rounded bg-field">
        <ComposerCode text={draft} boxRef={ref} layerRef={codeLayerRef} />
        <textarea
          ref={ref}
          /*
           * 글자와 테두리 사이의 숨 쉴 공간. `py-2`(8px) + 줄높이 `normal` 이었고, 그
           * 조합은 **두 군데서** 글자를 테두리에 붙였다: 세로 여백 자체가 8px 로 얕고,
           * 줄높이가 좁아 half-leading 이 거의 0 이라 첫 줄 윗변·마지막 줄 밑변이 테두리를
           * 스쳤다. 한글은 라틴보다 글자틀을 꽉 채워 이 압박이 더 크게 보인다.
           *
           * 그래서 둘을 같이 올린다 — 여백만 키우면 여러 줄을 쓸 때 **줄 사이**가 여전히
           * 붙어 답답하고, 줄높이만 키우면 첫/마지막 줄과 테두리 간격이 그대로다.
           * `rows` 는 줄 수를 세므로(높이를 못 박지 않는다) 칸이 줄높이만큼 함께 자란다.
           *
           * 상자 값(`COMPOSER_BOX`: 모서리·테두리 굵기·여백·줄높이)은 **겹판과 나눠 쓴다** —
           * 이 값이 갈리면 칠이 글자에서 밀린다(`ComposerCode` 의 주석이 근거다).
           * `block` 을 못박는 이유: textarea 는 기본이 inline-block 이라 아래에 베이스라인
           * 틈이 남고, 감싸는 칸에 면이 생긴 뒤로는 그 틈이 테두리 밖의 띠로 보인다.
           * `bg-transparent` 도 같은 판단의 짝이다(면은 감싸는 칸이 든다).
           */
          className={`block w-full resize-none border-border bg-transparent ${COMPOSER_BOX}`}
          rows={rows}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={draft}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setDraftLocal(e.target.value);
            recompute(e.target.value, e.target.selectionStart);
            signalTyping(e.target.value);
          }}
          // 커서만 움직여도 후보가 달라진다. 목록이 열린 동안의 화살표는 위에서 막으므로
          // 여기서 커서가 튀는 일은 없다.
          onSelect={(e) => {
            const t = e.currentTarget;
            recompute(t.value, t.selectionStart);
          }}
          // 겹판은 스크롤되지 않는 상자다(`overflow-hidden`) — 입력칸이 굴러간 만큼을
          // 그대로 옮겨 준다. 이것을 빼면 두 줄을 넘긴 초안에서 칠만 위에 남는다.
          onScroll={(e) => {
            const layer = codeLayerRef.current;
            if (layer) layer.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Add mention"
            aria-pressed={picking}
            className={`rounded px-2 py-0.5 text-fg-muted hover:bg-surface-sunken ${
              picking ? 'bg-surface-hover' : ''
            }`}
            // 누르는 동안 textarea 가 blur 되면 커서 자리가 사라진다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (picking) return closeLists();
              // 자동완성이 열려 있었다면 자리를 넘겨받는다 — 두 목록이 겹치면 안 된다.
              setQuery(null);
              setPicking(true);
              setActive(0);
            }}
          >
            @
          </button>
          {/* aria-label 은 **input** 에 붙인다. label 에 붙이면 그 요소 자신의 이름이
              될 뿐 input 과 연결되지 않아 입력이 접근 불가가 된다. */}
          <label className="cursor-pointer rounded px-2 py-0.5 text-fg-muted hover:bg-surface-sunken">
            📎
            <input
              ref={fileRef}
              type="file"
              multiple
              aria-label="Attach a file"
              className="hidden"
              onChange={(e) => void pickFiles(e.target.files)}
            />
          </label>
          {/* 예약은 채널이 있어야 건다(#222). `channelId` 가 없는 자리(스레드 답장 등
              단독 컴포저)에서 버튼을 그리면 눌러도 아무 일이 없는 죽은 버튼이 된다.
              본문이 비어 있을 때 막는 것도 전송 버튼과 같은 이유다 — 서버가 400 으로
              돌려보낼 것을 굳이 왕복시키지 않는다. */}
          {channelId && (
            <button
              type="button"
              aria-label={t('composer.schedule.later')}
              className="rounded px-2 py-0.5 text-fg-muted hover:bg-surface-sunken disabled:opacity-40"
              disabled={!draft.trim()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openScheduleModal}
            >
              🕐
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 남은 글자. **끝에서만 선다**(`BODY_COUNT_FROM`) — 넘긴 뒤에는 넘긴 양을 말한다.
              `aria-live` 를 안 붙인 이유: 글자마다 바뀌는 값이라 읽어 주면 입력을 덮는다.
              넘겼다는 사실은 위 `role="alert"` 줄이 전한다. */}
          {outgoing.length >= BODY_COUNT_FROM && (
            <span
              data-testid="body-count"
              className={`text-meta ${tooLong ? 'text-danger' : 'text-fg-subtle'}`}
            >
              {tooLong
                ? t('composer.send.over', { over: overBy.toLocaleString() })
                : t('composer.send.remaining', { remaining: (-overBy).toLocaleString() })}
            </span>
          )}
          <button
            type="button"
            aria-label="Send message"
            className="rounded-full bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover disabled:bg-border disabled:text-fg-subtle"
            // 여기는 blur 를 막지 않는다 — 전송에 성공하면 초안이 비므로 커서를 보존할
            // 이유가 없고, 실패하면 사용자가 다시 textarea 를 눌러 이어 쓴다. 반면 위
            // @·첨부 버튼은 누른 뒤에도 같은 자리에 계속 써야 하므로 막는다.
            onMouseDown={(e) => e.preventDefault()}
            /* **인자 없이 부른다.** `onClick={send}` 로 두면 클릭 이벤트가 `confirmed` 자리에
               들어가 항상 참이 되어, 다수 호출 확인이 조용히 건너뛰어진다. */
            onClick={() => send()}
            // 상한을 넘긴 채로는 누를 수 없다 — 누를 수 있게 두고 실패를 보여 주는 것보다,
            // 애초에 못 누르게 하고 얼마나 넘겼는지 옆에 세우는 것이 고칠 길을 준다.
            disabled={(!draft.trim() && !pending.length) || tooLong}
          >
            {t('composer.send.submit')}
          </button>
        </div>
      </div>
      {scheduleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-20">
          <div className="w-80 rounded-lg bg-surface-raised p-4 shadow-lg">
            {/* 겹창 제목은 **이름줄단 15px** — 화면 제목단(17px)은 화면 하나를 여는 자리
                (설정·로그인)에만 준다. 16px(`text-base`)이었고 4단 밖이었다. */}
            <h3 className="mb-3 text-name font-medium">{t('composer.schedule.title')}</h3>
            <input
              type="datetime-local"
              aria-label={t('composer.schedule.timeLabel')}
              className="mb-3 w-full rounded border border-border bg-field px-3 py-2"
              value={scheduleDateTime}
              min={scheduleMin}
              onChange={(e) => setScheduleDateTime(e.target.value)}
            />
            {scheduleError && (
              <p role="alert" className="mb-3 text-danger">{scheduleError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1 text-fg-muted hover:bg-surface-sunken"
                onClick={() => setScheduleModalOpen(false)}
              >
                {t('composer.schedule.cancel')}
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1 font-medium text-fg-on-strong hover:bg-accent-hover disabled:bg-border"
                onClick={handleSchedule}
                disabled={isScheduling || !scheduleDateTime || (scheduleMin !== '' && scheduleDateTime < scheduleMin)}
              >
                {isScheduling ? t('composer.schedule.submitting') : t('composer.schedule.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
