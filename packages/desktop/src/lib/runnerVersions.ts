/**
 * 도는 러너가 **자기를 돌리는 오퍼레이터의 번들보다 뒤처졌는가**를 가른다.
 *
 * ## 기준은 보는 앱이 아니라 오퍼레이터다 (2026-09-29)
 *
 * 앞 판본은 `runnerVersion !== appVersion`(지금 화면을 띄운 데스크탑의 번들)으로 갈랐다. 러너를
 * 띄우는 것이 앱이던 때의 기준이다. 스펙 2026-09-20 이후 러너는 **오퍼레이터가** 띄우고, 오퍼레이터는
 * 자기 버전을 러너에 `AGENT_VERSION` 으로 심는다(`operator/src/assignments.ts`). 그런데 판정 기준은
 * 따라 옮겨지지 않아서, 같은 러너가 어느 데스크탑에서 보느냐에 따라 최신도 되고 뒤처짐도 됐다 —
 * 보는 앱보다 **새** 러너까지 `· 뒤처짐` 이 떴다(`!==` 라 앞뒤가 없다).
 *
 * 이제 기준은 그 에이전트가 배정된 오퍼레이터가 `hello` 로 알린 버전이다(`OperatorView.version`).
 * 정상이면 러너와 오퍼레이터는 같은 값이고, 다른 경우는 **오퍼레이터가 갱신된 뒤에도 옛 러너가
 * adopted 로 남은 때**뿐이다 — 재기동이 할 일인 바로 그 경우다. 그래서 `!==` 가 이제 맞는 비교다.
 *
 * 배정이 없거나 그 오퍼레이터의 버전을 모르면 **모른다**다. 앱 버전으로 물러서지 않는다 — 그
 * 물러섬이 곧 앞의 버그다.
 *
 * ## 왜 이 판정이 필요해졌나
 *
 * 러너는 daemon 이 소유하고 앱의 수명을 넘어 산다(`#431`). 그래서 앱을 새로 설치해도
 * 이미 도는 러너는 **옛 번들 그대로** 남고, `RunnerLauncher.doStartOne` 은 장부에
 * 살아 있는 러너를 보면 `adopted` 로 두고 새로 띄우지 않는다(중복 금지). 즉 번들에 담긴
 * 수정이 도는 러너에 닿는 길은 그 러너를 한 번 종료시키는 것 하나뿐이다.
 *
 * 그것을 사람이 누를 수 있게 하려면 화면이 **누구를 눌러야 하는지** 말해야 한다. 이
 * 모듈이 그 질문에만 답한다.
 *
 * ## 왜 `runnerLauncher.ts` 안이 아닌가
 *
 * 그 파일은 이미 크고, 이것은 프로세스를 만지지 않는 **순수 판정**이다. 그리고 읽는
 * 곳이 둘이다(프로필 한 에이전트, 설정의 전체 재기동) — 한 곳에 두지 않으면 두 화면이
 * 서로 다른 대상을 고르고, 그 어긋남은 조용하다.
 */

/** 러너가 `AGENT_VERSION` 을 못 받았을 때 보고하는 값(`packages/agent/src/version.ts`). */
export const UNKNOWN_RUNNER_VERSION = 'unknown';

export interface VersionedAgent {
  id: string;
  /**
   * 러너가 마지막으로 알려 준 빌드 버전(`AgentView.runnerVersion`).
   *
   * `null` 은 **한 번도 보고가 없었다**다(서버가 행을 못 만들었다). `'unknown'` 은
   * 보고는 왔지만 러너가 `AGENT_VERSION` 을 못 받았다는 뜻이다. 둘의 원인은 다르지만
   * 이 판정에는 같다 — **모른다.**
   */
  runnerVersion: string | null;
  /**
   * 이 에이전트를 돌리는 오퍼레이터(`AgentView.assignment`). 비교 기준을 여기서 찾는다.
   * 없거나 `null`(미배정)이면 기준이 없다 — **모른다.**
   */
  assignment?: { operatorId: string } | null;
}

/**
 * 오퍼레이터 id → 그 오퍼레이터가 마지막 `hello` 에 실은 버전(`GET /operators` 의 `version`).
 * 값 `null` 은 그 오퍼레이터의 버전을 모른다(옛 오퍼레이터, 소스에서 도는 개발 경로).
 */
export type OperatorVersions = ReadonlyMap<string, string | null>;

/**
 * `GET /operators` 목록을 판정의 입력으로 접는다. `version` 이 없는 항목(이 필드가 생기기 전의
 * 서버)은 `null` — 모른다 — 로 둔다.
 */
export function operatorVersionMap(operators: readonly { id: string; version?: string | null }[]): OperatorVersions {
  return new Map(operators.map((o) => [o.id, o.version ?? null]));
}

/**
 * 이 에이전트의 **비교 기준** — 배정된 오퍼레이터의 버전. 모르면 `null`.
 *
 * `operators` 가 `null` 이면(아직 못 읽음·못 읽었음) 누구의 기준도 모른다. 목록에 없는
 * 오퍼레이터(권한이 없어 안 보이는 남의 기기, 폐기된 기기)도 모른다.
 */
export function baselineOf(agent: Pick<VersionedAgent, 'assignment'>, operators: OperatorVersions | null): string | null {
  const operatorId = agent.assignment?.operatorId;
  if (!operatorId || !operators) return null;
  return operators.get(operatorId) ?? null;
}

export interface StaleRunners {
  /** 자기 오퍼레이터와 버전이 **다르다고 확인된** 러너들. 재기동 대상이다. */
  stale: string[];
  /**
   * 버전을 **모르는** 러너들 — 러너 버전을 모르거나, 비교할 오퍼레이터 버전을 모른다.
   * 재기동 대상이 아니다: 모르는 것을 뒤처졌다고 단정하면 최신 러너까지 대상에 들어가고,
   * 재기동해도 값이 여전히 `unknown` 이면 영원히 남는다. 화면은 이 개수를 따로 적는다.
   */
  unknown: string[];
}

/**
 * @param input.live 지금 러너가 있다고 보는 에이전트들. 여기 없으면 어느 목록에도 안 든다 —
 *   띄울 러너가 없는 에이전트에게 "재기동"은 할 일이 아니다(`startAll` 이 다음 기동에 띄운다).
 * @param input.operators 오퍼레이터별 버전(`operatorVersionMap`). `null` 이면(못 읽었다)
 *   **아무것도 뒤처졌다고 하지 않는다**: 비교 기준이 없는데 단정하는 것이 docs/design.md §4 가
 *   금지하는 거짓 신호다.
 */
export function staleRunners(input: {
  agents: readonly VersionedAgent[];
  live: ReadonlySet<string>;
  operators: OperatorVersions | null;
}): StaleRunners {
  const stale: string[] = [];
  const unknown: string[] = [];

  for (const agent of input.agents) {
    if (!input.live.has(agent.id)) continue;
    const baseline = baselineOf(agent, input.operators);
    if (baseline === null
      || agent.runnerVersion === null
      || agent.runnerVersion === UNKNOWN_RUNNER_VERSION) {
      unknown.push(agent.id);
      continue;
    }
    if (agent.runnerVersion !== baseline) stale.push(agent.id);
  }

  return { stale, unknown };
}
