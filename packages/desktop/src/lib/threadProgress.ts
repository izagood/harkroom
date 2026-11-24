import { isAskOpen, readAskMeta, readFailureMeta, readReportMeta, type MessageRow, type PlanProgress } from '@harkroom/shared';

/**
 * 스레드 진행 띠(R2)의 재료 — 「무엇이 돌고 · 막혔고 · 끝났는지」를 상태별 **수**로 센다.
 *
 * `threadState` 가 스레드에 상태 **하나**를 주는 것과 달리 여기서는 칸마다 센다: 한 스레드에 내 차례 카드와
 * 도는 턴이 함께 있을 수 있고, 배지 하나로는 그 둘 중 하나가 가려진다. 순서는 사람이 먼저 할 것부터다 —
 * 내 차례 → 막힘 → 도는 중 → 기다림 → 오늘 끝.
 *
 * 순수 함수다. 재료는 이미 손에 든 것(스레드의 글·루트 행의 계획 진척)과 R1 턴 목록·예약 목록뿐이다.
 */
export interface ThreadTurn {
  agentAccountId: string;
  /** 러너가 시작 시각을 안 알렸으면 `null`. */
  startedAt: string | null;
}

/** R1 읽기의 답. `0` 과 「모름」을 가르려고 셋이다(`AgentTurnsSnapshot` 과 같은 규율). */
export type ThreadTurnsSnapshot =
  /** 첫 답 전(또는 묻지 않는 동안). 턴 칸은 옛 판정으로 센다. */
  | { kind: 'checking' }
  | { kind: 'known'; turns: ThreadTurn[] }
  /** 물었지만 답을 못 받았다 — 「도는 중 0」이 아니다. */
  | { kind: 'unknown' }
  /** 이 서버에는 읽는 길이 없다(옛 서버·권한 없음). 턴 칸을 스레드 상태로 물러나 센다. */
  | { kind: 'off' };

export interface ThreadProgress {
  /** 나에게 열린 카드 + 내 앞에 선 계정 관문 실패. */
  myTurn: number;
  /** 안 풀린 실패(내 관문 제외) + 계획의 막힌 단계. */
  blocked: number;
  /** 도는 턴 수. `null` 은 모름(점선으로 그린다). */
  running: number | null;
  /** 남에게 간 미답 카드 + 이 스레드로 돌아올 예약 + 기다리는 작업 행. 예약을 못 읽었으면 읽힌 것만 센 수다. */
  waiting: number;
  /** 예약 목록을 못 읽었다 — `waiting` 은 모자랄 수 있다. 0 으로 말하지 않고 점선 칸 「기다림 모름」을 세운다. */
  waitingUnknown: boolean;
  /** 오늘(이 기기의 0시부터) 올라온 완료 보고. */
  doneToday: number;
  /** 마지막 완료 보고의 시각. 한 번도 없으면 `null`. 빈 띠의 「마지막 끝」 재료다. */
  lastDoneAt: string | null;
  /** 마지막 답(진행·예약 줄 제외)의 시각. 완료 보고가 없을 때 빈 띠가 대신 말한다. */
  lastReplyAt: string | null;
}

export interface ThreadProgressInput {
  /** 스레드의 글(seq 오름차순). */
  messages: readonly MessageRow[];
  myAccountId: string | null;
  turns: ThreadTurnsSnapshot;
  /** 이 스레드로 돌아올 예약 수. 못 읽었으면 `null`(아직 첫 답 전이면 0 을 준다 — 깜박임을 막는다). */
  wakes: number | null;
  /** 기다리는 작업 행 수(B1 `state=waiting`). 읽는 길이 없거나 못 읽었으면 0. */
  workWaiting?: number;
  plan: Pick<PlanProgress, 'blocked'> | null | undefined;
  /** `off`·`checking` 일 때 턴 칸을 대신할 값 — 마지막 말이 진행이고 그 에이전트가 살아 있는가(`threadState` 의 running). */
  legacyRunning: boolean;
  now: number;
}

export function threadProgress(input: ThreadProgressInput): ThreadProgress {
  const { messages, myAccountId, turns, wakes, plan, legacyRunning, now } = input;
  let lastDoneAt: string | null = null;
  let lastReplyAt: string | null = null;
  let myAsks = 0;
  let otherAsks = 0;
  let doneToday = 0;
  // 실패는 `threadState` 와 같은 규칙으로 켜고 끈다 — 누적으로 세면 한 번 실패한 스레드가 영원히 막힘이다.
  let failed = false;
  let failedBy: string | null = null;
  let gateMine = false;
  const dayStart = startOfDay(now);

  for (const m of messages) {
    const fm = readFailureMeta(m.meta);
    if (fm != null) {
      failed = true;
      failedBy = m.authorId;
      gateMine = fm.code === 'account_gate' && myAccountId != null && fm.awaitingAccountId === myAccountId;
    } else if (failed && (m.kind === 'progress' || m.kind === 'wake' || readReportMeta(m.meta) != null || m.authorId === failedBy)) {
      failed = false;
      failedBy = null;
      gateMine = false;
    }
    if (readReportMeta(m.meta) != null) {
      lastDoneAt = m.createdAt;
      if (Date.parse(m.createdAt) >= dayStart) doneToday += 1;
    }
    if (m.kind !== 'progress' && m.kind !== 'wake' && m.kind !== 'system') lastReplyAt = m.createdAt;
    const ask = readAskMeta(m.meta);
    if (!ask || !isAskOpen(ask)) continue;
    if (ask.to.kind === 'human' ? myAccountId != null : ask.to.accountId === myAccountId) myAsks += 1;
    else otherAsks += 1;
  }

  return {
    myTurn: myAsks + (failed && gateMine ? 1 : 0),
    blocked: (failed && !gateMine ? 1 : 0) + (plan?.blocked ?? 0),
    running: turns.kind === 'known' ? turns.turns.length
      : turns.kind === 'unknown' ? null
        // `off`(읽는 길 없음)와 `checking`(첫 답 전)은 옛 판정으로 물러난다 — 머리 배지가 말하던 것과 같은 값이다.
        : (legacyRunning ? 1 : 0),
    waiting: otherAsks + (wakes ?? 0) + (input.workWaiting ?? 0),
    waitingUnknown: wakes === null,
    doneToday,
    lastDoneAt,
    lastReplyAt,
  };
}

/** 띠에 설 칸이 하나도 없는가(「진행 중인 일 없음」 한 줄로 줄인다). 「모름」은 칸이다. */
export function isIdle(p: ThreadProgress): boolean {
  return p.myTurn === 0 && p.blocked === 0 && p.running === 0 && p.waiting === 0 && !p.waitingUnknown && p.doneToday === 0;
}

/**
 * 사람이 지금 볼 일이 남았는가 — 내 차례·막힘·도는 중·기다림 가운데 하나라도 서는가(「모름」도 선 것으로 친다).
 * 「오늘 끝」만 남은 스레드는 띠는 서지만 작업 서랍은 스스로 물러난다.
 */
export function hasLiveWork(p: ThreadProgress): boolean {
  return p.myTurn > 0 || p.blocked > 0 || p.running !== 0 || p.waiting !== 0 || p.waitingUnknown;
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
