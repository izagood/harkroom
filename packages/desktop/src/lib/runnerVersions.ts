/**
 * 도는 러너가 **이 앱의 번들보다 뒤처졌는가**를 가른다.
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
}

export interface StaleRunners {
  /** 앱 번들과 버전이 **다르다고 확인된** 러너들. 재기동 대상이다. */
  stale: string[];
  /**
   * 버전을 **모르는** 러너들. 재기동 대상이 아니다 — 모르는 것을 뒤처졌다고 단정하면
   * 최신 러너까지 대상에 들어가고, 재기동해도 값이 여전히 `unknown` 이면 영원히 남는다.
   * 화면은 이 개수를 따로 적고 개별 재기동으로 유도한다.
   */
  unknown: string[];
}

/**
 * @param input.live 지금 러너가 있다고 보는 에이전트들. 여기 없으면 어느 목록에도 안 든다 —
 *   띄울 러너가 없는 에이전트에게 "재기동"은 할 일이 아니다(`startAll` 이 다음 기동에 띄운다).
 * @param input.appVersion 이 앱 번들의 버전. `null` 이면 **아무것도 뒤처졌다고 하지 않는다**:
 *   비교 기준이 없는데 단정하는 것이 docs/design.md §4 가 금지하는 거짓 신호다.
 */
export function staleRunners(input: {
  agents: readonly VersionedAgent[];
  live: ReadonlySet<string>;
  appVersion: string | null;
}): StaleRunners {
  const stale: string[] = [];
  const unknown: string[] = [];

  for (const agent of input.agents) {
    if (!input.live.has(agent.id)) continue;
    if (input.appVersion === null
      || agent.runnerVersion === null
      || agent.runnerVersion === UNKNOWN_RUNNER_VERSION) {
      unknown.push(agent.id);
      continue;
    }
    if (agent.runnerVersion !== input.appVersion) stale.push(agent.id);
  }

  return { stale, unknown };
}
