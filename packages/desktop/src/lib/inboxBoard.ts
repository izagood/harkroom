import { isAskOpen, readAskMeta, readFailureMeta, type InboxEntry, type MessageRow } from '@harkroom/shared';

/**
 * Inbox **상태 보드**(C안, 2026-10-01 jaebin 선택).
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
 * 풀렸는지 모르므로 실패는 내 차례로 둔다(못 보고 지나치는 쪽보다 한 번 더 보는 쪽이 싸다).
 */
export type BoardColumn = 'mine' | 'blocked' | 'active' | 'done';
export const BOARD_COLUMNS: readonly BoardColumn[] = ['mine', 'blocked', 'active', 'done'];

/** 1/2 의 임시 "끝남" 표시. 사람이 이미 이것으로 끝냄을 적고 있다(서버 상태는 2/2). */
export const DONE_EMOJI = '✅';

export interface BoardCard {
  /** 스레드 머리 id — 카드의 열쇠이자 여는 곳. */
  rootId: string;
  channelId: string;
  column: BoardColumn;
  /** 이 일에서 나에게 온 항목들, 최근 것이 앞. */
  entries: InboxEntry[];
  /** 해야 할 일 한 문장. */
  summary: string;
  /** 그 문장을 쓴 계정(얼굴). */
  whoId: string | null;
  /** "N일째"의 기준 — 이 열에 들어오게 한 말의 시각(없으면 마지막으로 온 말). */
  sinceAt: string;
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
}

const rootOf = (e: InboxEntry): string => e.threadRootId ?? e.messageId;

function askForMe(meta: Record<string, unknown>, me: BoardInput['me']): ReturnType<typeof readAskMeta> {
  const ask = readAskMeta(meta);
  if (!ask || !isAskOpen(ask) || !me) return null;
  if (ask.to.kind === 'human') return me.kind === 'human' ? ask : null;
  return ask.to.accountId === me.id ? ask : null;
}

/**
 * 머리의 상태로 열을 정한다. 순서가 규칙이다: **내 차례가 끝남을 이긴다** — ✅ 를 단 뒤에
 * 다시 나에게 물음이 왔으면 그 일은 다시 내 것이다.
 */
function columnFromHead(head: MessageRow, me: BoardInput['me']): BoardColumn {
  const myId = me?.id ?? null;
  const human = me?.kind === 'human';
  const links = head.openAskLinks ?? [];
  const accountIds = head.openAskAccountIds ?? [];
  const humanAsks = head.openAskHumanCount ?? 0;
  // 실패는 언제나 사람에게 온다(`FailureMeta` 에 `to` 가 없다).
  if ((human && humanAsks > 0)
    || (myId != null && accountIds.includes(myId))
    || (myId != null && links.some((l) => l.blockedBy === myId))
    || (human && (head.unresolvedFailureCount ?? 0) > 0)) return 'mine';
  if (myId != null && head.reactions.some((r) => r.emoji === DONE_EMOJI && r.accountIds.includes(myId))) return 'done';
  if (links.length > 0 || accountIds.length > 0 || humanAsks > 0) return 'blocked';
  return 'active';
}

/** 머리가 없을 때. 줄의 `meta` 가 말하는 만큼만 안다. */
function columnFromEntries(entries: InboxEntry[], me: BoardInput['me']): BoardColumn {
  if (entries.some((e) => askForMe(e.meta, me) || readFailureMeta(e.meta))) return 'mine';
  if (entries.some((e) => { const a = readAskMeta(e.meta); return a != null && isAskOpen(a); })) return 'blocked';
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
      .replace(/\*\*|__|`/g, '')
      .trim();
    if (text) lines.push(text);
  }
  const pick = lines.find((l) => /[?？]$/.test(l)) ?? lines[0] ?? '';
  return pick.length > MAX_SUMMARY ? `${pick.slice(0, MAX_SUMMARY - 1)}…` : pick;
}

export function buildBoard({ entries, threads, me }: BoardInput): BoardCard[] {
  const heads = new Map((threads ?? []).map((m) => [m.id, m]));
  const groups = new Map<string, InboxEntry[]>();
  for (const e of entries) {
    const key = rootOf(e);
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }
  const cards: BoardCard[] = [];
  for (const [rootId, list] of groups) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const head = heads.get(rootId) ?? null;
    // 머리를 물었는데 안 왔다 = 지워졌다(LIST_VISIBLE). 지운 일은 보드에 세우지 않는다.
    if (threads != null && !head) continue;
    const column = head ? columnFromHead(head, me) : columnFromEntries(list, me);
    const openAsk = list.find((e) => askForMe(e.meta, me));
    const failure = column === 'mine' ? list.find((e) => readFailureMeta(e.meta)) : undefined;
    // 문장을 고르는 말: 나에게 온 물음 → 실패 → 머리(일의 제목) → 가장 최근 것.
    const lead = openAsk ?? failure ?? null;
    const ask = openAsk ? askForMe(openAsk.meta, me) : null;
    const failureMeta = failure ? readFailureMeta(failure.meta) : null;
    const summary = (ask?.prompt && oneSentence(ask.prompt))
      || (failureMeta?.what && oneSentence(failureMeta.what))
      || oneSentence(lead?.body ?? head?.body ?? list[0]!.body)
      || oneSentence(list[0]!.body);
    cards.push({
      rootId,
      channelId: head?.channelId ?? list[0]!.channelId,
      column,
      entries: list,
      summary,
      whoId: lead?.authorId ?? head?.authorId ?? list[0]!.authorId,
      sinceAt: (lead ?? list[0]!).createdAt,
      unread: list.some((e) => e.readAt === null),
      ask: openAsk && ask ? { messageId: openAsk.messageId, options: ask.options } : null,
    });
  }
  // 열 안에서는 **오래 기다린 것이 위**다 — 내 차례에서 어제부터 기다린 물음이 방금 온
  // 답글 아래로 밀리면 그 열의 뜻이 없다. 끝남·진행은 최근 것이 위(다시 찾는 목록이다).
  cards.sort((a, b) => {
    if (a.column !== b.column) return BOARD_COLUMNS.indexOf(a.column) - BOARD_COLUMNS.indexOf(b.column);
    const oldestFirst = a.column === 'mine' || a.column === 'blocked';
    const d = Date.parse(a.sinceAt) - Date.parse(b.sinceAt);
    return oldestFirst ? d : -d;
  });
  return cards;
}

/** "N일째" — 하루 안이면 null(화면이 상대 시각으로 쓴다). */
export function daysWaiting(sinceAt: string, nowMs: number): number | null {
  const days = Math.floor((nowMs - Date.parse(sinceAt)) / 86_400_000);
  return days >= 1 ? days : null;
}
