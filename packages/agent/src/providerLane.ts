/**
 * 전용 제공사 경로(provider lane) — 러너 쪽. 흐름과 지키는 것은 `@harkroom/shared/providerLane` 머리 주석.
 *
 * 러너는 오퍼레이터가 `HARKROOM_PROVIDER_LANE=1` 로 띄웠을 때만 이 길을 쓴다. 그때:
 * - 계정 축은 **에이전트 전용 config 디렉터리 하나**다(`laneAccount`). 계정 풀·`~/.claude` 로그인을 쓰지 않으므로
 *   페일오버·사용량 배정·로그인 경고에 들어가지 않는다(security ⓒ).
 * - 턴마다 PTY 직전에 `envFor` 가 오퍼레이터에서 base URL 과 값 파일 경로를 받아, 그 턴 하네스 env 에 넣을 키를
 *   돌려준다. 못 받으면 **던진다** — 계정 로그인으로 떨어지지 않는다(fail-closed).
 * - 값은 이 프로세스의 env 에 두지 않는다. 받은 맵은 그 턴의 plan 에만 실린다.
 */
import { readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import { normalizeProviderBaseUrl, type ProviderLaneMountResult } from '@harkroom/shared/providerLane';
import type { AgentHarness } from '@harkroom/shared';

/**
 * 하네스별로 lane 이 넣을 수 있는 키(security ⓑ). 여기 없는 하네스는 lane 을 못 쓴다 — 넣을 자리를 모르면
 * 키가 엉뚱한 변수로 새거나 계정 로그인으로 조용히 돈다.
 */
export const PROVIDER_LANE_ENV_KEYS: Partial<Record<AgentHarness, { baseUrl: string; token: string }>> = {
  'claude-code': { baseUrl: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' },
};

export class ProviderLaneError extends Error {
  constructor(readonly code: string) {
    super(`전용 제공사 경로(provider lane)를 준비하지 못했다: ${code} — 데스크톱의 에이전트 설정에서 주소·비밀을 확인하라`);
    this.name = 'ProviderLaneError';
  }
}

export interface ProviderLaneDeps {
  mount(cause: string): Promise<{ status: number; body: string }>;
  /** 오퍼레이터의 턴 비밀 루트(`HARKROOM_TURN_SECRETS_DIR`). 값 파일은 이 아래에만 있어야 한다. */
  turnSecretsDir: string | null;
}

/** 이 하네스의 lane 키를 고른다. 없으면 null. */
export function providerLaneKeys(harness: AgentHarness): { baseUrl: string; token: string } | null {
  return PROVIDER_LANE_ENV_KEYS[harness] ?? null;
}

export function createProviderLane(deps: ProviderLaneDeps): { envFor(cause: string, harness: AgentHarness): Promise<Record<string, string>> } {
  return {
    async envFor(cause, harness) {
      const keys = providerLaneKeys(harness);
      if (!keys) throw new ProviderLaneError('harness_unsupported');
      if (!deps.turnSecretsDir) throw new ProviderLaneError('no_turn_secrets_dir');
      let res: { status: number; body: string };
      try { res = await deps.mount(cause); } catch { throw new ProviderLaneError('operator_unreachable'); }
      let body: Partial<ProviderLaneMountResult> & { error?: { code?: unknown } } = {};
      try { body = JSON.parse(res.body) as typeof body; } catch { /* 아래에서 */ }
      if (res.status !== 200) {
        throw new ProviderLaneError(typeof body.error?.code === 'string' ? body.error.code : `http_${res.status}`);
      }
      if (!body.lane) throw new ProviderLaneError('lane_unset');
      const baseUrl = normalizeProviderBaseUrl(body.lane.baseUrl);
      if (!baseUrl) throw new ProviderLaneError('bad_base_url');
      // 값 파일은 오퍼레이터의 턴 비밀 루트 아래에만 있어야 한다 — 다른 자리를 읽으면 엉뚱한 파일이 키가 된다.
      const path = typeof body.lane.path === 'string' ? body.lane.path : '';
      const real = await realpath(path).catch(() => null);
      const root = await realpath(deps.turnSecretsDir).catch(() => null);
      const rel = real && root ? relative(root, real) : '..';
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ProviderLaneError('bad_path');
      const value = (await readFile(real!, 'utf8').catch(() => '')).replace(/\r?\n$/, '');
      if (!value || /[\r\n\0]/.test(value)) throw new ProviderLaneError('bad_value');
      return { [keys.baseUrl]: baseUrl, [keys.token]: value };
    },
  };
}
