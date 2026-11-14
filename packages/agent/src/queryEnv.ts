import type { AgentHarness } from '@harkroom/shared';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { PROVIDER_LANE_FIXED_ENV } from './providerLane.js';
import { harnessPath } from './turn.js';

/**
 * 러너가 **턴 밖에서** 하네스 CLI 에 묻는 보조 조회(opencode·kilo `session list`·`export`, pi `mcp list`)의 env.
 *
 * 부모 env 를 펼치지 않고 **허용 목록**으로 짓는다 — 실행에 필요한 것(PATH·HOME·로캘·임시 폴더·XDG)만 부모에서 고르고,
 * 그 위에 부르는 쪽의 칸(격리 홈 자리)과 그 하네스의 고정 스위치(`PROVIDER_LANE_FIXED_ENV`)를 얹는다.
 * 러너 링크 열쇠·턴 열쇠·그 밖의 `HARKROOM_*` 는 이 목록에 없어서 들어가지 않는다.
 *
 * - **PATH 는 하네스의 것**이어야 명령이 ENOENT 로 죽지 않는다(#864).
 * - **프로젝트 설정을 끈다**(스위치). 조회는 cwd 가 턴 작업 폴더라 거기 프로젝트 설정을 읽는데, 러너가 그것을 읽을 까닭이 없다.
 */
export function auxQueryEnv(
  harness: AgentHarness, base: NodeJS.ProcessEnv, extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && isQueryEnvKey(k)) env[k] = v;
  }
  return {
    ...env,
    ...extra,
    ...(PROVIDER_LANE_FIXED_ENV[harness] ?? {}),
    PATH: harnessPath(harness, base.PATH),
  };
}

/** 부모 env 에서 보조 조회로 넘기는 이름. 늘릴 때는 열쇠·토큰이 섞이지 않는지 본다. */
const QUERY_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TZ']);

function isQueryEnvKey(k: string): boolean {
  return QUERY_ENV_KEYS.has(k) || k.startsWith('LC_') || k.startsWith('XDG_');
}

/**
 * pi `mcp list`(읽기 전용 턴 앞 도구 이름 묻기)의 env. 허용 목록 위에 pi 홈 자리와 다리가 붙을 칸만 얹는다.
 *
 * pi 는 이 명령에서 MCP 서버를 **실제로 띄워** 도구를 묻는다. harkroom 다리는 오퍼레이터 소켓에 붙어야 `tools/list` 에 답한다 —
 * 소켓·runnerId 두 칸과 **그 턴의 다리 열쇠**만 준다. 러너 링크 열쇠·셸 열쇠는 넣지 않는다(열쇠는 부르는 쪽이 이 조회 앞에 맡긴다).
 */
export function piMcpListEnv(
  harness: AgentHarness, base: NodeJS.ProcessEnv, piHome: string | undefined, bridgeKey: string,
): Record<string, string> {
  const link: Record<string, string> = {};
  for (const k of [RUNNER_LINK_ENV.socketPath, RUNNER_LINK_ENV.runnerId]) {
    const v = base[k];
    if (v) link[k] = v;
  }
  return auxQueryEnv(harness, base, {
    ...link,
    [RUNNER_TURN_KEY_ENV.bridge]: bridgeKey,
    ...(piHome ? { PI_CODING_AGENT_DIR: piHome } : {}),
  });
}
