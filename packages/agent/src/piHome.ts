// pi 의 러너 전용 상태 루트(`PI_CODING_AGENT_DIR`) — codex 의 `CODEX_HOME`, opencode 의 XDG 루트와
// 같은 자리이고 같은 이유다: 사람의 설정·세션과 갈라 두지 않으면 운영자 개인 MCP·확장이 에이전트
// 턴에 붙는다(spec §7).
//
// ## 무엇을 물려받나 (실측 2026-10-01, pi 0.99.2)
// - `auth.json`(로그인)·`models.json`(사람이 정의한 제공자) — **링크**한다. 사람이 키를 바꾸면 다음
//   턴에 그대로 닿는다. 둘 다 없을 수 있다(환경변수 키만 쓰는 사람) — 그때는 만들지 않는다.
// - `settings.json` 에서는 **기본 제공자·모델만** 고른다. 나머지(`packages` 확장·`defaultTools` 등)는
//   들이지 않는다 — 확장은 pi 프로세스 안에서 실행되는 코드다.
// - `mcp.json` 은 **물려받지 않고 새로 쓴다** — 오퍼레이터의 표(harkroom 브릿지 등)만 들어간다.
//
// ## 읽기 전용 허용 목록 (`readonlyTools`)
// pi 에는 권한 승인 장치가 없다. 읽기 전용은 `--tools <닫힌 목록>` 으로 건다(소유자 결정 10-01).
// MCP 도구에는 `*` 가 안 먹으므로(실측) 턴 직전에 `pi mcp list --json` 으로 이름을 받아 적는다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReadonlyTools } from './adapters/contract.js';

const run = promisify(execFile);

/** 사람이 쓰는 pi 상태 루트. */
export function sourcePiDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
}

/**
 * 러너 루트 안의 세션 자리. **매 턴 `--session-dir` 로 못박는다**(`turn.ts`, security U1 2026-10-01).
 *
 * pi 는 세션을 고를 때 cwd 의 `.pi/settings.json` 의 `sessionDir` 을 **프로젝트 신뢰 판정 전에**
 * 읽는다(`--no-approve` 로도 안 막힌다 — pi `docs/security.md` "cannot undo that initial
 * session-directory lookup"). 저장소가 `"sessionDir": "./notes"` 를 심으면 지시문·대화·MCP 결과가
 * 저장소 안에 쌓이고 `git add -A` 한 번에 공개된다. CLI 인자는 프로젝트 설정을 이긴다.
 *
 * 이 인자를 주면 배치가 평평해진다: `<dir>/<시각>_<id>.jsonl`(cwd 폴더 없음). id 로 찾는 것은
 * 그대로 되고(`SessionManager.findById` 가 cwd 도 대조한다 — security 실측), 재개도 실물로 쟀다.
 */
export function piSessionsDir(piHome: string): string {
  return join(piHome, 'sessions');
}

/** 이 세션 id 의 기록 파일(`<시각>_<id>.jsonl`). 비밀 보관소 D7 의 가리기 대상이다. 없으면 `null`. */
export async function piSessionFile(piHome: string, sessionId: string): Promise<string | null> {
  const dir = piSessionsDir(piHome);
  const names = await readdir(dir).catch(() => [] as string[]);
  const hit = names.filter((n) => n.endsWith(`_${sessionId}.jsonl`)).sort().at(-1);
  return hit ? join(dir, hit) : null;
}

interface ClaudeStyleStdio { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
interface ClaudeStyleRemote { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
type ClaudeStyleServer = ClaudeStyleStdio | ClaudeStyleRemote;

/**
 * 오퍼레이터의 표(claude 형식)를 pi 의 `mcp.json` 항목으로. 모양이 거의 같다 — stdio 는
 * `command`·`args`·`env`, 원격은 `url`·`headers`. **모든 서버를 `direct` 로 둔다**: 기본(`codemode`)이면
 * 도구가 모델에 선언되지 않고 스크립트로만 닿아, 에이전트가 `message.post` 를 바로 부르지 못한다.
 * 모르는 갈래는 버린다(잘못 만든 항목 하나가 설정 전체를 거절시킬 수 있다 — opencode 와 같은 규율).
 */
export function toPiMcp(servers: Record<string, ClaudeStyleServer>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(servers)) {
    if ('url' in def && typeof def.url === 'string') {
      out[name] = { url: def.url, exposure: 'direct', ...(def.headers ? { headers: def.headers } : {}) };
      continue;
    }
    if ('command' in def && typeof def.command === 'string') {
      out[name] = {
        command: def.command,
        ...(def.args ? { args: def.args } : {}),
        ...(def.env ? { env: def.env } : {}),
        exposure: 'direct',
      };
    }
  }
  return out;
}

/** pi 가 MCP 도구에 붙이는 이름(`docs/mcp.md`): `mcp__<server>__<tool>`, 영숫자·`_` 밖은 `_`. */
export function piToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/** `pi mcp list --json` 출력 → 서버별 도구 이름. 모양이 다르면 `null`. */
export function parsePiMcpList(stdout: string): Record<string, string[]> | null {
  try {
    const parsed = JSON.parse(stdout) as { servers?: Array<{ name?: unknown; tools?: unknown }> };
    if (!Array.isArray(parsed.servers)) return null;
    const out: Record<string, string[]> = {};
    for (const s of parsed.servers) {
      if (typeof s.name !== 'string' || !Array.isArray(s.tools)) continue;
      out[s.name] = s.tools.filter((t): t is string => typeof t === 'string');
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 읽기 전용 턴의 `--tools` 값. **닫힌 목록**이다 — 내장 읽기 도구 + `mcpServers` 의 도구만.
 * 서버 도구를 못 받았으면(`null`) 내장만 남긴다: 답할 길을 잃는 쪽이 쓰기가 열리는 쪽보다 낫다.
 */
export function readonlyToolList(spec: ReadonlyTools, discovered: Record<string, string[]> | null): string {
  const names = [...spec.builtins];
  for (const server of spec.mcpServers) {
    for (const tool of discovered?.[server] ?? []) names.push(piToolName(server, tool));
  }
  return names.join(',');
}

/** 턴 직전에 하네스에게 MCP 도구 이름을 묻는다. 실패하면 `null`(로그는 부르는 쪽이 남긴다). */
export async function listPiMcpTools(opts: {
  command: string; args: readonly string[]; env: Record<string, string>; cwd: string;
}): Promise<Record<string, string[]> | null> {
  try {
    const res = await run(opts.command, [...opts.args], {
      env: opts.env, cwd: opts.cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    });
    return parsePiMcpList(res.stdout);
  } catch (err) {
    console.warn(`[piHome] MCP 도구 목록 실패 (${opts.command}): ${(err as Error).message}`);
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return readFile(path, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>, () => ({}));
}

/** 사람 설정에서 물려받을 키. 목록을 늘릴 때는 머리말의 판단을 다시 읽어라. */
const INHERITED_SETTINGS = ['defaultProvider', 'defaultModel'] as const;
/** 링크로 재사용하는 사람 파일. */
const LINKED_FILES = ['auth.json', 'models.json'] as const;

/**
 * 러너 전용 pi 루트를 만들고(없으면) 로그인·제공자를 링크하고 설정·MCP 를 쓴다.
 * 매 턴 불러도 되게 **멱등**이다(오퍼레이터의 표가 바뀔 수 있다).
 */
export async function ensurePiHome(opts: {
  piHome: string;
  mcpServers: Record<string, ClaudeStyleServer>;
  sourceDir?: string;
  /**
   * API 키 연결 턴의 홈(`piLaneThreadHome`)이면 참. 사람 설정·로그인·제공자를 하나도 물려받지 않는다 — 모델은 그 턴의
   * `models.json`(`writePiLaneModels`) 하나다. 전에 링크해 둔 것이 있으면 **링크만** 뗀다(사람 파일은 안 건드린다).
   */
  lane?: boolean;
}): Promise<string> {
  const { piHome } = opts;
  const source = opts.sourceDir ?? sourcePiDir();
  await mkdir(piHome, { recursive: true, mode: 0o700 });
  await chmod(piHome, 0o700);
  await mkdir(piSessionsDir(piHome), { recursive: true, mode: 0o700 });

  const user = opts.lane ? {} : await readJson(join(source, 'settings.json'));
  const settings: Record<string, unknown> = {};
  for (const key of INHERITED_SETTINGS) if (user[key] !== undefined) settings[key] = user[key];
  await writeFile(join(piHome, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(piHome, 'mcp.json'),
    `${JSON.stringify({ mcpServers: toPiMcp(opts.mcpServers) }, null, 2)}\n`,
    { mode: 0o600 },
  );

  if (opts.lane) {
    for (const file of LINKED_FILES) {
      const to = join(piHome, file);
      if ((await lstat(to).catch(() => null))?.isSymbolicLink()) await unlink(to);
    }
    return piHome;
  }

  for (const file of LINKED_FILES) {
    const from = join(source, file);
    const to = join(piHome, file);
    if (!(await lstat(from).catch(() => null))) continue;
    const st = await lstat(to).catch(() => null);
    if (!st) {
      await symlink(from, to);
      continue;
    }
    // codex·opencode 와 같은 규율: 러너 전용 파일이 이미 있으면 보존하고, 엉뚱한 곳을 가리키는
    // 링크만 크게 실패시킨다 — 자동 교체는 사람이 로그인한 파일을 지울 수 있다.
    if (st.isSymbolicLink() && resolve(piHome, await readlink(to)) !== resolve(from)) {
      throw new Error(
        `Harkroom pi ${file} 링크가 예상과 다르다: ${to} -> ${await readlink(to)}. `
          + `예상 대상은 ${from} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.`,
      );
    }
  }
  return piHome;
}

/** API 키 연결 턴의 provider 이름(`models.json`). 모델은 `harkroom-lane/<gateway 모델 id>` 로 부른다. */
export const PI_LANE_PROVIDER = 'harkroom-lane';

/**
 * API 키 연결 턴의 pi 홈(`PI_CODING_AGENT_DIR`) — **스레드마다** 가른다. `models.json` 이 그 턴의 키 파일 경로를 담으므로
 * 한 파일을 여러 스레드가 같이 쓰면 동시에 도는 턴이 서로의 경로를 덮는다(omp 와 같은 이유). 세션도 이 아래에 쌓인다.
 */
export function piLaneThreadHome(laneRoot: string, threadKey: string): string {
  return join(laneRoot, 'threads', createHash('sha256').update(threadKey).digest('hex').slice(0, 24));
}

/**
 * lane 홈에 로그인이 들어 있는가. 같은 provider 이름의 로그인은 `models.json` 의 키를 이긴다(1.4.0 실측) — 있으면 띄우지 않는다
 * (`harness_login_present`). pi 는 첫 기동 때 빈 `{}` 를 스스로 만든다 — 그것은 로그인이 아니다. 못 읽거나 JSON 이 아니면 있다고 본다.
 */
export async function piLaneLoginPresent(piHome: string): Promise<boolean> {
  const path = join(piHome, 'auth.json');
  const st = await lstat(path).catch(() => null);
  if (!st) return false;
  if (st.isSymbolicLink()) return true;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return !(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
  } catch {
    return true;
  }
}

/**
 * lane 의 `models.json`. 주소는 https 이거나 루프백이어야 하고, 키는 파일 경로만 `!cat` 으로 가리킨다 — `!` 로 시작하는 값은 pi 가
 * **명령으로 실행**한다(문서 models-configuration) — `/bin/sh -c` 로 돈다(실측). 경로는 작은따옴표로 감싸고, 빈칸 밖의 셸 특수 문자·작은따옴표는 거절한다 — macOS 앱 데이터 폴더(`Application Support`)에 빈칸이 있다. 키 값은 이 파일에 들지 않는다.
 */
export function piLaneModelsJson(lane: { baseUrl: string; keyPath: string; models: readonly string[] }): string {
  const url = new URL(lane.baseUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('piLaneModelsJson: https 또는 로컬 주소만 받는다');
  if (/[^A-Za-z0-9/._ -]/.test(lane.keyPath) || !lane.keyPath.startsWith('/')) throw new Error('piLaneModelsJson: 키 파일 경로가 이상하다');
  for (const m of lane.models) if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(m)) throw new Error('piLaneModelsJson: 모델 이름이 이상하다');
  const doc = {
    providers: {
      [PI_LANE_PROVIDER]: {
        // gateway 의 OpenAI 꼴 경로는 `/v1/chat/completions` 다 — lane 주소는 claude·opencode 와 같은 뿌리라 `/v1` 을 붙인다.
        baseUrl: `${lane.baseUrl}/v1`,
        api: 'openai-completions',
        apiKey: `!cat '${lane.keyPath}'`,
        models: lane.models.map((id) => ({ id })),
      },
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export async function writePiLaneModels(piHome: string, lane: { baseUrl: string; keyPath: string; models: readonly string[] }): Promise<string> {
  const path = join(piHome, 'models.json');
  // 링크였으면(지난 비-lane 홈) 사람 파일을 덮지 않게 링크부터 뗀다.
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) await unlink(path);
  await writeFile(path, piLaneModelsJson(lane), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

/**
 * lane 스레드 홈을 마련한다(멱등) — 루트(`ensurePiHome({ lane: true })` 가 쓴 것)의 `settings.json`·`mcp.json` 을 턴마다 다시 베낀다
 * (오퍼레이터의 표가 바뀔 수 있다). 링크로 남은 로그인·제공자는 뗀다. `models.json` 은 그 턴이 쓴다(`writePiLaneModels`).
 */
export async function ensurePiLaneThread(laneRoot: string, threadKey: string): Promise<string> {
  const home = piLaneThreadHome(laneRoot, threadKey);
  for (const dir of [join(laneRoot, 'threads'), home, piSessionsDir(home)]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  for (const name of ['settings.json', 'mcp.json']) {
    await writeFile(join(home, name), await readFile(join(laneRoot, name), 'utf8'), { mode: 0o600 });
    await chmod(join(home, name), 0o600);
  }
  for (const file of LINKED_FILES) {
    const to = join(home, file);
    if ((await lstat(to).catch(() => null))?.isSymbolicLink()) await unlink(to);
  }
  return home;
}
