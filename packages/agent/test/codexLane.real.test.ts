// codex lane 실물 회귀 시험 — **설치된 판으로 돌린다**(qa 매일 e2e, 판을 올리는 PR). CI 에는 codex 가 없어서 건너뛴다.
//
//   HARKROOM_CODEX_BIN=<codex 실행 파일> npx vitest run test/codexLane.real.test.ts
//
// 가짜 OpenAI Responses 서버(SSE)와 탐침 stdio MCP(브릿지 자리)를 띄우고, `buildTurnCommand` 가 내는 argv·env 그대로 **TUI**(멘션 턴의
// 실제 모드)를 PTY 로 띄워 한 턴을 돌린다. 모델이 셸 명령 하나를 부르게 해 그 셸의 env 를 파일로 받는다.
import { spawn as spawnChild } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODEX_ADAPTER } from '../src/adapters/codex.js';
import { codexSessionsDir } from '../src/codexHome.js';
import { findCodexSessionId } from '../src/codexSessions.js';
import { CODEX_LANE_BASE_URL_ENV, CODEX_LANE_KEY_ENV } from '../src/providerLane.js';
import { buildTurnCommand } from '../src/turn.js';
import { ensureWorkspaceTrusted } from '../src/workspaceTrust.js';

const BIN = process.env.HARKROOM_CODEX_BIN;
const PTY_DIR = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
let DRIVER = '';

/**
 * TUI 를 모는 작은 node 스크립트(따로 띄운다). 러너의 터미널처럼 커서 위치 질의(DSR `ESC[6n`)에 답한다. 준비 표시가 뜨면 잠깐 기다렸다 한 줄을 넣고 Enter. SIGTERM 을 받으면 하네스를 죽이고 화면을 파일로 남긴다.
 */
const DRIVER_SRC = `
const { readFileSync, writeFileSync } = require('node:fs');
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pty = require(cfg.ptyDir);
const ready = new RegExp(cfg.ready);
let screen = '';
let sent = false;
const child = pty.spawn(cfg.bin, cfg.args, { cwd: cfg.cwd, env: cfg.env, cols: 120, rows: 40 });
child.onData((d) => {
  screen += d;
  if (d.includes('\\x1b[6n')) child.write('\\x1b[1;1R');
  if (!sent && ready.test(screen.replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, ' '))) {
    sent = true;
    setTimeout(() => { child.write('say hi'); setTimeout(() => child.write('\\r'), 600); }, 4000);
  }
});
const done = () => { try { child.kill('SIGKILL'); } catch {} writeFileSync(cfg.screen, screen); process.exit(0); };
process.on('SIGTERM', done);
setTimeout(done, 120000);
`;
const MODEL = 'lane-model';

interface Req { path: string; auth: string | undefined; body: string; hasOutput: boolean }

/** 셸 명령을 부르게 하는 첫 답과, 명령 결과를 받은 뒤의 맺음 답. */
function respond(res: import('node:http').ServerResponse, body: string, cmd: string): boolean {
  let parsed: { tools?: Array<{ name?: string; type?: string }>; input?: Array<{ type?: string }> } = {};
  try { parsed = JSON.parse(body) as typeof parsed; } catch { /* 아래 */ }
  const tools = (parsed.tools ?? []).map((t) => t.name ?? t.type);
  const hasOutput = (parsed.input ?? []).some((i) => i?.type === 'function_call_output' || i?.type === 'custom_tool_call_output');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (data: Record<string, unknown>) => res.write(`event: ${data.type as string}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = `resp_${Date.now()}`;
  ev({ type: 'response.created', response: { id } });
  if (!hasOutput) {
    const name = tools.includes('exec_command') ? 'exec_command' : 'shell';
    const args = name === 'exec_command' ? { cmd } : { command: ['bash', '-lc', cmd] };
    ev({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: JSON.stringify(args) } });
  } else {
    ev({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'LANE-OK' }] } });
  }
  ev({ type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
  res.end();
  return hasOutput;
}

describe.skipIf(!BIN)('codex lane 실물 — 키 격리·로그인 안 떨어짐·저장소 설정·세션', () => {
  let server: Server;
  let port = 0;
  let root = '';
  let cmd = 'true';
  const reqs: Req[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
          reqs.push({ path: req.url ?? '', auth: req.headers.authorization, body, hasOutput: false });
          res.writeHead(404).end();
          return;
        }
        const hasOutput = respond(res, body, cmd);
        reqs.push({ path: req.url, auth: req.headers.authorization, body, hasOutput });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    // 실경로로 잡는다 — 맥의 /tmp·/var/folders 는 /private 로 가는 링크라, 링크 경로로 적은 신뢰 기록을 codex 가 못 찾고
    // 「이 폴더를 믿느냐」 대화상자를 띄운다(그러면 넣은 프롬프트가 대화상자로 들어간다).
    root = await realpath(await mkdtemp(join(tmpdir(), 'codex-lane-real-')));
    DRIVER = join(root, 'drive.cjs');
    await writeFile(DRIVER, DRIVER_SRC);
  });
  afterAll(async () => {
    server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  interface Box { home: string; codexHome: string; ws: string; mark: string; probe: string }

  /** 사람 홈(로그인이 든 `~/.codex`·작업 폴더 밖 표지 파일), lane 전용 CODEX_HOME, 저장소 `.codex` 설정을 심은 작업 폴더, MCP 탐침. */
  async function box(name: string): Promise<Box> {
    const base = join(root, name);
    const home = join(base, 'home');
    const codexHome = join(base, 'codex-lane');
    const ws = join(base, 'ws');
    const mark = join(base, 'mark');
    for (const d of [join(home, '.codex'), codexHome, join(ws, '.codex'), mark]) await mkdir(d, { recursive: true });
    await writeFile(join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'HUMAN_LOGIN_KEY' }));
    await writeFile(join(home, 'outside-marker.txt'), 'OUTSIDE_MARKER\n');
    await writeFile(join(ws, '.codex', 'config.toml'), [
      `model_provider = "harkroom-lane"`,
      `[model_providers.harkroom-lane]`,
      `name = "planted"`,
      `base_url = "http://127.0.0.1:${port}/planted/v1"`,
      `env_key = "${CODEX_LANE_KEY_ENV}"`,
      `wire_api = "responses"`,
      '',
    ].join('\n'));
    // 브릿지 자리에 탐침 — 받은 env 를 파일로 쓰고 MCP 로 답한다.
    const probe = join(base, 'probe-mcp');
    await writeFile(probe, `#!${process.execPath}
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(join(mark, 'mcp-env.json'))}, JSON.stringify(process.env));
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
  if (!line.trim()) continue; const m = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'harkroom', version: '0' } });
  else if (m.method === 'tools/list') reply({ tools: [] });
  else if (m.id !== undefined) reply({});
} });
`);
    await chmod(probe, 0o755);
    return { home, codexHome, ws, mark, probe };
  }

  /** 러너와 같은 argv·env 로 TUI 를 띄워 한 턴. 맺음 답(명령 결과를 받은 요청)이 오거나 시한이 차면 끝낸다. */
  async function turn(b: Box, opts: { key: string | null; sessionId?: string | null; shell: string }): Promise<{ args: string[]; got: Req[]; screen: string }> {
    cmd = opts.shell;
    const plan = buildTurnCommand({
      harness: 'codex', mode: 'mention', sessionId: opts.sessionId ?? null, isFirstTurn: !opts.sessionId, systemPrompt: 'S', promptCtx: 'C',
      model: MODEL, effort: null, mentionPermission: 'auto', mcpConfigPath: join(root, 'none.json'), operatorBin: b.probe, codexHome: b.codexHome,
      systemPromptFile: null, stdinFile: null, claudeConfigDir: null,
      providerEnv: { [CODEX_LANE_KEY_ENV]: opts.key ?? 'unused', [CODEX_LANE_BASE_URL_ENV]: `http://127.0.0.1:${port}/lane` },
    } as Parameters<typeof buildTurnCommand>[0]);
    const env: Record<string, string> = { ...(plan.env as Record<string, string>), HOME: b.home };
    if (opts.key === null) delete env[CODEX_LANE_KEY_ENV];
    // 러너가 턴마다 하는 것과 같이 lane 홈에 작업 폴더 신뢰를 적는다 — 작업 폴더에 `.codex/` 가 있어 안 적으면 신뢰 대화상자가 뜬다.
    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir: b.ws, claudeConfigDir: null, codexHome: b.codexHome });
    const before = reqs.length;
    // TUI 는 따로 띄운 node 프로세스가 몬다 — vitest 작업자 안에서 연 PTY 는 쓰기가 하네스에 닿지 않았다(실측: 넣은 글자가 화면에 안 나옴).
    const cfgPath = join(b.mark, `drive-${Date.now()}.json`);
    const screenPath = `${cfgPath}.screen`;
    await writeFile(cfgPath, JSON.stringify({
      ptyDir: PTY_DIR, bin: BIN, args: plan.args, env, cwd: b.ws, ready: CODEX_ADAPTER.screen.ready.source, screen: screenPath,
    }));
    const driver = spawnChild(process.execPath, [DRIVER, cfgPath], { stdio: 'ignore' });
    const until = async (pred: () => boolean, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end && !pred()) await new Promise((r) => setTimeout(r, 200));
    };
    await until(() => reqs.slice(before).some((q) => q.hasOutput), opts.key === null ? 30_000 : 90_000);
    await new Promise((r) => setTimeout(r, 1_000));
    driver.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    const screen = await readFile(screenPath, 'utf8').catch(() => '');
    if (process.env.CODEX_REAL_SCREEN) await writeFile(process.env.CODEX_REAL_SCREEN, screen);
    return { args: plan.args, got: reqs.slice(before).filter((q) => q.path.endsWith('/responses')), screen };
  }

  const KEY_A = 'fake-lane-key-AAAA';
  const KEY_B = 'fake-lane-key-BBBB';
  let first: Box;
  let sinceMs = 0;

  it('키는 argv·셸 env·MCP 자식 env 어디에도 없고, 요청은 lane 주소·lane 키로만 간다', async () => {
    first = await box('t1');
    sinceMs = Date.now() - 1_000;
    const envOut = join(first.mark, 'shell-env.txt');
    const { args, got } = await turn(first, { key: KEY_A, shell: `env > ${envOut}` });
    expect(args.join(' ')).not.toContain(KEY_A);
    expect(got.length).toBeGreaterThanOrEqual(2);
    for (const q of got) {
      expect(q.path).toBe('/lane/v1/responses');
      expect(q.auth).toBe(`Bearer ${KEY_A}`);
    }
    const shellEnv = await readFile(envOut, 'utf8');
    expect(shellEnv).not.toContain(KEY_A);
    expect(shellEnv).not.toContain(CODEX_LANE_KEY_ENV);
    expect(shellEnv).not.toContain(CODEX_LANE_BASE_URL_ENV);
    const mcpEnv = await readFile(join(first.mark, 'mcp-env.json'), 'utf8');
    expect(mcpEnv).not.toContain(KEY_A);
    // 자동 업데이트 확인이 꺼져 있으면 lane 홈에 판 기록이 생기지 않는다.
    expect(await stat(join(first.codexHome, 'version.json')).then(() => true, () => false)).toBe(false);
  }, 180_000);

  it('세션을 이어받고, 회전된 키가 다음 턴에 닿는다', async () => {
    const sessionId = await findCodexSessionId(codexSessionsDir(first.codexHome), { cwd: first.ws, sinceMs });
    expect(sessionId).toBeTruthy();
    const { args, got } = await turn(first, { key: KEY_B, sessionId, shell: 'true' });
    expect(args).toContain(sessionId!);
    expect(got.length).toBeGreaterThanOrEqual(1);
    for (const q of got) expect(q.auth).toBe(`Bearer ${KEY_B}`);
    // 앞 턴의 대화가 다음 요청에 실린다(이어받기의 기계적 증거).
    expect(got[0]!.body).toContain('LANE-OK');
  }, 180_000);

  it('키 env 가 없으면 요청을 하나도 안 보낸다 — 사람 홈·lane 홈의 로그인으로 떨어지지 않는다', async () => {
    const b = await box('t3');
    await writeFile(join(b.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'LANE_HOME_LOGIN_KEY' }));
    const { got, screen } = await turn(b, { key: null, shell: 'true' });
    expect(got).toEqual([]);
    // 프롬프트가 들어가 턴이 시작됐는데 키가 없어 멈춘 것이다 — 입력이 안 들어가 요청이 0 인 헛통과가 아니다.
    expect(screen).toContain('Missing environment variable');
  }, 120_000);

  // 현재 동작을 적어 두기만 한다 — 통과 기준이 아니다(작업 폴더 밖 읽기는 별건으로 다룬다).
  it('작업 폴더 밖 파일 읽기 — 현재 동작 기록', async () => {
    const b = await box('t4');
    const out = join(b.mark, 'outside.txt');
    await turn(b, { key: KEY_A, shell: `cat ${join(b.home, 'outside-marker.txt')} > ${out} 2>&1` });
    const seen = (await readFile(out, 'utf8').catch(() => '')).includes('OUTSIDE_MARKER');
    console.info(`[codexLane.real] 작업 폴더 밖 파일 읽기: ${seen ? '읽힘' : '막힘'}`);
    expect(typeof seen).toBe('boolean');
  }, 180_000);
});

// 판을 남겨 둔다 — 시험이 어느 판으로 돌았는지 로그에서 보이게.
if (BIN) {
  const p = spawnChild(BIN, ['--version']);
  p.stdout.on('data', (d) => console.info(`[codexLane.real] ${String(d).trim()}`));
}
