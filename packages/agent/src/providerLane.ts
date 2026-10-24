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
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { normalizeProviderBaseUrl, providerLaneFailureCode, type ProviderLaneFailureCode, type ProviderLaneMountResult } from '@harkroom/shared/providerLane';
import type { AgentHarness } from '@harkroom/shared';
import { PROVIDER_LANE_OPENCODE_ENV } from './opencodeHome.js';

/**
 * 하네스별로 lane 이 넣을 수 있는 키(security ⓑ). 여기 없는 하네스는 lane 을 못 쓴다 — 넣을 자리를 모르면
 * 키가 엉뚱한 변수로 새거나 계정 로그인으로 조용히 돈다.
 */
export const PROVIDER_LANE_ENV_KEYS: Partial<Record<AgentHarness, { baseUrl: string; token: string }>> = {
  'claude-code': { baseUrl: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' },
  // opencode 는 설정 파일의 lane provider 블록이 `{env:…}` 로 이 둘을 읽는다(`opencodeHome.ts`, ⓕ).
  opencode: PROVIDER_LANE_OPENCODE_ENV,
};

/**
 * lane 턴에 늘 얹는 고정 env(값이 아니라 하네스 동작 스위치). claude 는 하네스가 띄우는 셸·하위 프로세스의 env 에서 자격 정보를
 * 걷게 한다 — 하네스 자신은 그 턴의 키로 gateway 에 닿고, 셸은 키를 보지 못한다(2026-10-24 실측 claude 2.1.309).
 */
export const PROVIDER_LANE_FIXED_ENV: Partial<Record<AgentHarness, Readonly<Record<string, string>>>> = {
  'claude-code': { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
};

/** 이 하네스가 lane 턴에서 하위 프로세스 env 를 걷는가 — 걷으면 harkroom 브릿지에 줄 값을 MCP 설정 `env` 칸으로 따로 준다. */
export function laneScrubsSubprocessEnv(harness: AgentHarness): boolean {
  return PROVIDER_LANE_FIXED_ENV[harness]?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1';
}

/**
 * 하위 프로세스 env 걷기가 harkroom 브릿지(`mcp-bridge`)에서 빼는 이름(2026-10-24 실측 claude 2.1.309). 브릿지는 이것으로 오퍼레이터에
 * 러너임을 밝힌다 — 빠지면 lane 턴이 harkroom MCP 를 못 쓴다. 다른 `HARKROOM_*` 은 걷기 뒤에도 남는다(실측). 브릿지가 쓰는 이름만
 * 싣는다 — lane 키는 싣지 않는다(security X2).
 */
export const LANE_BRIDGE_ENV_KEYS = ['HARKROOM_RUNNER_SECRET'] as const;

/** lane 턴 전용 MCP 설정 파일 이름(러너 상태 폴더, 작업 폴더 밖, 0600 — security X1). */
export const LANE_MCP_CONFIG_FILE = 'lane-mcp.json';

/**
 * 오퍼레이터가 쓴 MCP 설정을 바탕으로 lane 턴 전용 설정을 쓴다: harkroom 항목의 `env` 칸에 `LANE_BRIDGE_ENV_KEYS` 값을 싣는다.
 * 하네스는 이 칸을 env 걷기 **뒤에** 브릿지에 얹는다(실측). 임시 파일 → rename 으로 바꿔 끼운다(동시 lane 턴이 반쯤 쓴 파일을 읽지 않게).
 * harkroom 항목이 없거나 값이 없으면 던진다 — 그대로 띄우면 브릿지가 조용히 끊긴다.
 */
export async function writeLaneMcpConfig(stateDir: string, sourcePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const doc = JSON.parse(await readFile(sourcePath, 'utf8')) as { mcpServers?: Record<string, { env?: Record<string, string> } & Record<string, unknown>> };
  const harkroom = doc.mcpServers?.harkroom;
  if (!harkroom) throw new Error('writeLaneMcpConfig: MCP 설정에 harkroom 이 없다');
  const extra: Record<string, string> = {};
  for (const key of LANE_BRIDGE_ENV_KEYS) {
    const value = env[key];
    if (!value) throw new Error(`writeLaneMcpConfig: ${key} 가 러너 env 에 없다`);
    extra[key] = value;
  }
  const out = { ...doc, mcpServers: { ...doc.mcpServers, harkroom: { ...harkroom, env: { ...(harkroom.env ?? {}), ...extra } } } };
  const path = join(stateDir, LANE_MCP_CONFIG_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
  await rename(tmp, path);
  return path;
}

/**
 * 그 턴의 주소·키를 못 받았다. **코드는 허용 목록으로 접어서 든다**(1c, security ③) — 오퍼레이터·서버가 준 문자열을 그대로
 * 들고 다니면 그것이 실패 카드·로그로 흘러간다. 문장에도 코드만 싣는다(주소·비밀 이름·경로 금지, 조건 ①).
 */
export class ProviderLaneError extends Error {
  readonly code: ProviderLaneFailureCode;
  constructor(code: string) {
    const folded = providerLaneFailureCode(code);
    super(`API 키 연결을 준비하지 못했다(${folded}) — 데스크톱의 에이전트 설정에서 API 주소·키를 확인하라`);
    this.name = 'ProviderLaneError';
    this.code = folded;
  }
}

export interface ProviderLaneDeps {
  mount(cause: string): Promise<{ status: number; body: string }>;
  /** 오퍼레이터의 턴 비밀 루트(`HARKROOM_TURN_SECRETS_DIR`). 값 파일은 이 아래에만 있어야 한다. */
  turnSecretsDir: string | null;
  /** 그 턴 결과를 오퍼레이터에 알린다(relay 통지, `notifyProviderLaneResult`). 없으면 안 알린다. */
  report?(ok: boolean, code?: ProviderLaneFailureCode): void;
}

/** 이 하네스의 lane 키를 고른다. 없으면 null. */
export function providerLaneKeys(harness: AgentHarness): { baseUrl: string; token: string } | null {
  return PROVIDER_LANE_ENV_KEYS[harness] ?? null;
}

export function createProviderLane(deps: ProviderLaneDeps): { envFor(cause: string, harness: AgentHarness): Promise<Record<string, string>> } {
  // 결과를 알린다(2a). 성공·실패 모두 — 다음 성공이 「마지막 시도」 빨간 줄을 지운다.
  const envFor = async (cause: string, harness: AgentHarness): Promise<Record<string, string>> => {
    try {
      const env = await prepare(cause, harness);
      deps.report?.(true);
      return env;
    } catch (err) {
      if (err instanceof ProviderLaneError) deps.report?.(false, err.code);
      throw err;
    }
  };
  return { envFor };

  async function prepare(cause: string, harness: AgentHarness): Promise<Record<string, string>> {
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
  }
}
