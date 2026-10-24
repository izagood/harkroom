// omp(oh-my-pi)의 러너 전용 상태 루트 — pi 의 `piHome.ts` 와 같은 자리이고 같은 이유다(spec §7). 다른 점은
// omp 가 **저장소 설정을 신뢰를 묻지 않고 읽는다**는 것이다(researcher 실측 2026-10-24, security 판정 B4·C1~C6·G1·K1~K3b).
//
// ## 모양
// ```
// <ompHome>/home/            HOME — 로그·`run/session-owners`·natives 캐시가 `$HOME/.omp` 에 남는다(C3)
// <ompHome>/agent/           PI_CODING_AGENT_DIR — config.yml·models.yml·mcp.json·sessions(600/700)
// <ompHome>/overlay.yml      `--config` 오버레이(C4) — 외부 출처·mcp-json 차단, xdev 끄기, 설정 마법사 끄기
// <ompHome>/cwd/<스레드 해시>/ 턴의 cwd — `git init` 한 빈 폴더(B4·G1). 작업 저장소는 `--add-dir` 로 붙인다
// ```
// 상위 폴더는 러너 상태 폴더라 `.omp/`·`.mcp.json`·`.claude/`·`.env` 가 없어야 한다(C2) — `ompCwdViolations` 가 턴마다 본다.
//
// ## 사람 설정은 물려받지 않는다
// 사람의 `~/.omp/agent` 에는 extensions 만 있었다(실측). omp 는 **API 키 연결(lane)** 로만 돈다 — 제공자는
// 러너가 쓴 `models.yml` 하나이고, 그 `baseUrl` 은 러너만 정한다(K2). 키 값은 파일에 쓰지 않고
// `apiKey: "!cat <턴 키 파일>"` 로 그 턴의 임대 파일을 가리킨다(K1·K3·K3a).
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReadonlyTools } from './adapters/contract.js';

const run = promisify(execFile);

/** omp 가 받는 판(security C1). 넓히려면 심은 파일 회귀 시험(`test/ompPlanted.real.test.ts`)을 그 판으로 다시 돌린다. */
export const OMP_VERSIONS = ['18.12.6'] as const;
/**
 * 공식 릴리스 바이너리의 SHA256(C1) — 릴리스의 `SHA256SUMS.txt` 를 옮겼다. 키는 `${process.platform}-${process.arch}`.
 * darwin-arm64 는 researcher·harkroom 이 따로 받아 그 목록과 대조했다(2026-10-24). npm 판(bun 위에서 도는 스크립트)은 받지 않는다.
 */
export const OMP_BINARY_SHA256: Record<string, Readonly<Record<string, string>>> = {
  '18.12.6': {
    'darwin-arm64': 'cfbb5e38cd8f8a3be55e710700be587d287deaacdc58c9b0a661c5086bccfe58',
    'darwin-x64': '62d6e6fd88b6fa5de2ca82842906f152bf1aa227559b1d0bb386f25f6d606123',
    'linux-arm64': 'eee8e586274cef2e725c218b2b28b48ca9965d46dd58f60998cb347eca4ad0cf',
    'linux-x64': '85d9daf3a05fc76e8cd425ae1904eb576af8d21cc85fcf4690742626e07ccfa4',
  },
};

/** PATH 에서 `omp` 실행 파일을 찾는다(앞의 것이 이긴다 — PTY 가 띄울 것과 같은 규칙). 없으면 `null`. */
export async function findOmpBinary(path: string | undefined): Promise<string | null> {
  for (const dir of (path ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'omp');
    const st = await stat(candidate).catch(() => null);
    if (st?.isFile()) return realpath(candidate);
  }
  return null;
}

const hashCache = new Map<string, string>();

/** 고정한 판의 공식 바이너리가 아닐 때 스레드에 남기는 한 줄(security G2 — 막지 않는다). 경로는 싣지 않는다. */
export function ompUnverifiedBinaryNotice(): string {
  return `⚠ omp — 실행 파일이 확인한 공식 바이너리가 아니다(확인한 판: ${OMP_VERSIONS.join(' · ')}). 턴은 그대로 진행한다.`;
}

/**
 * 그 실행 파일이 고정한 판의 공식 바이너리인가(C1). 해시는 (경로·크기·mtime)이 같으면 다시 재지 않는다 — 200MB 라 턴마다 재면 느리다.
 * 표에 없는 판·플랫폼은 거절한다(fail-closed).
 */
export async function ompBinaryOk(binary: string, platformKey = `${process.platform}-${process.arch}`): Promise<boolean> {
  const want = OMP_VERSIONS.map((v) => OMP_BINARY_SHA256[v]?.[platformKey]).filter((h): h is string => Boolean(h));
  if (!want.length) return false;
  const st = await stat(binary).catch(() => null);
  if (!st?.isFile()) return false;
  const key = `${binary}:${st.size}:${st.mtimeMs}`;
  let got = hashCache.get(key);
  if (!got) {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(binary)) h.update(chunk as Buffer);
    got = h.digest('hex');
    hashCache.set(key, got);
  }
  return want.includes(got);
}

/** 러너가 쓰는 omp 제공자 이름(`models.yml` `providers.<이름>`). */
export const OMP_LANE_PROVIDER = 'harkroom-lane';

export interface OmpDirs { home: string; agentDir: string; sessionsDir: string; overlay: string; cwdRoot: string }

export function ompDirs(ompHome: string): OmpDirs {
  return {
    home: join(ompHome, 'home'),
    agentDir: join(ompHome, 'agent'),
    sessionsDir: join(ompHome, 'agent', 'sessions'),
    overlay: join(ompHome, 'overlay.yml'),
    cwdRoot: join(ompHome, 'cwd'),
  };
}

/**
 * `--config` 오버레이(C4). 배열은 덧붙지 않고 **갈아끼워진다**(문서 settings.md) — 그래서 막을 목록을 다 적는다.
 * - `disabledProviders`: 외부 발견 출처 전부 + 독립 `mcp.json`(`mcp-json`)·`agents-md`. `native` 는 끄지 않는다 —
 *   agentdir 의 `mcp.json`(우리 브릿지)도 native 다(실측 B3). 저장소 쪽 native 는 cwd 를 옮겨 막는다(B4).
 * - `enabledProviders: []`: 사용자 수준 외부 루트를 들이지 않는다(기본값이지만 사람 설정이 덮지 않게 못박는다).
 * - `tools.xdev: false`: MCP 도구를 모델에 바로 선언한다(기본은 `xd://` 뒤에 숨어 `message.post` 를 못 부른다).
 * - `startup.setupWizard: false`: 첫 기동의 로그인 마법사가 주입을 삼킨다(실측).
 * - `startup.checkUpdate: false`: 판 고정(C1). 이름은 바이너리 문자열로만 확인했다 — 효과는 미측정.
 */
export const OMP_OVERLAY = [
  'disabledProviders:',
  ...['claude', 'claude-plugins', 'codex', 'gemini', 'github', 'opencode', 'cursor', 'windsurf', 'agents-md', 'mcp-json']
    .map((id) => `  - ${id}`),
  'enabledProviders: []',
  'tools:',
  '  xdev: false',
  'startup:',
  '  setupWizard: false',
  '  checkUpdate: false',
  '',
].join('\n');

interface ClaudeStyleStdio { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
interface ClaudeStyleRemote { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
type ClaudeStyleServer = ClaudeStyleStdio | ClaudeStyleRemote;

/** 오퍼레이터의 표(claude 형식) → omp `mcp.json` 항목. 모양이 같다 — 모르는 갈래는 버린다(pi 와 같은 규율). */
export function toOmpMcp(servers: Record<string, ClaudeStyleServer>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(servers)) {
    if ('url' in def && typeof def.url === 'string') {
      out[name] = { type: def.type ?? 'http', url: def.url, ...(def.headers ? { headers: def.headers } : {}) };
      continue;
    }
    if ('command' in def && typeof def.command === 'string') {
      out[name] = { command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
    }
  }
  return out;
}

/**
 * 읽기 전용 턴의 `--tools` 값(R). 닫힌 목록이다 — 내장 읽기 도구 + 우리 서버의 글롭 `mcp__<서버>_*`.
 * omp 는 MCP 이름을 `mcp__<서버>_<도구>` 로 짓고(밑줄 하나) 글롭이 먹는다(실측). `mcp__*` 는 쓰지 않는다(security R).
 */
export function ompReadonlyToolList(spec: ReadonlyTools): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  return [...spec.builtins, ...spec.mcpServers.map((s) => `mcp__${clean(s)}_*`)].join(',');
}

export interface OmpThreadDirs { cwd: string; agentDir: string }

/**
 * 스레드(세션 레코드 키)마다 고정한 자리 둘.
 * - `cwd`: 빈 폴더. 세션 헤더의 `cwd` 와 같아야 재개된다(실측) — 그래서 턴마다 새로 만들지 않는다.
 * - `agentDir`: 그 스레드의 `PI_CODING_AGENT_DIR`. lane 의 `models.yml` 이 **그 턴의 키 파일 경로**를 담으므로
 *   한 파일을 여러 스레드가 같이 쓰면 동시에 도는 턴이 서로의 경로를 덮는다 — 스레드마다 가른다.
 */
export function ompThreadDirs(ompHome: string, threadKey: string): OmpThreadDirs {
  const hash = createHash('sha256').update(threadKey).digest('hex').slice(0, 24);
  const root = join(ompDirs(ompHome).cwdRoot, hash);
  return { cwd: join(root, 'cwd'), agentDir: join(root, 'agent') };
}

/**
 * 스레드 자리를 만든다(멱등). cwd 는 `git init` 한다 — 위로 거슬러 찾는 `.omp/AGENTS.md` 를 git 경계가 끊는다(G1).
 * agentDir 에는 공유 루트의 `config.yml`·`mcp.json` 을 턴마다 다시 쓴다(오퍼레이터의 표가 바뀔 수 있다).
 */
export async function ensureOmpThread(ompHome: string, threadKey: string): Promise<OmpThreadDirs> {
  const t = ompThreadDirs(ompHome, threadKey);
  for (const dir of [dirname(t.cwd), t.cwd, t.agentDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  if (!(await lstat(join(t.cwd, '.git')).catch(() => null))) {
    await run('git', ['init', '-q', t.cwd], { timeout: 15_000 });
  }
  const shared = ompDirs(ompHome).agentDir;
  for (const name of ['config.yml', 'mcp.json']) {
    await writeFile(join(t.agentDir, name), await readFile(join(shared, name), 'utf8'), { mode: 0o600 });
    await chmod(join(t.agentDir, name), 0o600);
  }
  return t;
}

/** 빈 cwd 와 그 위 폴더에 있으면 안 되는 이름(C2). */
const OMP_CWD_FORBIDDEN = ['.omp', '.mcp.json', '.claude', '.env', '.agents', 'AGENTS.md', 'CLAUDE.md'] as const;

/**
 * 빈 cwd 와 그 위 폴더에서 금지 이름을 찾는다(C2). cwd 자신은 `.git` 말고 아무것도 없어야 한다.
 * 위로는 `stopAt`(러너 상태 폴더)까지만 본다 — 그 위는 사람의 홈이라 `~/.claude`·`~/.omp` 가 늘 있다.
 * 그 자리는 두 겹으로 막는다: 위로 찾는 것은 `.omp/AGENTS.md` 뿐이고 cwd 의 git 경계가 끊는다(G1, 실측),
 * `HOME` 을 옮겨 `~/.omp/agent` 도 안 본다(C3). 찾은 경로를 돌려준다 — 비면 통과.
 */
export async function ompCwdViolations(dir: string, stopAt: string): Promise<string[]> {
  const found: string[] = [];
  const own = await readdir(dir).catch(() => [] as string[]);
  for (const name of own) if (name !== '.git') found.push(join(dir, name));
  const stop = resolve(stopAt);
  let cur = dirname(resolve(dir));
  if (cur !== stop && !cur.startsWith(`${stop}/`)) throw new Error(`ompCwdViolations: ${dir} 가 ${stopAt} 안에 없다`);
  for (;;) {
    for (const name of OMP_CWD_FORBIDDEN) {
      if (await lstat(join(cur, name)).catch(() => null)) found.push(join(cur, name));
    }
    if (cur === stop) break;
    cur = dirname(cur);
  }
  return found;
}

/**
 * 세션 헤더 한 줄 파일을 미리 쓴다 — omp 에는 `--session-id` 가 없다. 이 파일이 있으면 `--resume <id>` 가 그 id 로
 * 이어 간다(실측). 깨지는 조건은 `cwd` 불일치 하나였다(version·파일 이름·UUID 꼴은 상관없었다). 있으면 건드리지 않는다.
 */
export async function writeOmpSessionHeader(sessionsDir: string, sessionId: string, cwd: string, now = new Date()): Promise<string> {
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const names = await readdir(sessionsDir).catch(() => [] as string[]);
  const hit = names.find((n) => n.endsWith(`_${sessionId}.jsonl`) || n === `${sessionId}.jsonl`);
  if (hit) return join(sessionsDir, hit);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(sessionsDir, `${stamp}_${sessionId}.jsonl`);
  const header = { type: 'session', version: 3, id: sessionId, timestamp: now.toISOString(), cwd };
  await writeFile(path, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

/** 이 세션 id 의 기록 파일. 비밀 보관소 D7 의 가리기 대상이다. 없으면 `null`. */
export async function ompSessionFile(ompHome: string, sessionId: string): Promise<string | null> {
  const dir = ompDirs(ompHome).sessionsDir;
  const names = await readdir(dir).catch(() => [] as string[]);
  const hit = names.filter((n) => n.endsWith(`_${sessionId}.jsonl`) || n === `${sessionId}.jsonl`).sort().at(-1);
  return hit ? join(dir, hit) : null;
}

/** 첫 턴의 세션 id. omp 는 UUIDv7 을 쓰지만 꼴은 상관없었다(실측) — 러너의 다른 하네스와 같은 v4 를 쓴다. */
export function newOmpSessionId(): string {
  return randomUUID();
}

/**
 * lane 의 `models.yml`(K1·K2·K3). 주소는 https 이거나 로컬이어야 하고, 키는 파일 경로만 `!cat` 으로 가리킨다.
 * `!` 로 시작하는 값은 omp 가 **명령으로 실행**한다(문서 models.md) — 경로에 셸 특수 문자가 섞이면 거절한다.
 */
export function ompLaneModelsYml(lane: { baseUrl: string; keyPath: string; models: readonly string[] }): string {
  const url = new URL(lane.baseUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('ompLaneModelsYml: https 또는 로컬 주소만 받는다');
  if (/[^A-Za-z0-9/._-]/.test(lane.keyPath) || !lane.keyPath.startsWith('/')) throw new Error('ompLaneModelsYml: 키 파일 경로가 이상하다');
  for (const m of lane.models) if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(m)) throw new Error('ompLaneModelsYml: 모델 이름이 이상하다');
  return [
    'providers:',
    `  ${OMP_LANE_PROVIDER}:`,
    `    baseUrl: ${JSON.stringify(lane.baseUrl)}`,
    '    api: openai-completions',
    '    auth: apiKey',
    `    apiKey: ${JSON.stringify(`!cat ${lane.keyPath}`)}`,
    '    models:',
    ...lane.models.flatMap((m) => [`      - id: ${JSON.stringify(m)}`]),
    '',
  ].join('\n');
}

/**
 * 러너 전용 omp 루트를 만들고 오버레이·MCP 를 쓴다. 매 턴 불러도 되게 **멱등**이다.
 * `models.yml` 은 여기서 쓰지 않는다 — lane 이 턴마다 쓴다(`writeOmpLaneModels`).
 */
export async function ensureOmpHome(opts: { ompHome: string; mcpServers: Record<string, ClaudeStyleServer> }): Promise<string> {
  const d = ompDirs(opts.ompHome);
  for (const dir of [opts.ompHome, d.home, d.agentDir, d.sessionsDir, d.cwdRoot]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
  await writeFile(d.overlay, OMP_OVERLAY, { mode: 0o600 });
  await chmod(d.overlay, 0o600);
  // agentdir 의 config.yml 도 같은 값을 둔다 — 오버레이가 빠진 기동(사람이 같은 홈으로 띄운 것 등)에도 마법사·xdev 가 같다.
  await writeFile(join(d.agentDir, 'config.yml'), OMP_OVERLAY, { mode: 0o600 });
  await writeFile(join(d.agentDir, 'mcp.json'), `${JSON.stringify({ mcpServers: toOmpMcp(opts.mcpServers) }, null, 2)}\n`, { mode: 0o600 });
  return opts.ompHome;
}

/** lane 턴의 `models.yml` 을 그 스레드의 agentDir 에 600 으로 쓴다(K1). */
export async function writeOmpLaneModels(agentDir: string, lane: { baseUrl: string; keyPath: string; models: readonly string[] }): Promise<string> {
  const path = join(agentDir, 'models.yml');
  await writeFile(path, ompLaneModelsYml(lane), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
