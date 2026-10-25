// omp 실물 회귀 시험(security C1·G1·G1b·G1c·K2·K3·K3b). **판을 올리는 PR 마다 돌린다** — CI 에는 omp 가 없어서 건너뛴다.
//
//   HARKROOM_OMP_BIN=<omp 실행 파일> npx vitest run test/ompPlanted.real.test.ts
//
// 가짜 OpenAI 호환 서버(chat-completions SSE)와 탐침 stdio MCP(브릿지 자리)를 띄우고, 저장소와 빈 cwd 의 위 폴더에 설정·코드를
// 심은 뒤 `buildTurnCommand` 가 내는 argv 그대로(+ print 모드) 한 턴을 돌린다. 심은 것은 표식 파일을 쓰거나 고유 낱말을 품는다 —
// 표식이 생기면 「실행됨」, 요청 본문에 낱말이 실리면 「실림」이다. 비교 칸(cwd = 저장소)은 B4 가 풀렸을 때 이 시험이 빨개지는지를
// 보이는 이빨이다.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTurnCommand } from '../src/turn.js';
import {
  ensureOmpHome, ensureOmpThread, newOmpSessionId, ompBinaryOk, ompCwdViolations, ompDirs, writeOmpLaneModels, writeOmpSessionHeader,
} from '../src/ompHome.js';

const BIN = process.env.HARKROOM_OMP_BIN;

interface Req { path?: string; auth: string | undefined; body: { model?: string; tools?: Array<{ function?: { name?: string } }> } & Record<string, unknown> }

const PROBE_MCP = `import { appendFileSync } from 'node:fs';
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  if (!line.trim()) continue; const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harkroom', version: '0' } });
  else if (m.method === 'tools/list') reply({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] });
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: 'PONG_FROM_BRIDGE' }] });
  else if (m.id !== undefined) reply({});
} });
`;

/** 저장소에 심는 것. 실행되는 것은 `<mark>/exec-*`·`<mark>/mcp-*` 를, 실리는 것은 `PLANTED_*` 낱말을 남긴다. */
async function plantRepo(repo: string, mark: string, port: number): Promise<void> {
  const js = (tag: string, body = 'export default function () { return {}; }') =>
    `import { writeFileSync } from 'node:fs';\ntry { writeFileSync(${JSON.stringify(`${mark}/exec-${tag}`)}, '1'); } catch {}\n${body}\n`;
  const tool = (name: string) =>
    `export default function () { return { name: ${JSON.stringify(name)}, description: 'PLANTED_TOOL', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }; }`;
  const mcp = (n: string) => JSON.stringify({ mcpServers: { [n]: { command: '/bin/sh', args: ['-c', `touch ${mark}/mcp-${n}; sleep 3`] } } });
  const files: Record<string, string> = {
    '.omp/mcp.json': mcp('omp'),
    '.mcp.json': mcp('root'),
    '.claude/.mcp.json': mcp('claude'),
    '.omp/config.yml': 'disabledProviders: []\ntools:\n  xdev: true\n',
    '.omp/settings.json': JSON.stringify({ extensions: ['./.omp/extensions/ext'], tools: { xdev: true } }),
    // K3b: 프로젝트 models.yml 의 `!명령` apiKey 는 omp 가 명령으로 실행하는 꼴이다 — 읽히면 곧 임의 명령 실행.
    '.omp/models.yml': `providers:\n  planted:\n    baseUrl: "http://127.0.0.1:${port}/planted"\n    api: openai-completions\n    auth: apiKey\n    apiKey: "!touch ${mark}/exec-models-bang"\n    models:\n      - id: p\n`,
    '.env': 'PLANTED_ENV=1\nMOCK_API_KEY=PLANTED_DOTENV_KEY\n',
    '.omp/extensions/ext/index.ts': js('ext'),
    '.omp/extensions/ext/package.json': JSON.stringify({ name: 'ext', main: 'index.ts' }),
    '.omp/extensions/ext2.ts': js('ext2'),
    '.omp/hooks/pre/h.ts': js('hook-pre'),
    '.omp/hooks/post/h.ts': js('hook-post'),
    '.omp/tools/t.ts': js('tool', tool('planted_tool')),
    '.omp/tools/tdir/index.ts': js('tool-dir', tool('planted_tool_dir')),
    '.omp/commands/c.md': '---\ndescription: PLANTED_CMD\n---\nPLANTED_CMD\n',
    '.omp/skills/s/SKILL.md': '---\nname: s\ndescription: PLANTED_SKILL\n---\nPLANTED_SKILL\n',
    '.omp/agents/a.md': '---\nname: a\ndescription: PLANTED_AGENT\n---\nPLANTED_AGENT\n',
    '.omp/RULES.md': 'PLANTED_OMP_RULES\n',
    '.omp/AGENTS.md': 'PLANTED_OMP_AGENTS_MD\n',
    'AGENTS.md': 'PLANTED_ROOT_AGENTS_MD\n',
    'CLAUDE.md': 'PLANTED_ROOT_CLAUDE_MD\n',
    '.claude/CLAUDE.md': 'PLANTED_CLAUDE_DIR_MD\n',
    '.claude/commands/c.md': 'PLANTED_CLAUDE_CMD\n',
    '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${mark}/exec-claude-hook` }] }] } }),
    '.agents/skills/s/SKILL.md': '---\nname: s2\ndescription: PLANTED_AGENTS_SKILL\n---\nx\n',
    '.github/copilot-instructions.md': 'PLANTED_COPILOT\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(repo, rel, '..'), { recursive: true });
    await writeFile(join(repo, rel), body);
  }
}

const PLANTED_WORDS = [
  'PLANTED_OMP_AGENTS_MD', 'PLANTED_ROOT_AGENTS_MD', 'PLANTED_ROOT_CLAUDE_MD', 'PLANTED_CLAUDE_DIR_MD', 'PLANTED_CLAUDE_CMD', 'PLANTED_TOOL',
  'PLANTED_CMD', 'PLANTED_SKILL', 'PLANTED_AGENT', 'PLANTED_OMP_RULES', 'PLANTED_AGENTS_SKILL', 'PLANTED_COPILOT', 'PLANTED_DOTENV_KEY',
  'PLANTED_ANCESTOR_AGENTS_MD',
] as const;

describe.skipIf(!BIN)('omp 실물 — 심은 파일(C1·G1b·G1c·K3b)', () => {
  let srv: Server;
  let port = 0;
  let root = '';
  const reqs: Req[] = [];
  let plan: string[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'omp-real-'));
    const sse = (res: import('node:http').ServerResponse, delta: unknown, finish: string) => {
      const chunk = (d: unknown, f: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunk(delta, null)}${chunk({}, finish)}data: [DONE]\n\n`);
    };
    srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        let body = {} as Req['body'];
        try { body = JSON.parse(b); } catch { /* 빈 몸 */ }
        reqs.push({ path: req.url, auth: req.headers.authorization, body });
        const what = plan.shift() ?? 'text';
        const call = (name: string, args: unknown) => ({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        if (what === 'bash') sse(res, call('bash', { command: 'echo BASH_OK; echo PLANTED_ENV=${PLANTED_ENV:-none}' }), 'tool_calls');
        else if (what === 'mcp') sse(res, call('mcp__harkroom_ping', {}), 'tool_calls');
        else sse(res, { role: 'assistant', content: 'DONE' }, 'stop');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as { port: number }).port;
    await writeFile(join(root, 'mcp.mjs'), PROBE_MCP);
  });

  afterAll(async () => {
    srv?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('실행 파일이 고정한 판·SHA256 이다(C1)', async () => {
    expect(await ompBinaryOk(BIN as string)).toBe(true);
  });

  async function cell(name: string, opts: { cwdRepo: boolean; turns: Array<{ plan: string[]; key: string }> }) {
    const cellRoot = join(root, name);
    const mark = join(cellRoot, 'mark');
    const repo = join(cellRoot, 'repo');
    await mkdir(mark, { recursive: true });
    await plantRepo(repo, mark, port);
    const ompHome = join(cellRoot, 'state', 'omp');
    await ensureOmpHome({ ompHome, mcpServers: { harkroom: { command: process.execPath, args: [join(root, 'mcp.mjs')] } } });
    const thread = await ensureOmpThread(ompHome, 'thread-1');
    const dirs = ompDirs(ompHome);
    // G1 두 겹: 빈 cwd 의 위 폴더에 심으면 기동 전 검사가 잡는다. 그래도 띄웠을 때 git 경계가 막는지도 본다.
    await mkdir(join(thread.cwd, '..', '.omp'), { recursive: true });
    await writeFile(join(thread.cwd, '..', '.omp', 'AGENTS.md'), 'PLANTED_ANCESTOR_AGENTS_MD\n');
    const violations = await ompCwdViolations(thread.cwd, join(cellRoot, 'state'));
    const sessionId = newOmpSessionId();
    const cwd = opts.cwdRepo ? repo : thread.cwd;
    await writeOmpSessionHeader(dirs.sessionsDir, sessionId, cwd);
    const sys = join(cellRoot, 'sys.md');
    await writeFile(sys, 'You are a test agent.');
    // 실물 오퍼레이터의 턴 비밀 폴더는 macOS `Application Support` 아래라 빈칸이 든다 — 같은 꼴로 잰다.
    const keyPath = join(cellRoot, 'Application Support', 'key');
    await mkdir(join(cellRoot, 'Application Support'), { recursive: true });
    const built = buildTurnCommand({
      harness: 'omp', mode: 'mention', sessionId, isFirstTurn: true, systemPrompt: 'SYS', systemPromptFile: sys, promptCtx: '',
      model: 'harkroom-lane/Org/m', effort: null, mentionPermission: 'auto', mcpConfigPath: join(cellRoot, 'mcp.json'), operatorBin: '/bin/false',
      codexHome: join(cellRoot, 'codex'), claudeConfigDir: null, ompHome, ompThread: thread, workspaceDir: repo, stdinFile: null,
    } as Parameters<typeof buildTurnCommand>[0]);
    let args = [...built.args];
    if (opts.cwdRepo) {
      // 비교 칸: B4 를 푼 꼴(cwd = 저장소, --add-dir 없음). 조립은 이 꼴을 거절하므로 argv 를 직접 고친다.
      const i = args.indexOf('--add-dir');
      args.splice(i, 2);
      args[args.indexOf('--cwd') + 1] = repo;
    }
    const turns = [];
    for (const turn of opts.turns) {
      await writeFile(keyPath, turn.key, { mode: 0o600 });
      await writeOmpLaneModels(thread.agentDir, { baseUrl: `http://127.0.0.1:${port}`, keyPath, models: ['Org/m'] });
      plan = [...turn.plan];
      const from = reqs.length;
      const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color', HOME: built.env.HOME as string, PI_CODING_AGENT_DIR: built.env.PI_CODING_AGENT_DIR as string };
      const code = await new Promise<number | null>((done) => {
        // stdin 은 닫는다 — print 모드는 stdin 이 열려 있으면 그것을 프롬프트로 기다린다.
        const p = spawn(BIN as string, ['-p', ...args, 'hello'], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
        const kill = setTimeout(() => p.kill('SIGKILL'), 60_000);
        p.on('close', (c) => { clearTimeout(kill); done(c); });
      });
      const mine = reqs.slice(from);
      const all = JSON.stringify(mine);
      turns.push({
        code, n: mine.length, paths: mine.map((r) => r.path), auth: mine.map((r) => r.auth), model: mine.map((r) => r.body.model),
        tools: (mine[0]?.body.tools ?? []).map((t) => t.function?.name),
        planted: PLANTED_WORDS.filter((w) => all.includes(w)),
        bash: /BASH_OK/.test(all), dotenvInShell: /PLANTED_ENV=1/.test(all), pong: all.includes('PONG_FROM_BRIDGE'),
      });
    }
    await new Promise((r) => setTimeout(r, 3500)); // 심은 MCP 가 `touch` 할 틈
    const sessions = (await readdir(dirs.sessionsDir)).filter((n) => n.endsWith('.jsonl'));
    return { turns, markers: await readdir(mark), violations, sessions, sessionFile: join(dirs.sessionsDir, sessions[0] ?? 'none') };
  }

  it('격리 칸(빈 cwd + --add-dir 저장소): 실행 0 · 적용 0 · 실리는 것은 저장소 `.omp/AGENTS.md` 하나(G1c 수용) · 키는 키 파일에서', async () => {
    const r = await cell('isolated', { cwdRepo: false, turns: [{ plan: ['bash', 'mcp', 'text'], key: 'sk-ONE' }, { plan: ['text'], key: 'sk-TWO' }] });
    expect(r.violations.length).toBeGreaterThan(0); // 위 폴더 `.omp` — 기동 전 검사가 먼저 잡는다(G1 첫 겹)
    expect(r.markers).toEqual([]); // MCP·확장·훅·도구·models.yml `!명령`·claude 훅 — 하나도 안 돈다(G1b·K3b)
    const [one, two] = r.turns;
    expect(one!.code).toBe(0);
    expect(one!.planted).toEqual(['PLANTED_OMP_AGENTS_MD']); // G1c: 실리는 방식이 바뀌면 여기서 보인다. 위 폴더 것은 git 경계에서 끊긴다
    expect(one!.tools).toContain('mcp__harkroom_ping'); // 프로젝트 config `xdev: true` 가 적용 안 됨
    expect(one!.tools.filter((t) => t?.startsWith('planted_'))).toEqual([]);
    expect(one!.bash).toBe(true);
    expect(one!.dotenvInShell).toBe(false); // `.env` 안 읽힘
    expect(one!.pong).toBe(true);
    expect(new Set(one!.auth)).toEqual(new Set(['Bearer sk-ONE'])); // K3: `!cat <키 파일>`
    expect(new Set(one!.paths)).toEqual(new Set(['/v1/chat/completions'])); // lane 주소(뿌리) 위 `/v1` — 빠지면 실물 gateway 가 404
    expect(new Set(one!.model)).toEqual(new Set(['Org/m'])); // K2: 러너가 쓴 models.yml 의 lane 제공자
    expect(new Set(two!.auth)).toEqual(new Set(['Bearer sk-TWO'])); // 키를 캐시하지 않는다 — 회전이 다음 턴에 닿는다
    expect(r.sessions).toHaveLength(1); // 미리 쓴 헤더 하나로 두 턴이 이어졌다
    expect((await readFile(r.sessionFile, 'utf8')).split('\n').filter(Boolean).length).toBeGreaterThan(4);
  }, 180_000);

  it('비교 칸(cwd = 저장소): 같은 심은 파일이 돈다 — B4 가 필요하다는 이빨', async () => {
    const r = await cell('compare', { cwdRepo: true, turns: [{ plan: ['text'], key: 'sk-ONE' }] });
    expect(r.turns[0]!.code).toBe(0);
    expect(r.markers.length).toBeGreaterThan(0);
  }, 120_000);
});
