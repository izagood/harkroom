import type { AccountView, MessageRow } from '@murmur/shared';
import { bodyRecipients } from './mention';
import type { RunnerState } from './runnerLauncher';
import type { Liveness } from './threadState';

/**
 * **불렀는데 아무 일도 안 일어난다** — 그 사실을 부른 자리 바로 아래에서 말하기 위한 판정.
 *
 * ## 무엇이 빠져 있었나 — 부름과 착수 사이
 *
 * 오늘 화면이 재는 것은 **부름**이다(`lib/notified.ts` — "셋을 불렀는데 둘만 깼다").
 * 그런데 러너가 재기동 중이어도 멘션 알림은 **정상으로 닿는다**: 인박스에 항목이 들어가고
 * 서버는 "1명 불러 1명 깼다"고 정직하게 답한다. 그래서 `NotifiedGapRow` 는 아무 말도 하지
 * 않고, 사람은 자기 발화 아래의 빈칸을 5분째 쳐다본다(실측 2026-09-10, `#755` 이후).
 *
 * 빠진 것은 부름의 결과가 아니라 **착수의 부재**다. 이 파일이 그것을 잰다.
 *
 * ## 왜 전역 상태바도 팝업도 아닌가
 *
 * - **팝업**: 재기동이 시작한 순간에 떴다 사라진다. "왜 안 하지?" 는 그 몇 분 **뒤에**
 *   부른 사람에게 생기므로 그 사람은 애초에 못 본다 — 놓친 토스트는 없는 것과 같다.
 *   `UpdateToast` 주석이 이미 그 자리의 규율을 세워 뒀다: *"고칠 것도 없는 팝업을 띄우면
 *   그것이 곧 무시되는 알림이 되고, 그 다음부터는 진짜 알림도 함께 무시된다."*
 * - **하단 상태바**: 시점은 맞지만 **주어가 틀렸다.** 사람이 쳐다보는 것은 자기 발화이고
 *   상태바의 주어는 "이 기계"다. 에이전트가 여섯이면 한 줄이 말할 것이 없고, 드문 상태를
 *   위해 항구적으로 낸 줄은 안 변하는 동안 눈에서 지워진다.
 *
 * `NotifiedGapRow` 가 전역 띠(`Notice`)를 거부한 세 이유가 여기 그대로 성립한다 — 특히
 * 셋째("다음 행동을 정하는 것은 그 발화를 보면서 하는 일이다").
 *
 * ## 아는 것만 말한다
 *
 * `restarting` 은 **이 앱의 로컬 상태다**(`lib/runnerLauncher.ts`). 서버 이벤트에 없으므로
 * (`server/src/events.ts`) 러너를 띄우지 않은 기계에서는 그 값이 아예 오지 않는다. 그래서
 * 판정 입력이 둘이고 **순서가 있다**: 로컬 러너 상태를 알면 그것을 쓰고, 모르면 서버가 주는
 * presence 로 물러선다. 둘 다 모르면 **아무 말도 하지 않는다** — 모르는 것을 아는 척하는
 * 것이 `presenceView.ts` 가 없앤 바로 그 거짓말이고, 여기서 그것을 되살릴 이유가 없다.
 *
 * **`stopRequestedAt`(물러나는 중)은 이번 범위가 아니다.** 그 값은 `AgentConfig` 소속이라
 * 이 자리가 손에 든 `AccountView` 에 없다 — `faceState.ts::isStopping` 이 사이드바를 두고
 * 적어 둔 것과 **같은 사정**이다. 여기서 그것을 얻으려면 `listAgents()` 를 한 번 더
 * 왕복해야 하고, 그 방향은 이미 거부됐다("그때부터 같은 목록이 두 곳에 유지된다").
 */

/**
 * 무엇 때문에 못 답하는가. **넷뿐인 이유**: 이 값은 그대로 문구 한 줄이 되고, 문구가
 * 갈리지 않는 상태를 값으로 나누면 `Record<CallGapDetail, MessageKey>` 표가 같은 키를
 * 두 번 적는다(`RunnerStatus` 여덟 갈래를 여기서 넷으로 접는 이유).
 *
 * - `restarting` 재기동 중 — **기다리면 낫는다**
 * - `stopped`    꺼져 있다 — 사람이 켜면 낫는다
 * - `attention`  러너에 손이 필요하다(`failed`·`needs_*`) — 사람이 설정에서 고쳐야 낫는다
 * - `offline`    로컬 러너 상태를 모르고, 서버가 오프라인이라고 했다
 */
export type CallGapDetail = 'restarting' | 'stopped' | 'attention' | 'offline';

export interface CallGap {
  /** 못 답하는 에이전트. `@` 없이 담는다 — 붙이는 것은 그리는 쪽의 몫이다. */
  handle: string;
  detail: CallGapDetail;
}

/**
 * 로컬 러너 상태가 **"지금은 못 답한다"** 인가.
 *
 * `running`·`adopted` 만 빠진다. `adopted` 가 답할 수 있는 쪽인 이유는 그 이름이 바뀐
 * 사정에 있다(`RunnerStatus`): daemon 이 `kill(pid, 0)` 으로 확인한 러너라 **생사를
 * 단언할 수 있고**, 살아 있다.
 */
function detailOfRunner(state: RunnerState): CallGapDetail | null {
  switch (state.status) {
    case 'running':
    case 'adopted':
      return null;
    case 'restarting':
      return 'restarting';
    case 'stopped':
      return 'stopped';
    case 'failed':
    case 'needs_reissue':
    case 'needs_harness':
    case 'needs_login':
      return 'attention';
  }
}

export interface CallGapInput {
  /** 판정 대상 발화. 사람이 부른 그 말이다. */
  message: Pick<MessageRow,
    'kind' | 'seq' | 'authorId' | 'body' | 'createdAt' | 'activityCount'>;
  /** handle 을 풀 표이자 **누가 에이전트인지**의 정본. */
  accounts: Record<string, AccountView>;
  /** 같은 채널에 이미 실린 발화 전부. 이 안에서 `seq` 로 "뒤에 온 것"을 고른다. */
  channelMessages: MessageRow[];
  runnerStates: Record<string, RunnerState>;
  /** 지금 살아 있는 계정들. `null` 은 '모른다'(소켓이 끊겼다) — `threadState` 와 같은 규약. */
  live: Liveness;
  now: number;
  /** 이만큼 조용해야 말을 건다. */
  quietMs: number;
}

/**
 * 이 발화가 **조용한 부름**인가. 아니면 `null`.
 *
 * ## 침묵이 기본값이다
 *
 * 다섯 관문을 **전부** 지나야 한 줄이 선다. 규칙 06("없는 문은 그리지 않는다")을 결과 쪽에
 * 적용한 것이고, `NotifiedGapRow` 가 "셋을 불러 셋이 깨면 아무 말도 하지 않는" 것과 같은
 * 결이다 — 정상까지 줄을 받으면 진짜 조용한 부름의 줄이 나머지와 구별되지 않는다.
 *
 * ## `quietMs` 가 있는 이유
 *
 * 러너는 멀쩡해도 인박스를 집어 턴을 띄우기까지 몇 초가 걸린다. 그동안 이 줄을 세우면
 * **모든 멘션이 한 번씩 이 줄을 켰다 끈다** — 그 깜빡임이 곧 무시되는 신호가 된다.
 *
 * ## 하나만 돌려준다
 *
 * 이 줄은 한 줄이다. 여럿을 부르고 여럿이 못 답해도 **본문 순서로 첫 하나**만 말한다 —
 * 목록이 되면 발화 아래가 발화보다 커지고, 그 순간 이 줄은 읽히기를 그만둔다.
 */
export function callGap(input: CallGapInput): CallGap | null {
  const { message, accounts, channelMessages, runnerStates, live, now, quietMs } = input;

  // 1. 사람이 한 말이어야 한다. 진행·대기·보고는 부름이 아니다.
  if (message.kind !== 'user') return null;

  // 2. 충분히 조용했는가.
  if (now - new Date(message.createdAt).getTime() < quietMs) return null;

  // 3. 누구를 불렀는가. **`bodyRecipients` 를 그대로 지난다** — 인용 줄·코드 블록 안의
  //    `@handle` 을 서버가 부르지 않는다는 사실(`#298`·`#592`)이 그 함수에 이미 들어 있고,
  //    여기서 정규식을 새로 쓰면 판정이 두 벌이 되어 부르지도 않은 상대를 두고 줄이 선다.
  //    집합·팀(`kind !== 'account'`)은 서버가 펼치므로 이 자리에서는 명단을 모른다 — 뺀다.
  const byHandle = new Map<string, AccountView>();
  for (const a of Object.values(accounts)) byHandle.set(a.handle.toLowerCase(), a);
  const called = bodyRecipients(message.body, [...byHandle.values()].map((a) => a.handle), [])
    .filter((r) => r.kind === 'account')
    .map((r) => byHandle.get(r.handle))
    .filter((a): a is AccountView => a != null && a.kind === 'agent');
  if (called.length === 0) return null;

  // 4. 그 뒤로 아무 일도 없었는가.
  //
  //    **`activityCount` 가 함께 서는 이유**: 채널 목록에는 뿌리만 있고 답글은 스레드를 열
  //    때만 실린다(`threadStateFromFacts` 의 같은 사정). 그 수를 안 보면 열어 보지 않은
  //    스레드마다 이 줄이 서고, 그중 대부분은 이미 답을 받은 것이다.
  if ((message.activityCount ?? 0) > 0) return null;
  const calledIds = new Set(called.map((a) => a.id));
  if (channelMessages.some((m) => m.seq > message.seq && calledIds.has(m.authorId))) return null;

  // 5. 못 답한다는 것을 **아는가**. 로컬 러너 상태가 이기고, 없으면 presence 로 물러선다.
  for (const agent of called) {
    const state = runnerStates[agent.id];
    if (state) {
      const detail = detailOfRunner(state);
      if (detail) return { handle: agent.handle, detail };
      // 이 러너는 돌고 있다. presence 로 되묻지 않는다 — 이 앱이 방금 띄운 자식의 생사보다
      // 서버의 heartbeat 가 더 정확할 수 없고, 물으면 기동 직후 몇 초를 오프라인으로 읽는다.
      continue;
    }
    if (live !== null && !live.has(agent.id)) return { handle: agent.handle, detail: 'offline' };
  }
  return null;
}
