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
// pi 에는 권한 승인 장치가 없다. 읽기 전용은 `--tools <닫힌 목록>` 으로 건다(jaebin 결정 10-01).
// MCP 도구에는 `*` 가 안 먹으므로(실측) 턴 직전에 `pi mcp list --json` 으로 이름을 받아 적는다.
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReadonlyTools } from './adapters/contract.js';

const run = promisify(execFile);

/** 사람이 쓰는 pi 상태 루트. */
export function sourcePiDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent');
}

/** 러너 루트 안의 세션 자리(pi 기본 배치 — `sessions/--<cwd>--/<시각>_<id>.jsonl`). */
export function piSessionsDir(piHome: string): string {
  return join(piHome, 'sessions');
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
}): Promise<string> {
  const { piHome } = opts;
  const source = opts.sourceDir ?? sourcePiDir();
  await mkdir(piHome, { recursive: true, mode: 0o700 });
  await chmod(piHome, 0o700);
  await mkdir(piSessionsDir(piHome), { recursive: true, mode: 0o700 });

  const user = await readJson(join(source, 'settings.json'));
  const settings: Record<string, unknown> = {};
  for (const key of INHERITED_SETTINGS) if (user[key] !== undefined) settings[key] = user[key];
  await writeFile(join(piHome, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(piHome, 'mcp.json'),
    `${JSON.stringify({ mcpServers: toPiMcp(opts.mcpServers) }, null, 2)}\n`,
    { mode: 0o600 },
  );

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
