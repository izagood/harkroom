import { isAskOpen, readAskMeta, readFailureMeta, readReportMeta, type AgentWakeView, type MessageRow } from '@harkroom/shared';
import type { ThreadRead } from './threadTurns';
import type { ThreadTurn } from './threadProgress';

/**
 * 작업 서랍(R2-b)의 재료 — 진행 띠가 **수**로 말한 것을 줄로 편다.
 *
 * 띠와 같은 재료(스레드의 글·R1 턴·예약)에 B1 작업 행(`GET /threads/{root}/work`)을 더한다. 작업 행은 아직 쓰는 곳이
 * 적어 비어 있기 쉽다 — 그래도 서랍이 서도록 턴·카드·예약을 함께 줄로 세운다. 순수 함수다.
 *
 * 띠의 수와 서랍의 줄 수가 갈라지면 한 화면이 두 말을 한다. 그래서 줄은 `threadProgress` 와 같은 규칙으로 고른다.
 */
export interface WorkRow {
  id: string;
  title: string;
  state: string;
  assigneeId: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  /** 안 끝난 바로 아래 작업 수(「기다리는 까닭」). */
  openChildren: number;
}

/** B1 읽기의 답에서 서랍이 쓰는 칸만 고른다. 나무는 납작하게 편다 — 서랍은 한 줄에 한 작업이다. */
export function flattenWork(works: unknown): WorkRow[] {
  const out: WorkRow[] = [];
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.state !== 'string') continue;
      out.push({
        id: r.id,
        title: typeof r.title === 'string' ? r.title : '',
        state: r.state,
        assigneeId: typeof r.assigneeId === 'string' ? r.assigneeId : null,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : null,
        openChildren: typeof r.openChildren === 'number' ? r.openChildren : 0,
      });
      walk(r.children);
    }
  };
  walk(works);
  return out;
}

export type WorkSnapshot = ThreadRead<WorkRow[]>;

export type DrawerGroup = 'myTurn' | 'blocked' | 'running' | 'waiting' | 'doneToday';

/** 줄 하나. 무엇을 기다리는지·누가 도는지는 `detail` 이 갈래로 말하고, 문장은 그리는 쪽이 사전에서 고른다. */
export interface DrawerItem {
  key: string;
  group: DrawerGroup;
  /** 그 줄의 주인공(카드를 낸 쪽·도는 에이전트·예약한 에이전트·보고한 쪽). */
  actorId: string | null;
  /** 한 줄 제목. 없으면 그리는 쪽이 주인공 이름으로 대신한다. */
  title: string | null;
  detail:
    | { kind: 'ask'; awaitingId: string | null }
    | { kind: 'gate' }
    | { kind: 'failure' }
    | { kind: 'planBlocked'; count: number }
    | { kind: 'turn' }
    | { kind: 'turnUnknown' }
    | { kind: 'wake' }
    | { kind: 'wakeUnknown' }
    | { kind: 'work'; openChildren: number }
    | { kind: 'report' };
  /** 시작·물은·끝난 시각(예약은 깨어날 시각). 모르면 `null`. */
  at: string | null;
  /** 누르면 갈 글. 없으면 누를 수 없다. */
  messageId: string | null;
}

export interface ThreadWorkInput {
  messages: readonly MessageRow[];
  myAccountId: string | null;
  turns: readonly ThreadTurn[] | null;
  wakes: readonly AgentWakeView[] | null;
  work: readonly WorkRow[];
  planBlocked: number;
  /** 글 본문에서 제목 한 줄을 뽑는다(멘션 토큰을 이름으로 되돌리는 일은 부르는 쪽이 한다). */
  titleOf: (row: MessageRow) => string | null;
  now: number;
}

const ORDER: readonly DrawerGroup[] = ['myTurn', 'blocked', 'running', 'waiting', 'doneToday'];

export function threadWorkItems(input: ThreadWorkInput): DrawerItem[] {
  const { messages, myAccountId, turns, wakes, work, planBlocked, titleOf, now } = input;
  const items: DrawerItem[] = [];
  const dayStart = startOfDay(now);
  let failure: MessageRow | null = null;
  let gateMine = false;
  const lastProgress = new Map<string, MessageRow>();

  for (const m of messages) {
    if (m.kind === 'progress') lastProgress.set(m.authorId, m);
    const fm = readFailureMeta(m.meta);
    if (fm != null) {
      failure = m;
      gateMine = fm.code === 'account_gate' && myAccountId != null && fm.awaitingAccountId === myAccountId;
    } else if (failure && (m.kind === 'progress' || m.kind === 'wake' || readReportMeta(m.meta) != null || m.authorId === failure.authorId)) {
      failure = null;
      gateMine = false;
    }
    if (readReportMeta(m.meta) != null && Date.parse(m.createdAt) >= dayStart) {
      items.push({ key: `report:${m.id}`, group: 'doneToday', actorId: m.authorId, title: titleOf(m), detail: { kind: 'report' }, at: m.createdAt, messageId: m.id });
    }
    const ask = readAskMeta(m.meta);
    if (!ask || !isAskOpen(ask)) continue;
    const mine = ask.to.kind === 'human' ? myAccountId != null : ask.to.accountId === myAccountId;
    items.push({
      key: `ask:${m.id}`,
      group: mine ? 'myTurn' : 'waiting',
      actorId: m.authorId,
      title: firstLine(ask.prompt) ?? titleOf(m),
      detail: { kind: 'ask', awaitingId: ask.to.kind === 'human' ? null : ask.to.accountId },
      at: m.createdAt,
      messageId: m.id,
    });
  }

  if (failure) {
    const fm = readFailureMeta(failure.meta);
    items.push({
      key: `failure:${failure.id}`,
      group: gateMine ? 'myTurn' : 'blocked',
      actorId: failure.authorId,
      title: firstLine(fm?.what) ?? firstLine(fm?.reason) ?? titleOf(failure),
      detail: { kind: gateMine ? 'gate' : 'failure' },
      at: failure.createdAt,
      messageId: failure.id,
    });
  }
  if (planBlocked > 0) {
    items.push({ key: 'plan-blocked', group: 'blocked', actorId: null, title: null, detail: { kind: 'planBlocked', count: planBlocked }, at: null, messageId: null });
  }

  if (turns === null) {
    items.push({ key: 'turns-unknown', group: 'running', actorId: null, title: null, detail: { kind: 'turnUnknown' }, at: null, messageId: null });
  } else {
    turns.forEach((turn, i) => {
      // 「무엇을」은 턴이 말하지 않는다 — 그 에이전트의 안 끝난 작업 행, 없으면 마지막 진행 글 첫 줄에서 잇는다.
      const row = work.find((w) => w.assigneeId === turn.agentAccountId && (w.state === 'running' || w.state === 'open'));
      const progress = lastProgress.get(turn.agentAccountId);
      items.push({
        key: `turn:${turn.agentAccountId}:${i}`,
        group: 'running',
        actorId: turn.agentAccountId,
        title: (row?.title || null) ?? (progress ? titleOf(progress) : null),
        detail: { kind: 'turn' },
        at: turn.startedAt,
        messageId: progress?.id ?? null,
      });
    });
  }

  if (wakes === null) {
    items.push({ key: 'wakes-unknown', group: 'waiting', actorId: null, title: null, detail: { kind: 'wakeUnknown' }, at: null, messageId: null });
  } else {
    for (const w of wakes) {
      items.push({ key: `wake:${w.id}`, group: 'waiting', actorId: w.agentAccountId, title: firstLine(w.reason), detail: { kind: 'wake' }, at: w.wakeAt, messageId: w.messageId });
    }
  }
  for (const w of work) {
    if (w.state !== 'waiting') continue;
    items.push({ key: `work:${w.id}`, group: 'waiting', actorId: w.assigneeId, title: w.title || null, detail: { kind: 'work', openChildren: w.openChildren }, at: w.updatedAt ?? w.createdAt, messageId: null });
  }

  // 묶음은 띠의 순서, 묶음 안은 넣은 순서(오래된 것이 위) — 「오늘 끝」만 최근 것이 위다.
  const rank = (g: DrawerGroup): number => ORDER.indexOf(g);
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.group) - rank(b.item.group)
      || (a.item.group === 'doneToday' ? b.i - a.i : a.i - b.i))
    .map((x) => x.item);
}

/** 내 차례 칸을 누르면 갈 글 — 가장 오래 기다린 내 카드(또는 내 앞의 관문 실패). 없으면 `null`. */
export function firstMyTurnMessageId(items: readonly DrawerItem[]): string | null {
  return items.find((i) => i.group === 'myTurn' && i.messageId != null)?.messageId ?? null;
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
