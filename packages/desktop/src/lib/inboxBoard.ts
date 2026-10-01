import { isAskOpen, readAskMeta, readFailureMeta, type InboxEntry, type MessageRow } from '@harkroom/shared';

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
 * **치움** 표시(designer 정정 3, 10-01). ✅ 는 "끝남"이 아니라 **보드에서 내린다**는 뜻이다 —
 * 끝남 열은 결과를 보러 가는 곳이고, ✅ 로만 끝남을 세우면 결과가 나와도 진행에 머문다.
 * 치운 카드는 끝남 맨 아래 접힘으로 간다. 2/2 의 서버 "완료" 상태가 이 표시를 대신한다.
 */
export const CLEAR_EMOJI = '✅';

/** 진행·끝남에 펼쳐 두는 기간. 그보다 오래 조용한 것은 열 맨 아래 한 줄로 접는다(정정 4). */
export const RECENT_MS = 7 * 86_400_000;

/**
 * 열 안에서 접힌 자리. `quiet` = 진행인데 7일 넘게 조용하다 · `old` = 7일 넘은 끝남 ·
 * `cleared` = 내가 ✅ 로 치웠다. 접힌 카드는 **사라지지 않는다** — 수와 함께 한 줄로 남는다.
 */
export type BoardFold = 'quiet' | 'old' | 'cleared';

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
}

export interface BoardInput {
  entries: InboxEntry[];
  /** `null` 이면 서버가 머리를 안 줬다(옛 서버) — 항목 `meta` 로 판정한다. */
  threads: MessageRow[] | null;
  me: { id: string; kind: 'human' | 'agent' } | null;
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
 * 머리의 상태로 열을 정한다. 순서가 규칙이다: **내 차례가 치움을 이긴다** — ✅ 를 단 뒤에
 * 다시 나에게 물음이 왔으면 그 일은 다시 내 것이다.
 */
function columnFromHead(head: MessageRow, input: BoardInput, scope: Scope): BoardColumn {
  const { me, isAgent } = input;
  const myId = me?.id ?? null;
  const human = me?.kind === 'human';
  const mine = scope.opened || scope.calledMe;
  const links = head.openAskLinks ?? [];
  const accountIds = head.openAskAccountIds ?? [];
  const humanAsks = head.openAskHumanCount ?? 0;
  const failures = head.unresolvedFailureCount ?? 0;
  // 내 차례: 나를 지목한 열린 물음·위임은 어디서든, 수신자 없는 물음·실패는 내 스레드에서만.
  // 실패는 언제나 사람에게 온다(`FailureMeta` 에 `to` 가 없다).
  if ((myId != null && accountIds.includes(myId))
    || (myId != null && links.some((l) => l.blockedBy === myId))
    || (human && mine && (humanAsks > 0 || failures > 0))) return 'mine';
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
      .replace(/(^|\s)[*_]([^*_\s][^*_]*)[*_](?=\s|$|[.,!?])/g, '$1$2')
      .trim();
    if (text) lines.push(text);
  }
  const pick = lines.find((l) => /[?？]$/.test(l)) ?? lines[0] ?? '';
  return pick.length > MAX_SUMMARY ? `${pick.slice(0, MAX_SUMMARY - 1)}…` : pick;
}

export function buildBoard(input: BoardInput): BoardCard[] {
  const { entries, threads, me, nowMs } = input;
  const heads = new Map((threads ?? []).map((m) => [m.id, m]));
  const groups = new Map<string, InboxEntry[]>();
  for (const e of entries) {
    const key = rootOf(e);
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }
  const myId = me?.id ?? null;
  const cards: BoardCard[] = [];
  for (const [rootId, list] of groups) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const head = heads.get(rootId) ?? null;
    // 머리를 물었는데 안 왔다 = 지워졌다(LIST_VISIBLE). 지운 일은 보드에 세우지 않는다.
    if (threads != null && !head) continue;
    const scope: Scope = {
      opened: myId != null && head?.authorId === myId,
      calledMe: list.some((e) => CALLED_ME.has(e.reason)),
    };
    let column = head ? columnFromHead(head, input, scope) : columnFromEntries(list, input, scope);
    const lastActivityAt = [head?.lastReplyAt, head?.createdAt, list[0]!.createdAt]
      .filter((v): v is string => typeof v === 'string')
      .reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
    const stale = nowMs - Date.parse(lastActivityAt) > RECENT_MS;
    const running = head?.lastKind === 'progress';
    const cleared = myId != null && (head?.reactions ?? []).some((r) => r.emoji === CLEAR_EMOJI && r.accountIds.includes(myId));
    let fold: BoardFold | null = null;
    // 치운 것은 끝남 맨 아래로 간다 — 내 차례만은 치움을 이긴다(위 `columnFromHead`).
    if (cleared && column !== 'mine') { column = 'done'; fold = 'cleared'; }
    else if (column === 'active' && stale && !running) fold = 'quiet';
    else if (column === 'done' && stale) fold = 'old';

    const openAsk = list.find((e) => askForMe(e.meta, me, scope));
    const failure = column === 'mine' ? list.find((e) => readFailureMeta(e.meta)) : undefined;
    // 문장을 고르는 말: 나에게 온 물음 → 실패 → 머리(일의 제목) → 가장 최근 것.
    const lead = openAsk ?? failure ?? null;
    const ask = openAsk ? askForMe(openAsk.meta, me, scope) : null;
    const failureMeta = failure ? readFailureMeta(failure.meta) : null;
    const summary = (ask?.prompt && oneSentence(ask.prompt))
      || (failureMeta?.what && oneSentence(failureMeta.what))
      || oneSentence(lead?.body ?? head?.body ?? list[0]!.body)
      || oneSentence(list[0]!.body);
    cards.push({
      rootId,
      channelId: head?.channelId ?? list[0]!.channelId,
      column,
      fold,
      entries: list,
      summary,
      whoId: lead?.authorId ?? head?.authorId ?? list[0]!.authorId,
      sinceAt: (lead ?? list[0]!).createdAt,
      lastActivityAt,
      unread: list.some((e) => e.readAt === null),
      ask: openAsk && ask ? { messageId: openAsk.messageId, options: ask.options } : null,
    });
  }
  // 내 차례·막힘은 **오래 기다린 것이 위**다(정정 2) — 어제부터 기다린 물음이 방금 온 답글
  // 아래로 밀리면 그 열의 뜻이 없다. 진행·끝남은 최근에 움직인 것이 위(다시 찾는 목록이다).
  cards.sort((a, b) => {
    if (a.column !== b.column) return BOARD_COLUMNS.indexOf(a.column) - BOARD_COLUMNS.indexOf(b.column);
    if (a.column === 'mine' || a.column === 'blocked') return Date.parse(a.sinceAt) - Date.parse(b.sinceAt);
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
  return cards;
}

/** "N일째" — 하루 안이면 null(화면이 상대 시각으로 쓴다). */
export function daysWaiting(sinceAt: string, nowMs: number): number | null {
  const days = Math.floor((nowMs - Date.parse(sinceAt)) / 86_400_000);
  return days >= 1 ? days : null;
}
