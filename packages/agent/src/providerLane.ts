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
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { CODEX_LANE_MEASURED_VERSIONS, KILO_LANE_MEASURED_VERSIONS, normalizeProviderBaseUrl, OMP_LANE_MEASURED_VERSIONS, OPENCODE_LANE_MEASURED_VERSIONS, PI_LANE_MEASURED_VERSIONS, providerLaneFailureCode, type ProviderLaneFailureCode, type ProviderLaneMountResult } from '@harkroom/shared/providerLane';
import type { AgentHarness } from '@harkroom/shared';
import { PROVIDER_LANE_OPENCODE_PROVIDER, providerLaneModelId } from './opencodeHome.js';

/** codex lane 의 키를 담는 env 이름 — provider `env_key` 가 이 이름을 읽는다. */
export const CODEX_LANE_KEY_ENV = 'HARKROOM_LANE_API_KEY';
/** codex lane 의 주소를 조립(`buildTurnCommand`)까지 실어 나르는 이름. 자식 env 에는 넣지 않는다. */
export const CODEX_LANE_BASE_URL_ENV = 'HARKROOM_LANE_BASE_URL';

/**
 * omp lane 의 주소·키 파일 경로를 조립까지 실어 나르는 이름(둘 다 자식 env 에는 넣지 않는다). 러너가 그 스레드의
 * `models.yml` 에 주소와 `apiKey: "!cat <키 파일>"` 을 쓴다(`ompHome.ts::writeOmpLaneModels`, security K1~K3a).
 */
export const OMP_LANE_BASE_URL_ENV = 'HARKROOM_OMP_LANE_BASE_URL';
export const OMP_LANE_KEY_FILE_ENV = 'HARKROOM_OMP_LANE_KEY_FILE';

/** pi lane 의 주소·키 파일 경로를 조립까지 실어 나르는 이름(둘 다 자식 env 에는 넣지 않는다). 러너가 그 스레드의 `models.json` 에 쓴다(`piHome.ts::writePiLaneModels`). */
export const PI_LANE_BASE_URL_ENV = 'HARKROOM_PI_LANE_BASE_URL';
export const PI_LANE_KEY_FILE_ENV = 'HARKROOM_PI_LANE_KEY_FILE';

/**
 * 하네스별로 lane 이 넣을 수 있는 키(security ⓑ). 여기 없는 하네스는 lane 을 못 쓴다 — 넣을 자리를 모르면
 * 키가 엉뚱한 변수로 새거나 계정 로그인으로 조용히 돈다.
 */
export const PROVIDER_LANE_ENV_KEYS: Partial<Record<AgentHarness, readonly string[]>> = {
  'claude-code': ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  // opencode 는 키를 env 로 받지 않는다 — 턴 파일 경로 하나만 받고, 그 파일이 키 파일을 `{file:…}` 로 가리킨다(Y1~Y3).
  opencode: ['OPENCODE_CONFIG'],
  // kilo 도 턴 파일 경로 하나만 받는다 — 이름은 `KILO_CONFIG` 다(7.8.17 실측).
  kilo: ['KILO_CONFIG'],
  // codex 는 provider 의 `env_key` 로 키를 읽는다(`codexLaneArgs`). 주소는 env 로 받지 않는다 — 설정 키 `base_url` 은 env 를 못 읽어
  // argv 로만 간다. 그래서 주소는 `CODEX_LANE_BASE_URL_ENV` 로 조립까지만 실어 나르고 자식 env 에서는 뺀다(`PROVIDER_LANE_ARGV_ONLY_KEYS`).
  codex: [CODEX_LANE_KEY_ENV, CODEX_LANE_BASE_URL_ENV],
  // omp 는 키를 env 로 받지 않는다 — env 에 두면 bash·MCP 자식이 그대로 본다(실측 K3). 둘 다 조립에만 쓴다.
  omp: [OMP_LANE_BASE_URL_ENV, OMP_LANE_KEY_FILE_ENV],
  // pi 도 omp 와 같다 — 키를 env 에 두지 않고 `models.json` 이 키 파일을 `!cat` 으로 가리킨다. 둘 다 조립에만 쓴다.
  pi: [PI_LANE_BASE_URL_ENV, PI_LANE_KEY_FILE_ENV],
};

/**
 * lane 턴에 모델 이름이 꼭 있어야 하는 하네스(opencode 는 `opencodeLaneModelMissing` 이 따로 본다). codex 는 비면 자기 기본 모델 이름을
 * gateway 에 보내 API 오류로 끝난다 — 키를 받기 전에 `bad_model` 로 멈춘다. 모델은 `--model` 로 argv 에 가므로 문법도 같이 본다.
 */
const PROVIDER_LANE_NEEDS_MODEL: Partial<Record<AgentHarness, true>> = { codex: true, pi: true };

/** lane 턴인데 이 하네스가 모델 이름을 꼭 받아야 하고, 그 값이 비었거나 문법(`providerLaneModelId`)에 안 맞는가. */
export function laneModelMissing(lane: boolean, harness: AgentHarness, model: string | null | undefined): boolean {
  return lane && PROVIDER_LANE_NEEDS_MODEL[harness] === true && providerLaneModelId(model) === null;
}

/** 허용 목록에 있지만 하네스 env 에는 넣지 않는 이름 — argv 조립에만 쓴다. */
export const PROVIDER_LANE_ARGV_ONLY_KEYS: Partial<Record<AgentHarness, readonly string[]>> = {
  codex: [CODEX_LANE_BASE_URL_ENV],
  omp: [OMP_LANE_BASE_URL_ENV, OMP_LANE_KEY_FILE_ENV],
  pi: [PI_LANE_BASE_URL_ENV, PI_LANE_KEY_FILE_ENV],
};

/** codex lane 의 provider 이름(`model_providers.<이름>`). */
export const CODEX_LANE_PROVIDER = 'harkroom-lane';

/**
 * codex lane 턴의 `-c` 덮어쓰기(codex-cli 0.154.0 실측, 2026-10-24, 가짜 Responses 서버·가짜 키). `-c` 는 `CODEX_HOME/config.toml` 보다 이긴다.
 *
 * - provider: `env_key` 로 키를 env 에서 읽는다 — argv 에는 이름만 있다. 그 env 가 없으면 codex 는 요청 없이 `Missing environment
 *   variable` 로 끝난다 — 홈에 `auth.json` 이 있어도 그쪽으로 떨어지지 않았다(실측).
 * - 셸 env 걷기 셋: 기본값의 codex 는 **키를 셸에 그대로 넘겼다**. `shell_environment_policy` 만 고치면 exec 는 막히지만 TUI(멘션 턴의
 *   모드)는 셸 스냅숏이 로그인 셸 env 를 되살려 **여전히 보였다** — 스냅숏·로그인 셸을 같이 끈다(둘 다 끈 뒤 셸 env 에 키 없음, 실측).
 * - 자동 업데이트 확인을 끈다 — 턴 사이에 판이 바뀌면 관문을 지난 판과 도는 판이 갈린다(opencode 와 같은 이유).
 */
export function codexLaneArgs(baseUrl: string): string[] {
  const p = `model_providers.${CODEX_LANE_PROVIDER}`;
  return [
    '-c', `model_provider=${JSON.stringify(CODEX_LANE_PROVIDER)}`,
    '-c', `${p}.name=${JSON.stringify(CODEX_LANE_PROVIDER)}`,
    // gateway 가 받는 OpenAI 꼴 경로는 `/v1/responses` 다 — lane 주소는 claude·opencode 와 같은 뿌리라 `/v1` 을 붙인다.
    '-c', `${p}.base_url=${JSON.stringify(`${baseUrl}/v1`)}`,
    '-c', `${p}.env_key=${JSON.stringify(CODEX_LANE_KEY_ENV)}`,
    '-c', `${p}.wire_api="responses"`,
    '-c', 'check_for_update_on_startup=false',
    '-c', 'features.shell_snapshot=false',
    '-c', 'allow_login_shell=false',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.exclude=${JSON.stringify([CODEX_LANE_KEY_ENV, CODEX_LANE_BASE_URL_ENV])}`,
  ];
}

/** 키 대신 턴 파일 경로를 받는 env 이름(하네스별). 이 이름을 받는 하네스는 키 값을 env 로 받지 않는다. */
export const LANE_TURN_FILE_ENV: Partial<Record<AgentHarness, string>> = { opencode: 'OPENCODE_CONFIG', kilo: 'KILO_CONFIG' };

function laneTurnFileEnv(harness: AgentHarness): string | null {
  const name = LANE_TURN_FILE_ENV[harness];
  return name && (PROVIDER_LANE_ENV_KEYS[harness]?.includes(name) ?? false) ? name : null;
}

/**
 * lane 턴의 홈 표지 자리 이름(`opencodeLaneHome` 을 가리킨다, `childEnv` 가 얹는다). 이 이름이 하네스가 보는 `~` 를 바꿔
 * 사람 홈의 `~/.opencode`·`~/.kilo` 설정이 lane 턴에 안 실린다. opencode 이름은 kilo 에서 안 먹는다(7.8.17 실측).
 */
export const LANE_TEST_HOME_ENV: Partial<Record<AgentHarness, string>> = { opencode: 'OPENCODE_TEST_HOME', kilo: 'KILO_TEST_HOME' };

/**
 * lane 턴에 늘 얹는 고정 env(값이 아니라 하네스 동작 스위치). claude 는 하네스가 띄우는 셸·하위 프로세스의 env 에서 자격 정보를
 * 걷게 한다 — 하네스 자신은 그 턴의 키로 gateway 에 닿고, 셸은 키를 보지 못한다(2026-10-24 실측 claude 2.1.309).
 */
export const PROVIDER_LANE_FIXED_ENV: Partial<Record<AgentHarness, Readonly<Record<string, string>>>> = {
  'claude-code': { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' },
  // opencode 는 사람 홈의 `~/.claude`(지시·스킬)·`~/.agents` 스킬을 싣는다 — 이 둘이 끈다(1.18.32 실측). `~/.opencode` 는 이것으로
  // 안 막혀서 홈 표지 자리(`OPENCODE_TEST_HOME`, 에이전트마다 다른 값이라 `childEnv` 가 얹는다)를 같이 준다.
  // 자동 업데이트도 끈다 — 턴 사이에 판이 바뀌면 관문을 지난 판과 도는 판이 갈린다(security F1, 1.18.32 코드에서 이 이름을 확인).
  // 프로젝트 설정도 끈다 — lane 턴의 설정은 러너가 쓴 홈 설정과 턴 파일만이다. 작업 폴더 검사(`laneWorkspaceGuard`)와 두 겹이다
  // (회귀선 `test/opencodeLaneProjectConfig.real.test.ts`).
  opencode: {
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  },
  // kilo 7.8.17 실측(가짜 서버·가짜 키, 2026-10-24) — 이름은 `KILO_*` 다.
  // - `KILO_DISABLE_PROJECT_CONFIG`: lane 턴은 프로젝트 설정을 읽지 않는다(회귀 시험 `kiloLaneProjectConfig.real.test.ts`).
  // - `KILO_DISABLE_CLAUDE_CODE`·`KILO_DISABLE_EXTERNAL_SKILLS`: 사람 홈의 `~/.claude`(CLAUDE.md·스킬)·`~/.agents` 스킬이 요청 본문에서 빠졌다.
  // - `KILO_DISABLE_AUTOUPDATE`: 이름만 opencode 규칙으로 맞췄다(효과는 못 쟀다) — 판이 바뀌면 턴마다 잰 판과 견줘 경고한다.
  kilo: { KILO_DISABLE_PROJECT_CONFIG: '1', KILO_DISABLE_CLAUDE_CODE: '1', KILO_DISABLE_EXTERNAL_SKILLS: '1', KILO_DISABLE_AUTOUPDATE: '1' },
};

/*
 * 하네스 판이 API 키 연결 격리를 **잰 판**인가(2026-10-25 — 관문이 아니다, jaebin). 아니어도 턴은 돈다 — 러너는 그 (하네스, 판)을 처음 볼 때
 * 스레드에 경고 한 줄을 남기고(`laneUnmeasuredNotice`) 러너 로그에는 매 턴 남긴다. 판은 **턴마다** 묻는다 — 하네스가 스스로 업데이트할 수 있다.
 * 잰 판과 **정확히** 같을 때만 「잰 판」이다 — 패치 판도 실물 시험으로 다시 재고 목록에 더한다.
 */

/** opencode — 출력은 숫자 판 한 줄. */
export function opencodeLaneVersionOk(raw: string | null | undefined): boolean {
  const version = (raw ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(version) && (OPENCODE_LANE_MEASURED_VERSIONS as readonly string[]).includes(version);
}

/** codex — 출력은 `codex-cli <판>` 한 줄(0.154.0 실측). */
export function codexLaneVersionOk(raw: string | null | undefined): boolean {
  const m = /^codex-cli (\d+\.\d+\.\d+)$/.exec((raw ?? '').trim());
  return m !== null && (CODEX_LANE_MEASURED_VERSIONS as readonly string[]).includes(m[1]!);
}

/** omp — 출력은 `omp/<판>` 한 줄(18.12.6 실측). */
export function ompLaneVersionOk(raw: string | null | undefined): boolean {
  const m = /^omp\/(\d+\.\d+\.\d+)$/.exec((raw ?? '').trim());
  return m !== null && (OMP_LANE_MEASURED_VERSIONS as readonly string[]).includes(m[1]!);
}

/** kilo — 출력은 숫자 판 한 줄(7.8.17 실측). */
export function kiloLaneVersionOk(raw: string | null | undefined): boolean {
  const version = (raw ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(version) && (KILO_LANE_MEASURED_VERSIONS as readonly string[]).includes(version);
}

/** pi — 출력은 숫자 판 한 줄(1.4.0 실측). */
export function piLaneVersionOk(raw: string | null | undefined): boolean {
  const version = (raw ?? '').trim();
  return /^\d+\.\d+\.\d+$/.test(version) && (PI_LANE_MEASURED_VERSIONS as readonly string[]).includes(version);
}

/** 하네스별 잰 판 — 판을 묻는 하네스만 있다. 판 판정과 경고 문장에 쓰는 목록을 한 줄에 둔다. */
const PROVIDER_LANE_MEASURED: Partial<Record<AgentHarness, { ok: (raw: string | null) => boolean; versions: readonly string[] }>> = {
  opencode: { ok: opencodeLaneVersionOk, versions: OPENCODE_LANE_MEASURED_VERSIONS },
  kilo: { ok: kiloLaneVersionOk, versions: KILO_LANE_MEASURED_VERSIONS },
  codex: { ok: codexLaneVersionOk, versions: CODEX_LANE_MEASURED_VERSIONS },
  omp: { ok: ompLaneVersionOk, versions: OMP_LANE_MEASURED_VERSIONS },
  pi: { ok: piLaneVersionOk, versions: PI_LANE_MEASURED_VERSIONS },
};

/**
 * 잰 판 밖(또는 판을 못 읽음)일 때 스레드에 남기는 한 줄. 무엇이 풀릴 수 있는지는 적지 않는다(공개 코드 문구, security G1).
 * 판 출력은 한 줄 64자까지만 싣는다 — 하네스가 낸 글자를 그대로 흘리지 않게.
 */
export function laneUnmeasuredNotice(harness: AgentHarness, raw: string | null, measured: readonly string[]): string {
  const seen = (raw ?? '').trim().split(/\r?\n/)[0]!.slice(0, 64).replace(/[^\x20-\x7e]/g, '') || '판을 읽지 못함';
  return `⚠ ${harness} ${seen} — 이 판에서 API 키 연결 격리를 확인하지 않았다(확인한 판: ${measured.join(' · ')}). 턴은 그대로 진행한다.`;
}

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
 * harkroom 항목에는 `alwaysLoad` 를 단다 — 그 도구들이 처음부터 도구 목록에 오른다(도구 찾기를 거치지 않아도 답을 올릴 수 있게,
 * claude 2.1.310 실측). 다른 항목은 그대로 둔다.
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
  const out = { ...doc, mcpServers: { ...doc.mcpServers, harkroom: { ...harkroom, alwaysLoad: true, env: { ...(harkroom.env ?? {}), ...extra } } } };
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
  /** 러너 상태 폴더. 턴 파일은 그 아래 `LANE_TURN_DIR` 에 둔다 — 없으면 턴 파일을 쓰는 하네스(opencode·kilo)는 `no_turn_secrets_dir` 로 실패한다. */
  stateDir?: string;
  /** 하네스 판(`<하네스> --version` 출력). 못 읽으면 null — 막지 않고 경고한다(`laneUnmeasuredNotice`). */
  harnessVersion?(harness: AgentHarness): Promise<string | null>;
  /**
   * codex lane 전용 `CODEX_HOME`(`providerLaneCodexDir`). 여기에 `auth.json` 이 있으면 띄우지 않는다(`harness_login_present`) —
   * 러너는 이 홈에 로그인을 링크하지 않으므로, 있으면 누가 넣은 것이고 provider 덮어쓰기가 빠지는 순간 그 로그인으로 돈다.
   */
  codexHome?: string;
}

/** 이 하네스의 lane 턴이 자식 env 에 넣을 수 있는 이름. 없으면 null. */
export function providerLaneKeys(harness: AgentHarness): readonly string[] | null {
  return PROVIDER_LANE_ENV_KEYS[harness] ?? null;
}

export function createProviderLane(deps: ProviderLaneDeps): {
  envFor(cause: string, harness: AgentHarness): Promise<Record<string, string>>;
  release(env: Record<string, string>): Promise<void>;
  /** 그 멘션의 `envFor` 가 남긴 잰 판 밖 경고(있으면 한 번만 돌려주고 지운다). */
  takeNotice(cause: string): string | null;
} {
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
  // 턴 파일은 이 러너의 턴 파일 자리 안의 것만 지운다 — env 에 실린 다른 경로는 건드리지 않는다.
  const release = async (env: Record<string, string>): Promise<void> => {
    const path = Object.values(LANE_TURN_FILE_ENV).map((name) => env[name]).find(Boolean);
    if (!path || !deps.stateDir) return;
    const rel = relative(join(deps.stateDir, LANE_TURN_DIR), path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/')) return;
    await rm(path, { force: true });
  };
  // 잰 판 밖 경고 — (하네스, 판) 을 이 러너가 처음 볼 때 한 번만 스레드에 싣는다(에이전트마다 러너가 하나라 에이전트 단위다).
  const noticed = new Set<string>();
  const pendingNotice = new Map<string, string>();
  const takeNotice = (cause: string): string | null => {
    const text = pendingNotice.get(cause) ?? null;
    pendingNotice.delete(cause);
    return text;
  };
  return { envFor, release, takeNotice };

  async function prepare(cause: string, harness: AgentHarness): Promise<Record<string, string>> {
    if (!providerLaneKeys(harness)) throw new ProviderLaneError('harness_unsupported');
    if (!deps.turnSecretsDir) throw new ProviderLaneError('no_turn_secrets_dir');
    const viaTurnFile = laneTurnFileEnv(harness);
    if (viaTurnFile && !deps.stateDir) throw new ProviderLaneError('no_turn_secrets_dir');
    // 판으로 막지 않는다(2026-10-25 jaebin). 잰 판 밖이면 러너 로그에 매 턴, 스레드에는 처음 볼 때 한 번 경고한다.
    const measured = PROVIDER_LANE_MEASURED[harness];
    if (measured) {
      const version = await (deps.harnessVersion?.(harness) ?? Promise.resolve(null)).catch(() => null);
      if (!measured.ok(version)) {
        const notice = laneUnmeasuredNotice(harness, version, measured.versions);
        console.warn(`[providerLane] ${notice}`);
        const key = `${harness}\0${(version ?? '').trim()}`;
        if (!noticed.has(key)) {
          noticed.add(key);
          pendingNotice.set(cause, notice);
        }
      }
    }
    // codex lane 홈 검사는 키를 꺼내기(mount) **전에** 한다 — 띄우지 않을 턴이 임대를 받지 않게(security n1).
    const usesCodexKey = providerLaneKeys(harness)?.includes(CODEX_LANE_KEY_ENV) ?? false;
    if (usesCodexKey) {
      if (!deps.codexHome) throw new ProviderLaneError('no_turn_secrets_dir');
      if (await lstat(join(deps.codexHome, 'auth.json')).then(() => true, () => false)) throw new ProviderLaneError('harness_login_present');
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
    if (usesCodexKey) {
      return { [CODEX_LANE_KEY_ENV]: value, [CODEX_LANE_BASE_URL_ENV]: baseUrl };
    }
    // omp: 값은 읽어 검사만 한다 — `models.yml` 에는 키 파일 경로만 간다(K1·K3a). 파일은 오퍼레이터의 턴 임대 자리라 턴 끝에 걷힌다.
    if (providerLaneKeys(harness)?.includes(OMP_LANE_KEY_FILE_ENV)) {
      return { [OMP_LANE_BASE_URL_ENV]: baseUrl, [OMP_LANE_KEY_FILE_ENV]: real! };
    }
    // pi: omp 와 같다 — 값은 검사만, `models.json` 에는 키 파일 경로만 간다.
    if (providerLaneKeys(harness)?.includes(PI_LANE_KEY_FILE_ENV)) {
      return { [PI_LANE_BASE_URL_ENV]: baseUrl, [PI_LANE_KEY_FILE_ENV]: real! };
    }
    if (viaTurnFile) {
      // 값은 읽어 검사만 한다 — opencode 에는 키 파일 경로만 간다.
      const name = cause.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || 'turn';
      return { [viaTurnFile]: await writeOpencodeLaneTurnConfig(join(deps.stateDir!, LANE_TURN_DIR), name, { baseUrl, keyPath: real! }) };
    }
    return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: value };
  }
}
