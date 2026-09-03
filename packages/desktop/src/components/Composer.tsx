import { useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { mentionedHandles, parseMessagePermalink } from '@murmur/shared';
import type { AccountView, AttachmentRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';
import { Identity } from './Identity';
import { formatSize } from './Attachments';
import {
  mentionQueryAt, applyMention, withStickyMentions, keepMentioned, type MentionQuery,
} from '../lib/mention';
import { undoSendStorage } from '../lib/prefs';

/** 목록이 화면을 덮지 않을 만큼만 보여준다. 더 좁히는 것은 사용자가 글자를 더 치는 일이다. */
const MAX_SUGGESTIONS = 8;

/**
 * '입력 중' 갱신 간격. 글자마다 소켓으로 보내면 한 문장에 수십 번 오간다. 서버의 만료
 * 창(6초)보다 넉넉히 짧게만 갱신하면 한 번 놓쳐도 표시가 끊기지 않는다.
 */
const TYPING_THROTTLE_MS = 3_000;

/** 에이전트를 먼저 세운다 — murmur 에서 @ 를 치는 주된 이유다. 그 안에서는 이름순. */
function rank(a: AccountView, b: AccountView): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  return a.handle.localeCompare(b.handle);
}

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

export function Composer({ onSend, placeholder, rows = 2, autoFocus, scopeKey = '' }: Props) {
  const accounts = useAppStore((s) => s.accounts);
  const groups = useAppStore((s) => s.groups);
  const myId = useAppStore((s) => s.me?.id);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [stickyByScope, setStickyByScope] = useState<Record<string, string[]>>({});
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

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    return Object.values(accounts)
      // 비활성 계정은 부를 수 없다 — 디렉터리에는 남아 있다(과거 메시지의 작성자 이름을
      // 풀어야 하므로). 후보에서 빼는 것이 이쪽 책임이다(shared 의 AccountView.disabled 주석).
      .filter((a) => a.id !== myId && !a.disabled && a.handle.toLowerCase().startsWith(q))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS);
  }, [accounts, myId, query]);

  const known = useMemo(
    () => new Set(
      Object.values(accounts).filter((a) => a.id !== myId).map((a) => a.handle.toLowerCase()),
    ),
    [accounts, myId],
  );

  // 계정이 사라지면 고정도 사라진다 — 없는 handle 을 붙이면 멘션이 아니라 그냥 글자다.
  const sticky = useMemo(
    () => (stickyByScope[scopeKey] ?? []).filter((h) => known.has(h)),
    [stickyByScope, scopeKey, known],
  );

  // 집합 handle Set. `splitMentions` 과 같은 방식이다 — 같은 함수로 판정해야 보내기 전후가
  // 어긋나지 않는다(#278). 이 Set 은 본문 해석에만 쓰이고 고정과 합쳐지지 않는다.
  const groupHandles = useMemo(
    () => new Set(groups.map((g) => g.handle.toLowerCase())),
    [groups],
  );

  // 본문에서 불린 상대. 알려진 계정과 집합 모두 포함하고,固定은 뺀다 —固定은 별도로
  // 그리기 때문이다. 둘을 합치면 "이 줄을 지우면 谁을 지우는 지"를 사용자가 모른다.
  const bodyMentions = useMemo(() => {
    const handles = mentionedHandles(draft);
    return handles
      .filter((h) => known.has(h) || groupHandles.has(h))
      .filter((h) => !sticky.includes(h));
  }, [draft, known, groupHandles, sticky]);

  // @ 버튼으로 여는 목록. 첫 줄을 보내기 전에도 상대를 정해 둘 수 있어야 한다.
  // 이미 고정된 상대는 뺀다 — 다시 골라도 달라지는 것이 없다.
  const pickable = useMemo(
    () => Object.values(accounts)
      .filter((a) => a.id !== myId && !sticky.includes(a.handle.toLowerCase()))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS),
    [accounts, myId, sticky],
  );

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
    const body = withStickyMentions(typed, sticky);
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

  const listId = 'mention-suggestions';

  return (
    <div ref={containerRef} className="relative" onBlur={onContainerBlur}>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={picking ? 'Mentions to keep' : 'Mention suggestions'}
          className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-72 overflow-y-auto rounded border border-zinc-300 bg-white py-1 shadow-lg"
        >
          {options.map((a, i) => (
            <li key={a.id}>
              <button
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                type="button"
                // 핸들을 속성으로 노출한다. 테스트가 textContent 에서 핸들을 뽑으면
                // 장식(에이전트 표시 등)이 하나 늘 때마다 깨진다 — 실제로 그랬다.
                data-handle={a.handle}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-indigo-50' : ''}`}
                // mousedown 을 막지 않으면 클릭 전에 textarea 가 blur 되어 커서 위치가 사라진다.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(a.handle)}
              >
                <span className="font-medium">@{a.handle}</span>
                <Identity account={a} className="ml-1" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {sticky.length > 0 && (
        <ul className="mb-1 flex flex-wrap items-center gap-1" aria-label="Kept mentions">
          {sticky.map((h) => (
            <li
              key={h}
              data-testid="sticky-mention"
              data-handle={h}
              className="flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-700"
            >
              <span>@{h}</span>
              <button
                type="button"
                aria-label={`Remove @${h}`}
                className="rounded px-0.5 text-zinc-500 hover:bg-zinc-200"
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
      {bodyMentions.length > 0 && (
        <div
          data-testid="body-mentions"
          className="mb-1 flex flex-wrap items-center gap-1 text-xs text-zinc-600"
        >
          <span>부를 상대:</span>
          {bodyMentions.map((h) => {
            const isGroup = groupHandles.has(h);
            const group = isGroup ? groups.find((g) => g.handle.toLowerCase() === h) : null;
            return (
              <span
                key={h}
                data-handle={h}
                className={`flex items-center gap-0.5 font-medium ${isGroup ? 'text-indigo-600' : 'text-zinc-700'}`}
              >
                <span>@{h}</span>
                {isGroup && group && <span className="text-zinc-400">(집합)</span>}
              </span>
            );
          })}
        </div>
      )}
      {uploadError && (
        <p role="alert" className="mb-1 text-[11px] text-red-600">{uploadError}</p>
      )}

      {pending.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {pending.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-zinc-50 px-1.5 text-[11px] text-zinc-700"
            >
              <span aria-hidden>📎</span>
              {a.filename}
              <span className="text-zinc-500">{formatSize(a.sizeBytes)}</span>
              <button
                aria-label={`Remove ${a.filename}`}
                className="rounded px-0.5 text-zinc-400 hover:bg-zinc-200"
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
          className="mb-1 flex items-center gap-2 rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600"
        >
          <span className="min-w-0 flex-1 truncate">
            보내는 중… {held.typed || `첨부 ${held.attachments.length}개`}
          </span>
          <button
            type="button"
            aria-label="Undo send"
            className="rounded px-1.5 py-0.5 font-medium text-indigo-600 hover:bg-zinc-200"
            // 누른 뒤 원문이 입력창으로 돌아오므로 커서를 지켜야 한다 — @·첨부 버튼과 같은 이유다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={undoSend}
          >
            보냄 취소
          </button>
        </div>
      )}

      <textarea
        ref={ref}
        className="w-full resize-none rounded border border-zinc-300 px-3 py-2"
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
            className={`rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-100 ${
              picking ? 'bg-zinc-200' : ''
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
          <label className="cursor-pointer rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-100">
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
        </div>
        <button
          type="button"
          aria-label="Send message"
          className="rounded-full bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:bg-zinc-300 disabled:text-zinc-500"
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
    </div>
  );
}
