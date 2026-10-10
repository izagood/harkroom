import { isAskOpen, readAskMeta, readFailureMeta, type InboxEntry, type InboxThreadState, type MessageRow } from '@harkroom/shared';

/**
 * Inbox **상태 보드**(C안, 2026-10-01 jaebin 선택 · designer 정정 1~5 반영).
 *
 * ## 단위는 메시지가 아니라 일(스레드)이다
 *
 * 줄 하나가 메시지 하나였을 때 같은 일이 다섯 줄로 섰다(designer 진단). 그래서 항목을
 * 스레드 머리(`threadRootId ?? messageId`)로 묶어 **카드 하나 = 일 하나**로 만든다.
 *
 * ## 열은 옛 줄의 `meta` 가 아니라 머리의 **지금 상태**가 정한다
 *
 * 줄의 `meta` 는 그 말 하나의 사실이다 — 답한 물음은 알지만 **풀린 실패**는 모르고, 같은
 * 스레드의 다른 말이 무엇을 기다리는지도 모른다. 그 사실은 채널 목록이 머리에 이미 싣는다
 * (`THREAD_STATE_FACTS`: 열린 물음 수·수신자, 안 풀린 실패, 대기 마디). 서버가
 * `GET /inbox?threads=1` 로 그 머리를 함께 주고, 여기서는 그것을 열로 옮기기만 한다.
 *
 * 머리가 없으면(옛 서버, 또는 머리가 지워졌다) 항목의 `meta` 로 떨어진다 — 그때는 실패가
 * 풀렸는지 모르므로 내 스레드의 실패는 내 차례로 둔다(못 보고 지나치는 쪽보다 한 번 더 보는 쪽이 싸다).
 */
export type BoardColumn = 'mine' | 'blocked' | 'active' | 'done';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['mine', 'blocked', 'active', 'done'];

/**
 * **완료(치움)·나중에**는 서버의 내 상태다(2/2, `InboxThreadState`). 1/2 는 머리에 단 ✅ 를
 * 치움으로 읽었는데, ✅ 는 남에게 보이는 표시라 개인 정리가 대화에 흔적을 남기고 다른 뜻의 ✅ 와
 * 갈리지 않았다. 이제 리액션은 보지 않는다.
 *
 * 두 상태 모두 **그 뒤로 나에게 새 말이 오면 풀린다** — 치웠거나 미룬 일에 새 부름이 오면 그것은
 * 다시 볼 일이다. 나중에는 `until` 이 지나도 풀린다.
 */

/**
 * 펼쳐 두는 기간. 그보다 오래된 것은 열 맨 아래 한 줄로 접는다 — 진행·끝남은 조용한 기간으로(정정 4),
 * 내 차례·막힘은 **기다린 기간**으로 잰다(R2, 2026-10-11 designer 재설계): 한 달 기다린 물음이 수에
 * 남아 있으면 숫자가 줄지 않고(옛 화면의 「129」), 그 숫자는 뜻을 잃는다.
 */
export const RECENT_MS = 7 * 86_400_000;

/**
 * 열 안에서 접힌 자리. `quiet` = 진행인데 7일 넘게 조용하다 · `old` = 7일 넘은 끝남 ·
 * `stale` = 내 차례·막힘인데 7일 넘게 기다렸다(R2, **내 차례 수에서 빠진다**) ·
 * `cleared` = 내가 완료로 치웠다(끝남 맨 아래) · `later` = 내가 나중으로 미뤘다(그 열 맨 아래,
 * **내 차례 수에서 빠진다**). 접힌 카드는 **사라지지 않는다** — 수와 함께 한 줄로 남는다.
 */
export type BoardFold = 'quiet' | 'old' | 'stale' | 'cleared' | 'later';

/**
 * **내가 할 일의 종류**(R4, 2026-10-11 designer 재설계). 열(진행·기다림·끝)은 스레드의 상태라서 내
 * 행동을 말하지 않는다 — 내 차례 띠는 이것으로 묶는다.
 *
 * - `decision` 결정: 나에게 온 열린 물음(선택 카드·권한·머지 카드도 물음이다)
 * - `blocker` 막힘: 안 풀린 실패·계정 관문 — 사람 손이 있어야 풀린다
 * - `news` 소식: 위 둘이 아닌 것 — 읽기만 하면 된다
 *
 * 한 카드에 둘이 겹치면 결정이 이긴다: 고르면 풀리는 일을 막힘 아래에 묻으면 안 된다.
 */
export type BoardKind = 'decision' | 'blocker' | 'news';
export const BOARD_KINDS: readonly BoardKind[] = ['decision', 'blocker', 'news'];

export interface BoardCard {
  /** 스레드 머리 id — 카드의 열쇠이자 여는 곳. */
  rootId: string;
  channelId: string;
  column: BoardColumn;
  fold: BoardFold | null;
  /** 이 일에서 나에게 온 항목들, 최근 것이 앞. */
  entries: InboxEntry[];
  /** 해야 할 일 한 문장(마크다운을 벗긴 평문). */
  summary: string;
  /** 그 문장을 쓴 계정(얼굴). */
  whoId: string | null;
  /** "N일째"의 기준 — 이 열에 들어오게 한 말의 시각(없으면 마지막으로 온 말). */
  sinceAt: string;
  /** 스레드가 마지막으로 움직인 시각. 7일 접힘과 진행·끝남 정렬의 기준이다. */
  lastActivityAt: string;
  /** 안 읽은 항목이 있는가. */
  unread: boolean;
  /**
   * 카드에서 바로 고를 물음. **나에게 온 열린 물음**일 때만 — 남에게 간 물음을 여기서 고르게
   * 하면 남의 차례를 내가 가로챈다.
   */
  ask: { messageId: string; options: { id: string; label: string }[] } | null;
  /**
   * 미룬 카드가 **다시 서는 시각**(나중에의 `until`). 미루지 않았으면 null. 화면이 이것을 정보
   * 줄 끝에 적는다(designer) — 언제 돌아오는지 보여야 되돌릴지 그냥 둘지 정할 수 있다.
   */
  laterUntil: string | null;
  /** 내가 할 일의 종류(R4). */
  kind: BoardKind;
  /**
   * 같은 실패를 한 줄로 묶는 열쇠(R5) — **같은 채널에서 같은 에이전트의 같은 실패**(채널·작성자·
   * 갈래 표지·원인 문장). 실패 카드가 아니면 null(묶지 않는다).
   *
   * **나에게 온 열린 물음이 있으면 묶지 않는다**(security F1, #1314). 묶인 줄은 맨 앞 카드의 물음만
   * 보이므로 나머지 물음은 답할 길이 없고, [치우기]가 본 적 없는 결정까지 치운다. 채널을 열쇠에 넣는
   * 것도 같은 이유다(security n1) — 줄에는 맨 앞 카드의 채널만 보이니, 다른 채널 것을 같이 치우면
   * 사람은 무엇을 치웠는지 모른다.
   */
  similarKey: string | null;
  /** 스레드의 답글 수(R6, 머리의 `replyCount`). 머리가 없으면 null. */
  replyCount: number | null;
}

export interface BoardInput {
  entries: InboxEntry[];
  /** `null` 이면 서버가 머리를 안 줬다(옛 서버) — 항목 `meta` 로 판정한다. */
  threads: MessageRow[] | null;
  me: { id: string; kind: 'human' | 'agent' } | null;
  /** 내 완료·나중에. 옛 서버면 비어 있다(그때는 접는 상태가 없다). */
  threadStates: InboxThreadState[];
  /** 끝남(에이전트의 답으로 끝났다)을 가르는 데 쓴다. 모르는 계정은 에이전트가 아니다. */
  isAgent: (accountId: string) => boolean;
  nowMs: number;
}

const rootOf = (e: InboxEntry): string => e.threadRootId ?? e.messageId;

/**
 * **나를 부른** 사유. `thread_reply` 는 빠진다 — 그것은 내가 그 스레드에 말을 한 번 얹었다는
 * 뜻일 뿐 나를 지목한 것이 아니다(내가 연 스레드면 아래 `opened` 가 따로 잡는다).
 */
const CALLED_ME: ReadonlySet<InboxEntry['reason']> = new Set([
  'mention', 'team_mention', 'team_delegated', 'delegation_done', 'dm', 'ask_answered', 'ask_closed',
]);

/**
 * **내 스레드인가**(designer 정정 1). 수신자가 없는 물음(`to: human`)과 실패는 사람 **아무나**의
 * 것이라, 사람마다 전부 내 차례에 넣으면 커뮤니티 전체가 쌓인다 — 옛 화면의 "219"가 그것이다.
 * 그래서 내가 열었거나 나를 부른 스레드로 좁힌다.
 */
interface Scope { opened: boolean; calledMe: boolean }

function askForMe(meta: Record<string, unknown>, me: BoardInput['me'], scope: Scope): ReturnType<typeof readAskMeta> {
  const ask = readAskMeta(meta);
  if (!ask || !isAskOpen(ask) || !me) return null;
  if (ask.to.kind === 'human') return me.kind === 'human' && (scope.opened || scope.calledMe) ? ask : null;
  return ask.to.accountId === me.id ? ask : null;
}

/**
 * 머리의 상태로 열을 정한다 — 보는 사람 층 → 서버 상태 → (상태가 없으면) 옛 규칙. 순서가 규칙이다: **내 차례가 치움을 이긴다** — ✅ 를 단 뒤에
 * 다시 나에게 물음이 왔으면 그 일은 다시 내 것이다.
 */
function columnFromHead(head: MessageRow, input: BoardInput, scope: Scope): BoardColumn {
  const viewer = viewerColumn(head, input, scope);
  if (viewer) return viewer;
  const status = head.statusReaction?.status;
  if (status) return columnFromStatus(status, scope);
  return legacyColumn(head, input, scope);
}

/**
 * **보는 사람 층** — 나를 기다리는 것만 여기서 가른다. 서버 상태(`statusReaction`)는 스레드 기준이라
 * "누구 차례인가"를 모른다(🙋 는 누가 보든 🙋 다). 그래서 내 차례만은 머리의 열린 물음·관문·대기 마디로
 * 직접 잰다. 나머지 열은 서버 상태가 정한다(`columnFromStatus`).
 */
function viewerColumn(head: MessageRow, input: BoardInput, scope: Scope): BoardColumn | null {
  const { me } = input;
  const myId = me?.id ?? null;
  const human = me?.kind === 'human';
  const mine = scope.opened || scope.calledMe;
  const links = head.openAskLinks ?? [];
  const accountIds = head.openAskAccountIds ?? [];
  // 계정 관문 실패의 차례 주인(서버 #1039, 2026-10-02) — 지목된 물음과 같은 대접이다.
  const gateIds = head.openGateAccountIds ?? [];
  const humanAsks = head.openAskHumanCount ?? 0;
  const failures = head.unresolvedFailureCount ?? 0;
  // 나를 지목한 열린 물음·위임은 어디서든, 수신자 없는 물음·실패는 내 스레드에서만.
  // 실패는 언제나 사람에게 온다(`FailureMeta` 에 `to` 가 없다).
  if ((myId != null && (accountIds.includes(myId) || gateIds.includes(myId)))
    || (myId != null && links.some((l) => l.blockedBy === myId))
    || (human && mine && (humanAsks > 0 || failures > 0))) return 'mine';
  return null;
}

/**
 * 서버 상태 → 열(「내 작업」 S2, 2026-10-05 jaebin 승인: **판정 원본은 서버 ✅**). 채널 머리에 붙은
 * 상태 리액션과 보드의 열이 같은 말을 하게 한다 — 보드가 따로 "끝"을 판정하면 둘이 갈린다.
 *
 * - 💬 도는 중 · 👀 받음 → 진행
 * - ⏳ 에이전트·깨움을 기다림 · 🙋 (내가 아닌) 사람을 기다림 → 기다림
 * - 🚨 막힘 → **내 스레드면 내 차례**(사람 손이 있어야 풀린다: 막힌 부름·죽은 러너), 아니면 기다림
 * - ✅ → 끝
 */
function columnFromStatus(status: NonNullable<MessageRow['statusReaction']>['status'], scope: Scope): BoardColumn {
  switch (status) {
    case 'running':
    case 'received': return 'active';
    case 'waiting':
    case 'my-turn': return 'blocked';
    case 'stuck': return scope.opened || scope.calledMe ? 'mine' : 'blocked';
    case 'done': return 'done';
  }
}

/** 서버 상태가 없는 머리(에이전트가 낀 적 없는 스레드) — 옛 규칙 그대로. */
function legacyColumn(head: MessageRow, input: BoardInput, scope: Scope): BoardColumn {
  const { me, isAgent } = input;
  const myId = me?.id ?? null;
  const links = head.openAskLinks ?? [];
  const accountIds = head.openAskAccountIds ?? [];
  const humanAsks = head.openAskHumanCount ?? 0;
  const failures = head.unresolvedFailureCount ?? 0;
  // 내 차례는 이미 `viewerColumn` 이 갈랐다.
  // 막힘: **내가 열었거나 내가 위임한** 스레드가 남을 기다린다. 남의 스레드의 기다림은 빼낸다.
  const iWait = myId != null && links.some((l) => l.waiter === myId);
  const open = links.length > 0 || accountIds.length > 0 || humanAsks > 0 || failures > 0;
  if ((scope.opened || iWait) && open) return 'blocked';
  // 끝남 = **결과가 나온 것**(정정 3): 열린 것이 없고, 도는 중이 아니며, 마지막 말이 에이전트의
  // 답이다. 보고(`report`)도 에이전트의 말이라 여기 든다. 사람이 마지막이면 아직 답을 기다린다.
  const running = head.lastKind === 'progress';
  if (!open && !running && head.lastAuthorId != null && isAgent(head.lastAuthorId)) return 'done';
  return 'active';
}

/** 머리가 없을 때(옛 서버). 줄의 `meta` 가 말하는 만큼만 안다 — 풀린 실패·결과는 모른다. */
function columnFromEntries(entries: InboxEntry[], input: BoardInput, scope: Scope): BoardColumn {
  const human = input.me?.kind === 'human';
  if (entries.some((e) => askForMe(e.meta, input.me, scope)
    || (human && (scope.opened || scope.calledMe) && readFailureMeta(e.meta)))) return 'mine';
  return 'active';
}

const MAX_SUMMARY = 160;

/**
 * 본문에서 **한 문장**을 고른다. 앞 두 줄을 그대로 자르면 인사·멘션·표 머리가 남고 정작
 * 물음은 잘린다(designer 진단) — 그래서 표·코드·인용·제목 표시를 건너뛰고, 머리의 멘션
 * 토큰을 떼고, **물음표로 끝나는 줄이 있으면 그것**을 고른다.
 */
export function oneSentence(body: string): string {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || line === '' || line.startsWith('|') || /^[-=*_]{3,}$/.test(line)) continue;
    const text = line
      .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
      .replace(/^(<@[^>]+>\s*)+/, '')
      // 마크다운을 벗긴 평문(designer): 그림·링크는 글자만, 강조·취소선·코드 표시는 지운다.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      // `*기울임*` 은 붙은 조사가 흔해 어디서든 벗긴다. `_` 는 snake_case 를 깨지 않게 낱말 경계에서만.
      .replace(/\*([^*\s][^*]*?)\*/g, '$1')
      .replace(/(^|\s)_([^_\s][^_]*)_(?=\s|$|[.,!?])/g, '$1$2')
      .trim();
    if (text) lines.push(text);
  }
  const pick = lines.find((l) => /[?？]$/.test(l)) ?? lines[0] ?? '';
  return pick.length > MAX_SUMMARY ? `${pick.slice(0, MAX_SUMMARY - 1)}…` : pick;
}

/**
 * 지금도 뜻이 있는 상태인가. **그 뒤로 나에게 새 말이 왔으면 풀린다**(새 부름은 다시 볼 일이다) —
 * 견주는 것은 스레드의 아무 말이 아니라 **나에게 온 항목**의 시각이다: 내가 남긴 답글로 치운 일이
 * 되살아나면 안 된다. 나중에는 깨어날 시각이 지나도 풀린다.
 */
function effectiveState(s: InboxThreadState | undefined, latestEntryAt: string, nowMs: number): InboxThreadState | null {
  if (!s) return null;
  if (Date.parse(latestEntryAt) > Date.parse(s.updatedAt)) return null;
  if (s.state === 'later' && (s.until == null || Date.parse(s.until) <= nowMs)) return null;
  return s;
}

/**
 * **내 차례 수** — 보드 머리글의 "나를 기다리는 일 N" 이자 사이드바·레일·독 배지의 숫자다(배지 A,
 * 2026-10-02 jaebin). 접힌 것(나중에·7일 넘은 것)은 세지 않는다 — 미룬 일·한 주 넘게 묵은 일은 지금
 * 나를 기다리는 일이 아니다(R2). 치운 것은 끝남으로 옮겨 가므로 여기 오지 않는다.
 *
 * 한 함수로 두는 이유: 보드와 배지가 각자 세면 "배지 3, 보드 2" 가 되고, 그때 사람이 믿을 숫자가 없다
 * (옛 배지가 그랬다 — 안 읽은 멘션·DM 을 세어 "219" 가 줄지 않았다).
 */
export function mineCount(cards: BoardCard[]): number {
  return cards.filter((c) => c.column === 'mine' && c.fold === null).length;
}

export function buildBoard(input: BoardInput): BoardCard[] {
  const { entries, threads, me, nowMs } = input;
  const heads = new Map((threads ?? []).map((m) => [m.id, m]));
  const states = new Map(input.threadStates.map((s) => [s.rootId, s]));
  const groups = new Map<string, InboxEntry[]>();
  for (const e of entries) {
    const key = rootOf(e);
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }
  // inbox 밖의 머리(「내 작업」 S1 — 내가 연·말한 스레드)는 **항목 없는 카드**가 된다. 시켜 놓고 아직
  // 아무도 답하지 않은 일이 여기 든다.
  for (const head of threads ?? []) if (!groups.has(head.id)) groups.set(head.id, []);
  const myId = me?.id ?? null;
  const cards: BoardCard[] = [];
  for (const [rootId, list] of groups) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const head = heads.get(rootId) ?? null;
    const latest = list[0] ?? null;
    // 머리를 물었는데 안 왔다 = 지워졌다(LIST_VISIBLE). 지운 일은 보드에 세우지 않는다.
    if (threads != null && !head) continue;
    const scope: Scope = {
      opened: myId != null && head?.authorId === myId,
      calledMe: list.some((e) => CALLED_ME.has(e.reason)),
    };
    let column = head ? columnFromHead(head, input, scope) : columnFromEntries(list, input, scope);
    // 항목 없는 카드는 머리가 반드시 있다(위에서 머리로만 만들었다).
    const lastActivityAt = [head?.lastReplyAt, head?.createdAt, latest?.createdAt]
      .filter((v): v is string => typeof v === 'string')
      .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    const stale = nowMs - Date.parse(lastActivityAt) > RECENT_MS;
    const running = head?.lastKind === 'progress';
    // 나에게 온 항목이 없으면 내 상태를 풀 새 부름도 없다 — 견줄 시각이 없으니 상태가 그대로 산다.
    const state = effectiveState(states.get(rootId), latest?.createdAt ?? new Date(0).toISOString(), nowMs);
    const openAsk = list.find((e) => askForMe(e.meta, me, scope));
    const failure = column === 'mine' ? list.find((e) => readFailureMeta(e.meta)) : undefined;
    // 문장을 고르는 말: 나에게 온 물음 → 실패 → 머리(일의 제목) → 가장 최근 것.
    const lead = openAsk ?? failure ?? null;
    const ask = openAsk ? askForMe(openAsk.meta, me, scope) : null;
    const failureMeta = failure ? readFailureMeta(failure.meta) : null;
    // 실패는 **원인**을 제목으로 쓴다(R5): 「하네스가 사람의 확인을 기다린다」 같은 무엇(what)은 실패마다
    // 같아서 수십 장이 구별되지 않았다. 원인(reason)이 없으면 무엇으로 떨어진다.
    const failureTitle = (failureMeta?.reason && oneSentence(failureMeta.reason))
      || (failureMeta?.what && oneSentence(failureMeta.what)) || '';
    const summary = (ask?.prompt && oneSentence(ask.prompt))
      || failureTitle
      || oneSentence(lead?.body ?? head?.body ?? latest?.body ?? '')
      || oneSentence(latest?.body ?? '');
    // 항목이 없으면 머리가 마지막으로 움직인 때부터 센다.
    const sinceAt = (lead ?? latest)?.createdAt ?? lastActivityAt;

    let fold: BoardFold | null = null;
    // 나중에는 어느 열이든 그 열 맨 아래로 접는다 — 내 차례도 미룰 수 있어야 수가 0 이 된다.
    // 치움은 **내 차례도 이긴다**(R3, 2026-10-11): 「내 목록에서 치운다」는 사람의 결정이고, 내 차례에만
    // 치우기가 없으면 미루기 말고는 수를 줄일 길이 없었다(옛 화면의 「129」). 물음은 스레드에 그대로
    // 열려 있다 — 치움은 내 보드만 정리한다. 그 뒤로 나에게 새 말이 오면 다시 선다(`effectiveState`).
    if (state?.state === 'later') fold = 'later';
    else if (state?.state === 'done') { column = 'done'; fold = 'cleared'; }
    else if ((column === 'mine' || column === 'blocked') && nowMs - Date.parse(sinceAt) > RECENT_MS) fold = 'stale';
    else if (column === 'active' && stale && !running) fold = 'quiet';
    else if (column === 'done' && stale) fold = 'old';

    // 결정 카드는 묶지 않는다(security F1·n3) — 물음 항목이 내 인박스에 없고 머리만 나를 지목해도
    // 결정이다. 묶으면 결정 하나가 줄 뒤에 숨는다.
    const kind = kindOf(head, input, ask != null, failure != null);
    cards.push({
      rootId,
      channelId: head?.channelId ?? latest!.channelId,
      column,
      fold,
      entries: list,
      summary,
      whoId: lead?.authorId ?? head?.authorId ?? latest?.authorId ?? null,
      sinceAt,
      lastActivityAt,
      unread: list.some((e) => e.readAt === null),
      ask: openAsk && ask ? { messageId: openAsk.messageId, options: ask.options } : null,
      laterUntil: fold === 'later' ? state?.until ?? null : null,
      kind,
      similarKey: kind !== 'decision' && failure && failureTitle
        ? JSON.stringify([failure.channelId, failure.authorId, failureMeta?.code ?? null, failureTitle])
        : null,
      replyCount: head?.replyCount ?? null,
    });
  }
  // **최근 것이 위**다(R1, 2026-10-11 designer 재설계). 옛 규칙(정정 2)은 내 차례·막힘을 오래 기다린
  // 순으로 세웠는데, 쌓인 보드에서는 맨 위가 「31일째」였고 오늘 온 결정은 몇 화면 아래였다. 오래된 것은
  // 이제 `stale` 로 접히므로 펼친 것 안에서는 새 것이 먼저다. 내 차례·막힘은 그 열에 들어오게 한 말의
  // 시각(sinceAt), 진행·끝남은 마지막으로 움직인 시각으로 잰다.
  cards.sort((a, b) => {
    if (a.column !== b.column) return BOARD_COLUMNS.indexOf(a.column) - BOARD_COLUMNS.indexOf(b.column);
    if (a.column === 'mine' || a.column === 'blocked') return Date.parse(b.sinceAt) - Date.parse(a.sinceAt);
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
  return cards;
}

/**
 * 할 일의 종류(R4). 머리가 있으면 머리의 지금 사실(열린 물음 수신자·관문·안 풀린 실패)도 본다 —
 * 나에게 온 물음 항목이 없어도 머리가 나를 지목한 물음을 들고 있으면 결정이다.
 */
function kindOf(head: MessageRow | null, input: BoardInput, askForMe: boolean, failure: boolean): BoardKind {
  const myId = input.me?.id ?? null;
  if (askForMe || (myId != null && (head?.openAskAccountIds ?? []).includes(myId))) return 'decision';
  if (failure || (myId != null && (head?.openGateAccountIds ?? []).includes(myId))
    || (head?.unresolvedFailureCount ?? 0) > 0 || head?.statusReaction?.status === 'stuck') return 'blocker';
  return 'news';
}

/** 묶인 한 줄 — 맨 앞 카드(가장 최근)와 같이 묶인 나머지(R5). */
export interface BoardGroup { card: BoardCard; similar: BoardCard[] }

/**
 * **같은 실패는 한 줄로**(R5). `similarKey` 가 같은 카드를 맨 앞 것(이미 최근 것부터 정렬돼 있다) 한
 * 줄에 모은다. 순서는 각 묶음의 맨 앞 카드 자리 그대로다. 묶음은 같은 목록 안에서만 — 열·접힘이 다른
 * 카드를 섞으면 접힌 것이 펼친 줄로 새어 나온다(그래서 부르는 쪽이 이미 가른 목록을 준다).
 *
 * 숫자(`mineCount`)는 그대로 **일(스레드) 수**다 — 묶음은 보이는 모양일 뿐이고, 치우면 묶인 일이 다 치워진다.
 */
export function groupSimilar(cards: BoardCard[]): BoardGroup[] {
  const groups: BoardGroup[] = [];
  const byKey = new Map<string, BoardGroup>();
  for (const card of cards) {
    const g = card.similarKey != null ? byKey.get(card.similarKey) : undefined;
    if (g) { g.similar.push(card); continue; }
    const fresh: BoardGroup = { card, similar: [] };
    groups.push(fresh);
    if (card.similarKey != null) byKey.set(card.similarKey, fresh);
  }
  return groups;
}

/** "N일째" — 하루 안이면 null(화면이 상대 시각으로 쓴다). */
export function daysWaiting(sinceAt: string, nowMs: number): number | null {
  const days = Math.floor((nowMs - Date.parse(sinceAt)) / 86_400_000);
  return days >= 1 ? days : null;
}

/**
 * 미룬 카드가 다시 서는 시각을 **짧게** 말한다 — 오늘이면 시각만(`오후 3시`), 내일이면
 * `내일 9시`, 그 뒤면 날짜와 시각. 시각은 정각이면 분을 뺀다(`9시`, `9:30`).
 *
 * `nowMs` 를 인자로 받는다(`lib/time.ts::agoLabel` 과 같은 이유) — 시험이 "오늘/내일"의 경계를
 * 고정된 시각으로 잴 수 있어야 한다. 날짜 경계는 **내 시계**(로컬 자정)로 가른다.
 */
export function laterUntilLabel(
  untilIso: string, nowMs: number, locale: string, t: (key: 'inbox.board.tomorrowAt', vars: { time: string }) => string,
): string {
  const at = new Date(untilIso);
  const time = at.toLocaleTimeString(locale, at.getMinutes() === 0
    ? { hour: 'numeric' }
    : { hour: 'numeric', minute: '2-digit' });
  const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(at) - dayOf(new Date(nowMs))) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return t('inbox.board.tomorrowAt', { time });
  return `${at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * 「내 작업」 필터(W2b, designer 82644a8f): **모든 채널 / 내가 연 것 / 참여한 것**.
 *
 * 거르는 재료는 **서버가 준 머리**(`threads`)뿐이다 — 새 조회를 하지 않고, 보드에 이미 선 카드에서
 * 빼기만 한다(security). 머리가 없는 카드(옛 서버)는 연 사람·참여자를 모르므로 「모든 채널」에서만 보인다.
 *
 * - 내가 연 것 = 머리를 내가 썼다.
 * - 참여한 것 = 내가 연 것 **또는** 내가 답글을 남겼다(`participantIds`). 연 것도 참여다 — 그래서
 *   「내가 연 것」은 「참여한 것」의 부분집합이고, 필터를 넓혀 가면 카드가 줄지 않는다.
 */
export type BoardScope = 'all' | 'opened' | 'participated';
export const BOARD_SCOPES: readonly BoardScope[] = ['all', 'opened', 'participated'];

export function filterBoard(
  cards: BoardCard[], threads: MessageRow[] | null, scope: BoardScope, myId: string | null,
): BoardCard[] {
  if (scope === 'all') return cards;
  if (myId == null) return [];
  const heads = new Map((threads ?? []).map((m) => [m.id, m]));
  return cards.filter((c) => {
    const head = heads.get(c.rootId);
    if (!head) return false;
    const opened = head.authorId === myId;
    if (scope === 'opened') return opened;
    return opened || (head.participantIds ?? []).includes(myId);
  });
}
