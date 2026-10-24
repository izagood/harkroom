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
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { normalizeProviderBaseUrl, OPENCODE_LANE_VERSION, providerLaneFailureCode, type ProviderLaneFailureCode, type ProviderLaneMountResult } from '@harkroom/shared/providerLane';
import type { AgentHarness } from '@harkroom/shared';
import { PROVIDER_LANE_OPENCODE_PROVIDER } from './opencodeHome.js';

/**
 * 하네스별로 lane 이 넣을 수 있는 키(security ⓑ). 여기 없는 하네스는 lane 을 못 쓴다 — 넣을 자리를 모르면
 * 키가 엉뚱한 변수로 새거나 계정 로그인으로 조용히 돈다.
 */
export const PROVIDER_LANE_ENV_KEYS: Partial<Record<AgentHarness, readonly string[]>> = {
  'claude-code': ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  // opencode 는 키를 env 로 받지 않는다 — 턴 파일 경로 하나만 받고, 그 파일이 키 파일을 `{file:…}` 로 가리킨다(Y1~Y3).
  opencode: ['OPENCODE_CONFIG'],
};

/** 키 대신 턴 파일 경로를 받는 env 이름. 이 이름을 받는 하네스는 키 값을 env 로 받지 않는다. */
export const LANE_TURN_FILE_ENV = 'OPENCODE_CONFIG';

function laneUsesTurnFile(harness: AgentHarness): boolean {
  return PROVIDER_LANE_ENV_KEYS[harness]?.includes(LANE_TURN_FILE_ENV) ?? false;
}

/**
 * lane 턴에 늘 얹는 고정 env(값이 아니라 하네스 동작 스위치). claude 는 하네스가 띄우는 셸·하위 프로세스의 env 에서 자격 정보를
 * 걷게 한다 — 하네스 자신은 그 턴의 키로 gateway 에 닿고, 셸은 키를 보지 못한다(2026-10-24 실측 claude 2.1.309).
 */
export const PROVIDER_LANE_FIXED_ENV: Partial<Record<AgentHarness, Readonly<Record<string, string>>>> = {
  'claude-code': { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
  // opencode 는 사람 홈의 `~/.claude`(지시·스킬)·`~/.agents` 스킬을 싣는다 — 이 둘이 끈다(1.18.32 실측). `~/.opencode` 는 이것으로
  // 안 막혀서 홈 표지 자리(`OPENCODE_TEST_HOME`, 에이전트마다 다른 값이라 `childEnv` 가 얹는다)를 같이 준다.
  opencode: { OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1' },
};

/**
 * opencode lane 의 격리를 잰 판(1.18.32). 홈 표지 자리가 시험용 이름이라 판이 바뀌면 조용히 풀릴 수 있다 — 이 줄 밖이면
 * 띄우지 않고 `harness_version` 으로 실패한다. 새 판을 재면 여기를 넓힌다.
 */
export function opencodeLaneVersionOk(raw: string | null | undefined): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw ?? '');
  if (!m) return false;
  const { major, minor, minPatch } = OPENCODE_LANE_VERSION;
  return Number(m[1]) === major && Number(m[2]) === minor && Number(m[3]) >= minPatch;
}

/** 하네스별 판 관문 — 격리를 잰 판 밖이면 `harness_version`. 없는 하네스는 판을 묻지 않는다. */
const PROVIDER_LANE_VERSION_GATE: Partial<Record<AgentHarness, (raw: string | null) => boolean>> = {
  opencode: opencodeLaneVersionOk,
};

/** lane 턴 파일 자리(러너 상태 폴더, 작업 폴더 밖, 0700). 파일은 멘션마다 하나, 기동 때 남은 것을 걷는다. */
export const LANE_TURN_DIR = 'lane-turn';

/**
 * opencode lane 턴 파일(`OPENCODE_CONFIG`)을 쓴다. 받는 것은 주소와 **키 파일 경로**뿐이다 — 키 값도, 권한·에이전트·MCP 칸도
 * 이 파일에 들 수 없다(Z2: 공유 설정 뒤에 합쳐지므로 여기 권한 칸이 있으면 lane 권한을 덮는다). opencode 는 설정 본문의
 * `{env:…}`·`{file:…}` 를 바꿔 넣으므로 중괄호·줄바꿈이 섞인 값은 거절한다.
 */
export async function writeOpencodeLaneTurnConfig(dir: string, name: string, lane: { baseUrl: string; keyPath: string }): Promise<string> {
  if (/[{}\r\n\0]/.test(lane.baseUrl)) throw new ProviderLaneError('bad_base_url');
  if (!isAbsolute(lane.keyPath) || /[{}\r\n\0]/.test(lane.keyPath)) throw new ProviderLaneError('bad_path');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error(`writeOpencodeLaneTurnConfig: 파일 이름이 이상하다: ${name}`);
  const doc = {
    provider: {
      [PROVIDER_LANE_OPENCODE_PROVIDER]: {
        // @ai-sdk/anthropic 의 baseURL 은 `/v1` 까지다. lane 의 base URL 은 claude-code(`ANTHROPIC_BASE_URL`)와 같은 뿌리다.
        options: { baseURL: `${lane.baseUrl}/v1`, apiKey: `{file:${lane.keyPath}}` },
      },
    },
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.json`);
  await writeAtomic(path, JSON.stringify(doc));
  return path;
}

/** 기동 때 지난 러너가 남긴 턴 파일을 걷는다(키 값은 없고 키 파일 경로만 있다). 실패는 삼킨다 — 다음 기동이 다시 걷는다. */
export async function sweepLaneTurnDir(stateDir: string): Promise<void> {
  const dir = join(stateDir, LANE_TURN_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(dir, n), { force: true }).catch(() => undefined)));
}

/** 임시 파일 → rename. 쓰다 실패하면 임시 파일을 지운다(n1). */
async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

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
  const body = JSON.stringify(out);
  // 같으면 쓰지 않는다(n2) — 동시 lane 턴마다 같은 내용으로 바꿔 끼울 까닭이 없다.
  if ((await readFile(path, 'utf8').catch(() => null)) === body) return path;
  await writeAtomic(path, body);
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
  /** 러너 상태 폴더. 턴 파일은 그 아래 `LANE_TURN_DIR` 에 둔다 — 없으면 턴 파일을 쓰는 하네스(opencode)는 `no_turn_secrets_dir` 로 실패한다. */
  stateDir?: string;
  /** 하네스 판(`opencode --version` 출력). 못 읽으면 null — opencode lane 은 `harness_version` 으로 실패한다. */
  harnessVersion?(harness: AgentHarness): Promise<string | null>;
}

/** 이 하네스의 lane 턴이 자식 env 에 넣을 수 있는 이름. 없으면 null. */
export function providerLaneKeys(harness: AgentHarness): readonly string[] | null {
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
    if (!providerLaneKeys(harness)) throw new ProviderLaneError('harness_unsupported');
    if (!deps.turnSecretsDir) throw new ProviderLaneError('no_turn_secrets_dir');
    const viaTurnFile = laneUsesTurnFile(harness);
    if (viaTurnFile && !deps.stateDir) throw new ProviderLaneError('no_turn_secrets_dir');
    const versionOk = PROVIDER_LANE_VERSION_GATE[harness];
    if (versionOk) {
      const version = await (deps.harnessVersion?.(harness) ?? Promise.resolve(null)).catch(() => null);
      if (!versionOk(version)) throw new ProviderLaneError('harness_version');
    }
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
    if (viaTurnFile) {
      // 값은 읽어 검사만 한다 — opencode 에는 키 파일 경로만 간다.
      const name = cause.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'turn';
      return { [LANE_TURN_FILE_ENV]: await writeOpencodeLaneTurnConfig(join(deps.stateDir!, LANE_TURN_DIR), name, { baseUrl, keyPath: real! }) };
    }
    return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: value };
  }
}
