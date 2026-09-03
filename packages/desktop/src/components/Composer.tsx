import { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { parseMessagePermalink, type ScheduledMessageView } from '@murmur/shared';
import type { AccountView, AttachmentRow, HandleGroupRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { ApiError } from '../lib/api';
import { GroupBadge, Identity } from './Identity';
import { formatSize } from './Attachments';
import {
  mentionQueryAt, applyMention, withStickyMentions, keepMentioned, bodyRecipients,
  type MentionQuery,
} from '../lib/mention';
import { undoSendStorage } from '../lib/prefs';

/** 목록이 화면을 덮지 않을 만큼만 보여준다. 더 좁히는 것은 사용자가 글자를 더 치는 일이다. */
const MAX_SUGGESTIONS = 8;

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
 */
const MAX_GROUP_SUGGESTIONS = 3;

/** 에이전트를 먼저 세운다 — murmur 에서 @ 를 치는 주된 이유다. 그 안에서는 이름순. */
function rank(a: AccountView, b: AccountView): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  return a.handle.localeCompare(b.handle);
}

/**
 * 서버가 준 사유를 사람이 읽을 문구로. `ApiError` 는 사유를 `message` 에 들고 온다
 * (`code` 는 프로그램용이다) — 다른 예외는 기본 문구로 떨어뜨린다.
 */
function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
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
  | { kind: 'group'; id: string; handle: string; group: HandleGroupRow };

const asAccountCandidates = (list: AccountView[]): Candidate[] =>
  list.map((a) => ({ kind: 'account', id: a.id, handle: a.handle, account: a }));

const asGroupCandidates = (list: HandleGroupRow[]): Candidate[] =>
  list.map((g) => ({ kind: 'group', id: g.id, handle: g.handle, group: g }));

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
  const accounts = useAppStore((s) => s.accounts);
  const groups = useAppStore((s) => s.groups);
  const myId = useAppStore((s) => s.me?.id);
  // 채널이 자동으로 멘션하는 에이전트(#173). 키가 없으면 아직 못 받은 것이고 그때는 칩도 접두도 없다.
  const autoRows = useAppStore((s) => (autoMentionChannelId ? s.channelAutoMentions[autoMentionChannelId] : undefined));
  // `MessageBody` 와 같은 자리에서 읽는다 — 자기 멘션 판정이 두 화면에서 달라지면 안 된다.
  const myHandle = useAppStore((s) => s.me?.handle?.toLowerCase() ?? null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [stickyByScope, setStickyByScope] = useState<Record<string, string[]>>({});
  /**
   * **이번 메시지에서만** 뺀 자동 멘션(#173). 칩의 × 는 설정을 지우지 않는다 — 설정은 admin 의
   * 것이고, 사람이 매번 필요한 것은 "이 한 줄은 에이전트를 부르지 않고 쓰기"다. 보내면 비운다:
   * 다음 메시지에는 다시 나타난다.
   */
  const [skippedAutoByScope, setSkippedAutoByScope] = useState<Record<string, string[]>>({});
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 업로드는 파일을 고른 순간 끝난다. 전송 시점에 올리면 Enter 를 누르고 기다려야 하고,
  // 실패했을 때 본문까지 붙잡힌다.
  const [pending, setPending] = useState<AttachmentRow[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // 마지막으로 '입력 중'을 보낸 시각. 0 이면 지금 입력 중이 아니라는 뜻이다.
  const lastTypingAt = useRef(0);
  // 삽입 후 커서를 옮겨야 한다. React 는 value 만 되돌리므로 DOM 을 직접 만진다.
  const pendingCaret = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevScopeKey = useRef(scopeKey);
  // 지금 그려진 스코프. 타이머와 언마운트 정리 함수는 렌더 클로저 밖에서 돌기 때문에
  // 그 자리에서 현재 자리를 알려면 ref 여야 한다.
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  // 대기 중인 메시지. 화면에 그리려면 state 가, 타이머·정리 함수에서 최신 값을 보려면
  // ref 가 필요하다 — 둘은 같은 것을 가리킨다.
  const [held, setHeld] = useState<HeldMessage | null>(null);
  const heldRef = useRef<HeldMessage | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 예약 발송 상태(#222)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledMessageView[]>([]);
  const [scheduledExpanded, setScheduledExpanded] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);

  // 초안은 **스코프 키로 스토어에 산다.** 지역 state 로 두면 컴포넌트 인스턴스가 채널
  // 전환에도 유지되기 때문에(ChannelPane 이 같은 자리에 렌더한다) A 에 쓴 글이 B 입력창에
  // 남고 B 로 나간다 — 그게 #184 다. 스토어가 영속까지 책임진다.
  const draft = useAppStore((s) => s.drafts[scopeKey] ?? '');
  const setDraftLocal = (next: string | ((current: string) => string)): void => {
    const store = useAppStore.getState();
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
        setListError(errorText(err, '예약 목록을 불러오지 못했다'));
      });
    return () => { alive = false; };
  }, [channelId]);

  const matches = useMemo((): Candidate[] => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    const groupMatches = groups
      .filter((g) => g.handle.toLowerCase().startsWith(q))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, MAX_GROUP_SUGGESTIONS);
    const accountMatches = Object.values(accounts)
      // 비활성 계정은 부를 수 없다 — 디렉터리에는 남아 있다(과거 메시지의 작성자 이름을
      // 풀어야 하므로). 후보에서 빼는 것이 이쪽 책임이다(shared 의 AccountView.disabled 주석).
      .filter((a) => a.id !== myId && !a.disabled && a.handle.toLowerCase().startsWith(q))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS - groupMatches.length);
    // 계정이 먼저, 집합이 뒤다 — 사람·에이전트를 부르는 것이 흔한 쪽이고, 집합은
    // 목록 아래에 모여 있어야 "이 아래는 여러 사람"이라고 한눈에 읽힌다.
    return [...asAccountCandidates(accountMatches), ...asGroupCandidates(groupMatches)];
  }, [accounts, groups, myId, query]);

  const known = useMemo(
    () => new Set([
      ...Object.values(accounts).filter((a) => a.id !== myId).map((a) => a.handle.toLowerCase()),
      ...groups.map((g) => g.handle.toLowerCase()),
    ]),
    [accounts, groups, myId],
  );

  /**
   * 자동 멘션 handle(#173). 디렉터리에서 그 계정을 다시 확인한다 — 설정된 뒤 비활성화된
   * 에이전트는 붙이지 않는다(깨어나지 못하는 상대를 매 줄에 붙이면 죽은 handle 만 남는다).
   * 고정 멘션이 "계정이 사라지면 빠진다"는 것과 같은 규칙이다.
   */
  const autoHandles = useMemo(
    () => (autoRows ?? [])
      .filter((r) => { const a = accounts[r.agentAccountId]; return !!a && !a.disabled && a.id !== myId; })
      .map((r) => r.handle.toLowerCase()),
    [autoRows, accounts, myId],
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
    () => (stickyByScope[scopeKey] ?? []).filter((h) => known.has(h) && !autoHandles.includes(h)),
    [stickyByScope, scopeKey, known, autoHandles],
  );

  // 아래 두 목록은 `MessageBody` 가 `splitMentions` 에 주는 것과 **같은 인자**다(#278).
  // 자기 계정도 뺀 것이 없다 — 인자가 달라지면 같은 함수를 써도 판정이 갈라진다.
  const allHandles = useMemo(() => Object.values(accounts).map((a) => a.handle), [accounts]);
  const groupHandleList = useMemo(() => groups.map((g) => g.handle), [groups]);

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

  // @ 버튼으로 여는 목록. 첫 줄을 보내기 전에도 상대를 정해 둘 수 있어야 한다.
  // 이미 고정된(또는 채널이 자동으로 부르는) 상대는 뺀다 — 다시 골라도 달라지는 것이 없다.
  const pickable = useMemo((): Candidate[] => {
    const groupsList = groups
      .filter((g) => !sticky.includes(g.handle.toLowerCase()))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .slice(0, MAX_GROUP_SUGGESTIONS);
    const accountsList = Object.values(accounts)
      .filter((a) => a.id !== myId
        && !sticky.includes(a.handle.toLowerCase())
        && !autoHandles.includes(a.handle.toLowerCase()))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS - groupsList.length);
    return [...asAccountCandidates(accountsList), ...asGroupCandidates(groupsList)];
  }, [accounts, groups, myId, sticky, autoHandles]);

  // 두 목록은 한자리에 뜨고 키보드도 하나다 — 동시에 열리면 Enter 가 어디로 갈지 모른다.
  const options = picking ? pickable : matches;
  // 후보가 없으면 목록은 없는 것과 같다 — Enter 를 붙잡아 두면 메시지를 못 보낸다.
  const open = options.length > 0 && (picking || query !== null);

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
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: [...sticky, handle.toLowerCase()] }));
    setPicking(false);
    setActive(0);
    ref.current?.focus();
  };

  const drop = (handle: string) => {
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: sticky.filter((h) => h !== handle) }));
    ref.current?.focus();
  };

  /** 자동 멘션을 **이번 메시지에서만** 뺀다(#173). 설정은 그대로다 — 보내면 다시 나타난다. */
  const skipAuto = (handle: string) => {
    setSkippedAutoByScope((prev) => ({ ...prev, [scopeKey]: [...skippedAuto, handle] }));
    ref.current?.focus();
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);
    for (const file of Array.from(files)) {
      try {
        // 업로드는 파일을 고른 순간 끝난다. 전송 시점에 올리면 Enter 를 누르고 기다려야 하고,
        // 실패했을 때 본문까지 붙잡힌다.
        const row = await getController().upload(file);
        setPending((cur) => [...cur, row]);
      } catch {
        // 조용히 사라지면 사용자는 파일이 갔다고 믿는다.
        setUploadError(`${file.name} 을 올리지 못했다 (크기 제한을 넘었을 수 있다)`);
      }
    }
    // 같은 파일을 다시 고를 수 있어야 한다 — value 를 비우지 않으면 change 가 안 난다.
    if (fileRef.current) fileRef.current.value = '';
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
    void Promise.resolve(item.send(item.body, item.attachments.map((a) => a.id))).catch(() => {
      // 실패하면 사용자가 친 것만 되돌린다 — 접두사까지 남기면 다음 전송에서 두 번 붙는다.
      // **쓴 자리로** 되돌린다: 대기 중에 채널을 옮겼다면 지금 입력창은 남의 자리다.
      const store = useAppStore.getState();
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

  const send = () => {
    // 고정 멘션만으로는 보낼 것이 없다 — 빈 Enter 가 '@fizz' 하나만 던지면 사고다.
    // 다만 파일만 보내는 것은 자연스럽다.
    if (!draft.trim() && !pending.length) return;
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
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: keepMentioned(sticky, typed, known) }));
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
   * 붙여넣은 것이 **퍼머링크 하나뿐**이면 글자로 넣지 않고 그 메시지로 이동한다(#228).
   * 이 자리가 없으면 "Copy link" 는 어디에도 쓸 수 없는 문자열만 만든다 — 누를 수 있고,
   * 성공했다고 말하고, 결과물은 쓸 데가 없는 거짓 신호다(design.md §4).
   *
   * 판정은 `parseMessagePermalink` 에 맡긴다. 그 함수는 **전체 일치만** 링크로 보므로
   * 문장 속에 섞인 링크는 여기서 걸리지 않는다 — 그게 맞다. 인용하려고 문장째 붙여넣은
   * 사람을 끌고 가면 쓰던 글을 잃는다.
   *
   * 컨트롤러를 **먼저** 잡고 나서 기본 동작을 막는다. 순서가 뒤바뀌면 아직 컨트롤러가
   * 없는 순간에 붙여넣은 글자만 사라지고 이동도 못 한다 — 둘 다 잃는 것이 가장 나쁘다.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const messageId = parseMessagePermalink(e.clipboardData.getData('text'));
    // 링크가 아니면 아무것도 하지 않는다 — 평범한 붙여넣기다.
    if (!messageId) return;
    let controller: ReturnType<typeof getController> | null = null;
    try { controller = getController(); } catch { /* 아직 없다 — 평범한 붙여넣기로 둔다 */ }
    if (!controller) return;
    // 가로챘으면 초안에 넣지 않는다 — 이동하면서 남은 글자가 초안을 더럽힌다.
    e.preventDefault();
    // 링크가 가리키는 메시지를 못 여는 사유(사라짐·볼 수 없음·연결 실패)는 openMessage 가
    // 스스로 사람 앞에 세운다. 여기서 남는 것은 그보다 뒤에서 터진 경우(채널·스레드를
    // 여는 중 연결이 끊김)뿐이고, 그것도 조용히 삼키면 링크를 누른 사람은 앱이 멈춘 줄 안다.
    void controller.openMessage(messageId).catch(() => {
      useAppStore.getState().set({
        notice: 'Could not open that message. Check your connection and try again.',
      });
    });
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
    const at = new Date(Date.now() + 10 * 60 * 1000);
    at.setMinutes(at.getMinutes() - at.getTimezoneOffset());
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
      setScheduleError('첨부가 붙은 메시지는 예약할 수 없다 — 첨부를 떼거나 지금 보내라');
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
      setScheduleError(errorText(err, '예약에 실패했다'));
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
      setListError(errorText(err, '예약 목록을 불러오지 못했다'));
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
      setListError(errorText(err, '예약을 취소하지 못했다'));
    }
  };

  const pendingScheduled = scheduledMessages.filter(
    (m) => !m.sentMessageId && !m.failedReason && !m.canceledAt,
  );
  const failedScheduled = scheduledMessages.filter((m) => m.failedReason);

  const listId = 'mention-suggestions';

  return (
    <div ref={containerRef} className="relative" onBlur={onContainerBlur}>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={picking ? 'Mentions to keep' : 'Mention suggestions'}
          className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-72 overflow-y-auto rounded border border-border bg-surface-raised py-1 shadow-lg"
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
                // 계정인지 집합인지도 속성으로 노출한다(#285). 같은 이유다: 배지 문구가
                // 바뀌면 문구로 종류를 확인하던 테스트가 깨진다.
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
                    <span className="ml-1 truncate text-[10px] text-fg-subtle">{item.group.displayName}</span>
                  </>
                ) : (
                  <>
                    {/* 거터가 아니라 **핸들 옆** 자리다(#277) — 여기서 소유자를 지우면 "누구의
                        에이전트를 부르는지"를 부르기 직전에 못 보게 된다. variant 는 badge. */}
                    <Identity account={item.account} className="ml-1" variant="badge" />
                  </>
                )}
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
              title="이 채널이 자동으로 멘션한다"
              className="flex items-center gap-1 rounded border border-accent bg-accent-surface px-1.5 py-0.5 text-xs font-medium text-accent"
            >
              <span>@{h}</span>
              <span className="rounded bg-accent px-1 text-[10px] font-normal text-fg-on-strong">자동</span>
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
              className="flex items-center gap-1 rounded bg-surface-sunken px-1.5 py-0.5 text-xs font-medium text-fg"
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
          aria-label="부를 상대"
          className="mb-1 flex flex-wrap items-center gap-1 text-xs text-fg-muted"
        >
          <li>부를 상대:</li>
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

                구성원 수는 여기서 낼 수 없다: `HandleGroupRow` 에 수가 없고 데스크탑은
                명단을 받지 않는다(`listHandleGroupMembers` 는 서버 전용). 글자마다 명단을
                조회하는 것은 이 줄이 살 값이 아니다.
              */}
              {r.kind === 'group' && <span className="text-fg-subtle">(집합)</span>}
              {r.kind === 'channel' && <span className="text-fg-subtle">(채널 전체)</span>}
            </li>
          ))}
        </ul>
      )}
      {uploadError && (
        <p role="alert" className="mb-1 text-[11px] text-danger">{uploadError}</p>
      )}

      {pending.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {pending.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 text-[11px] text-fg"
            >
              <span aria-hidden>📎</span>
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

      {held && (
        /* 대기 중인 것은 **메시지 목록에 그리지 않는다.** "서버가 받아들인 뒤에만 화면이
           바뀌므로 화면은 언제나 서버와 같다"(Reactions.tsx)는 규칙을 깨면 화면과 서버가
           갈라지고, 되돌렸을 때 목록에서 빼는 경로가 하나 더 생긴다. 그래서 대기 상태는
           컴포저 자리에만 선다. */
        <div
          role="status"
          data-testid="undo-send"
          className="mb-1 flex items-center gap-2 rounded bg-surface-sunken px-2 py-1 text-[11px] text-fg-muted"
        >
          <span className="min-w-0 flex-1 truncate">
            보내는 중… {held.typed || `첨부 ${held.attachments.length}개`}
          </span>
          <button
            type="button"
            aria-label="Undo send"
            className="rounded px-1.5 py-0.5 font-medium text-accent hover:bg-surface-hover"
            // 누른 뒤 원문이 입력창으로 돌아오므로 커서를 지켜야 한다 — @·첨부 버튼과 같은 이유다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={undoSend}
          >
            보냄 취소
          </button>
        </div>
      )}

      {/* 예약 줄(#222). **실패한 것도 세어** 연다 — 대기 중인 것이 하나도 남지 않고
          실패만 있을 때 줄 전체가 사라지면, 작성자는 자기 글이 안 나갔다는 것을 영영
          모른다. 목록 조회·취소가 실패한 경우도 여기서 말한다. */}
      {(pendingScheduled.length > 0 || failedScheduled.length > 0 || listError) && (
        <div className="mb-1 flex flex-col rounded bg-accent-surface px-2 py-1 text-[11px] text-accent">
          {listError && <p role="alert" className="text-danger">{listError}</p>}
          {(pendingScheduled.length > 0 || failedScheduled.length > 0) && (
            <button
              type="button"
              className="flex items-center justify-between text-left"
              aria-expanded={scheduledExpanded}
              onClick={() => setScheduledExpanded(!scheduledExpanded)}
            >
              <span>
                예약 {pendingScheduled.length}건
                {failedScheduled.length > 0 && ` · 실패 ${failedScheduled.length}건`}
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
                    aria-label="예약 취소"
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
                  <span className="ml-2 shrink-0">보내지 못함: {m.failedReason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <textarea
        ref={ref}
        className="w-full resize-none rounded border border-border bg-field px-3 py-2"
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
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="mt-1 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Add mention"
            aria-pressed={picking}
            className={`rounded px-2 py-0.5 text-sm text-fg-muted hover:bg-surface-sunken ${
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
          <label className="cursor-pointer rounded px-2 py-0.5 text-sm text-fg-muted hover:bg-surface-sunken">
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
              aria-label="나중에 보내기"
              className="rounded px-2 py-0.5 text-sm text-fg-muted hover:bg-surface-sunken disabled:opacity-40"
              disabled={!draft.trim()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openScheduleModal}
            >
              🕐
            </button>
          )}
        </div>
        <button
          type="button"
          aria-label="Send message"
          className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-fg-on-strong hover:bg-accent-hover disabled:bg-border disabled:text-fg-subtle"
          // 여기는 blur 를 막지 않는다 — 전송에 성공하면 초안이 비므로 커서를 보존할
          // 이유가 없고, 실패하면 사용자가 다시 textarea 를 눌러 이어 쓴다. 반면 위
          // @·첨부 버튼은 누른 뒤에도 같은 자리에 계속 써야 하므로 막는다.
          onMouseDown={(e) => e.preventDefault()}
          onClick={send}
          disabled={!draft.trim() && !pending.length}
        >
          전송
        </button>
      </div>
      {scheduleModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-80 rounded-lg bg-surface-raised p-4 shadow-lg">
            <h3 className="mb-3 text-base font-medium">예약 발송</h3>
            <input
              type="datetime-local"
              aria-label="예약 시각"
              className="mb-3 w-full rounded border border-border bg-field px-3 py-2"
              value={scheduleDateTime}
              onChange={(e) => setScheduleDateTime(e.target.value)}
            />
            {scheduleError && (
              <p role="alert" className="mb-3 text-sm text-danger">{scheduleError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1 text-sm text-fg-muted hover:bg-surface-sunken"
                onClick={() => setScheduleModalOpen(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1 text-sm font-medium text-fg-on-strong hover:bg-accent-hover disabled:bg-border"
                onClick={handleSchedule}
                disabled={isScheduling || !scheduleDateTime}
              >
                {isScheduling ? '예약 중…' : '예약'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
