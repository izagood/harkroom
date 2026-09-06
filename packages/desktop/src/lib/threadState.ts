import { readAskMeta, readFailureMeta, type MessageRow } from '@murmur/shared';

/**
 * 스레드가 지금 어떤 상태인가 — 화면 전체가 같은 어휘를 쓰기 위한 5단(규칙 03).
 *
 * - `my-turn`  내 차례. **화면에서 유일하게 강조를 받는 상태다**
 * - `stuck`    실패했거나 교착이다. 사람만이 풀 수 있으므로 실패와 같은 대접
 * - `waiting`  남을 기다린다. 진행을 막지만 나를 막지는 않는다
 * - `running`  도는 중. 답이 필요 없는 구간
 * - `done`     끝났다
 */
export type ThreadState = 'my-turn' | 'stuck' | 'waiting' | 'running' | 'done';

/**
 * 러너 생존을 **모를 수도 있다**는 것을 타입으로 강제한다.
 *
 * `null` 은 '아무도 안 살아 있다'가 아니라 **'모른다'** 다 — 소켓이 끊겼을 때가 그렇다.
 * 이 구별이 없으면 앱이 잠깐 재연결하는 동안 돌고 있는 스레드가 전부 `stuck` 으로 붉게
 * 물든다. `controller.ts::startRunners` 가 `liveAccountIds` 에 같은 규약을 쓴다
 * (`connected` 가 false 면 `null`) — 여기서 다른 규약을 쓰면 두 곳이 갈라진다.
 */
export type Liveness = Set<string> | null;

export interface ThreadStateInput {
  /** 스레드의 메시지들. 시간순이어야 한다(`seq` 오름차순). */
  messages: MessageRow[];
  myAccountId: string | null;
  /** 이 계정이 에이전트인가. 모르는 계정은 에이전트로 치지 않는다. */
  isAgent: (accountId: string) => boolean;
  /** 지금 살아 있는 에이전트들. `null` 은 '모른다'(소켓이 끊겼다). */
  live: Liveness;
}

/**
 * 스레드 상태를 판정한다. **순수 함수다** — 이 판정이 채널 요약 · 사이드바 · 스레드 목록
 * 세 곳에서 같아야 하고, 컴포넌트 안에 두면 세 곳이 조용히 갈라진다.
 *
 * ## 우선순위 — 위에서부터 이긴다
 *
 * 하나의 스레드는 한 상태만 받는다. 겹칠 때 무엇이 이기는지가 이 함수의 실질이다.
 *
 * 1. **`my-turn`** — 나에게 온 미답 선택이 있다. 강조를 받는 유일한 상태이므로 가장 세다
 * 2. **`stuck`** — 실패가 있거나, 도는 줄 알았던 에이전트가 죽었다
 * 3. **`waiting`** — 남에게 간 미답 선택이 있다
 * 4. **`running`** — 마지막 말이 진행이고 그 에이전트가 살아 있다
 * 5. **`done`** — 그 외
 *
 * `my-turn` 이 `stuck` 을 이기는 이유: 둘 다 사람을 부르지만 **`my-turn` 은 답하면 풀리고**
 * `stuck` 은 손을 대야 한다. 답 한 번으로 풀리는 것을 먼저 보여 주는 것이 개입 비용이 낮다.
 *
 * ## 죽은 러너를 "도는 중"으로 그리지 않는다
 *
 * 이 안의 **유일한 치명적 실패 모드**다 — 죽었는데 도는 중이면 사람은 영원히 기다린다.
 * 그래서 `running` 은 러너가 **살아 있다고 아는** 경우에만이고, 죽었다고 아는 경우
 * `stuck` 으로 떨어진다. **모르는 경우(`live === null`)는 둘 다 아니다** — 모른다는 이유로
 * 붉게 칠하는 것도 같은 종류의 거짓말이므로, 마지막으로 알던 사실인 `running` 을 유지한다.
 */
export function threadState(input: ThreadStateInput): ThreadState {
  const { messages, myAccountId, isAgent, live } = input;
  if (messages.length === 0) return 'done';

  let myTurn = false;
  let othersTurn = false;
  let failed = false;

  for (const m of messages) {
    if (readFailureMeta(m.meta) != null) failed = true;
    const ask = readAskMeta(m.meta);
    if (!ask || ask.answeredWith != null) continue;
    // `human` 은 '사람 아무나'이므로 내가 사람이면 내 차례다(`AskCard::isForMe` 와 같은 판정).
    if (ask.to.kind === 'human' ? myAccountId != null : ask.to.accountId === myAccountId) {
      myTurn = true;
    } else {
      othersTurn = true;
    }
  }

  const last = messages[messages.length - 1]!;
  return decide({
    myTurn,
    othersTurn,
    failed,
    lastIsProgress: last.kind === 'progress' && isAgent(last.authorId),
    lastAuthorId: last.authorId,
    live,
  });
}

/**
 * 서버가 실어 준 집계로 같은 판정을 낸다(#484 · Task 6 Step 2).
 *
 * **채널 목록에는 루트만 있다** — 답글은 스레드를 열 때만 로드되므로 위 `threadState()` 에
 * 그 배열을 넘기면 열어 보지 않은 스레드가 전부 '끝남'이 된다. 서버가 그 구멍을 메우는
 * 재료를 싣고(`openAskHumanCount`·`openAskAccountIds`·`failureCount`·`lastKind`·`lastAuthorId`),
 * 여기서 **같은 `decide()`** 를 지난다.
 *
 * 두 입구가 같은 함수를 지나는 것이 요점이다: 판정이 두 벌이면 채널에서 본 상태와 스레드를
 * 열어 본 상태가 갈라지고, 사람은 어느 쪽을 믿어야 하는지 알 수 없다.
 *
 * 재료가 없으면(`null` — 답글 행이거나 옛 서버) `null` 을 준다. **'끝남'으로 떨어뜨리지
 * 않는다**: 모르는 것을 안다고 말하는 것이 이 Task 가 고치려던 바로 그 거짓말이다.
 */
export function threadStateFromFacts(input: {
  row: Pick<MessageRow,
    'openAskHumanCount' | 'openAskAccountIds' | 'failureCount' | 'lastKind' | 'lastAuthorId'>;
  myAccountId: string | null;
  isAgent: (accountId: string) => boolean;
  live: Liveness;
}): ThreadState | null {
  const { row, myAccountId, isAgent, live } = input;
  // 다섯이 함께 오거나 함께 없다 — 하나라도 없으면 요약할 자리가 아니다.
  if (row.openAskHumanCount === null || row.openAskAccountIds === null || row.failureCount === null) {
    return null;
  }

  const toMe = row.openAskAccountIds.some((id) => id === myAccountId);
  // '사람 아무나'는 내가 사람이면 내 차례다(위와 같은 판정).
  const humanTurn = row.openAskHumanCount > 0 && myAccountId != null;

  return decide({
    myTurn: toMe || humanTurn,
    othersTurn: row.openAskAccountIds.some((id) => id !== myAccountId),
    failed: row.failureCount > 0,
    lastIsProgress: row.lastKind === 'progress' && row.lastAuthorId != null && isAgent(row.lastAuthorId),
    lastAuthorId: row.lastAuthorId,
    live,
  });
}

/**
 * **우선순위를 한 자리에서 낸다.** 두 입구(메시지 배열 / 서버 집계)가 반드시 같은 답을
 * 내야 하므로, 그 규칙을 함수 하나에 둔다 — 복사하면 언젠가 한쪽만 바뀐다.
 */
function decide(f: {
  myTurn: boolean;
  othersTurn: boolean;
  failed: boolean;
  lastIsProgress: boolean;
  lastAuthorId: string | null;
  live: Liveness;
}): ThreadState {
  if (f.myTurn) return 'my-turn';
  if (f.failed) return 'stuck';
  if (f.othersTurn) return 'waiting';

  // 마지막 말이 진행이면 그 에이전트가 지금도 도는지가 상태를 정한다.
  if (f.lastIsProgress && f.lastAuthorId) {
    if (f.live === null) return 'running';      // 모른다 — 마지막으로 알던 사실을 유지한다
    return f.live.has(f.lastAuthorId) ? 'running' : 'stuck';
  }
  return 'done';
}

/** 사람이 읽는 이름. 화면 여러 곳이 같은 말을 쓰도록 한 표에서 낸다. */
export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  'my-turn': '내 차례',
  stuck: '막힘',
  waiting: '남을 기다림',
  running: '도는 중',
  done: '끝남',
};

/**
 * 이 상태가 **강조를 받는가**. 규칙 03·04 의 실행이다 — 강조가 여러 상태에 뿌려지는 순간
 * "내 차례"라는 신호가 죽는다.
 *
 * `stuck` 도 강조를 받는다: 실패는 사람만이 풀 수 있으므로 막는 말이다. 다만 **색이 다르다**
 * (`state-stuck` = danger 축) — "네 차례다"와 "망가졌다"는 사람이 할 일이 다르다.
 */
export function isBlocking(state: ThreadState): boolean {
  return state === 'my-turn' || state === 'stuck';
}
