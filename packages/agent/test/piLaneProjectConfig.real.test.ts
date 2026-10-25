// pi lane 실물 회귀 시험 — 저장소 설정 무시·사람 로그인 무시. **판을 올리는 PR 마다 돌린다** — CI 에는 pi 가 없어서 건너뛴다.
//
//   HARKROOM_PI_BIN=<pi 실행 파일> npx vitest run test/piLaneProjectConfig.real.test.ts
//
// 가짜 OpenAI chat-completions 서버를 띄우고, 러너와 같은 lane 스레드 홈·`models.json`·`buildTurnCommand` 의 인자로 `pi -p` 한 턴을 돌린다.
// 요청은 lane 주소로, lane 키로만 가야 하고, 지시는 러너가 준 것만 실려야 한다. 비교 칸이 이빨이다: 저장소를 믿게 하면, context 파일
// 끄기를 빼면 무엇이 달라지는지, lane 홈에 로그인이 있으면 키가 바뀌는지(그래서 러너가 `harness_login_present` 로 멈춘다).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePiHome, ensurePiLaneThread, PI_LANE_PROVIDER, piLaneLoginPresent, writePiLaneModels } from '../src/piHome.js';
import { PI_LANE_BASE_URL_ENV, PI_LANE_KEY_FILE_ENV } from '../src/providerLane.js';
import { buildTurnCommand } from '../src/turn.js';

const BIN = process.env.HARKROOM_PI_BIN;
const MODEL = 'lane-model';
const LANE_KEY = 'fake-lane-key';
const RUNNER_WORD = 'RUNNER_INSTRUCTION_MARK';

interface Req { path: string; auth: string | undefined; body: string }

function sse(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: 'assistant', content: 'ok' }, null);
  chunk({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
}

describe.skipIf(!BIN)('pi lane 실물 — 저장소 설정·사람 로그인 무시', () => {
  let server: Server;
  let port = 0;
  let root = '';
  const reqs: Req[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        reqs.push({ path: req.url ?? '', auth: req.headers.authorization, body });
        if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) return sse(res);
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    root = await mkdtemp(join(tmpdir(), 'pi-lane-pc-'));
  });
  afterAll(async () => {
    server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** 저장소·위 폴더·사람 홈에 `harkroom-lane` 을 다른 주소·키로 다시 정의하는 설정과 실행되면 표식을 남기는 확장을 심는다. */
  async function plant(name: string): Promise<{ ws: string; home: string; mark: string }> {
    const base = join(root, `case-${name}`);
    const ws = join(base, 'a', 'ws');
    const home = join(base, 'human-home');
    const mark = join(base, 'mark');
    await mkdir(mark, { recursive: true });
    const models = (tag: string) => JSON.stringify({ providers: { [PI_LANE_PROVIDER]: {
      baseUrl: `http://127.0.0.1:${port}/planted-${tag}/v1`, api: 'openai-completions', apiKey: `PLANTED_${tag}`, models: [{ id: MODEL }],
    } } });
    const ext = `import { writeFileSync } from 'node:fs';\ntry { writeFileSync(${JSON.stringify(join(mark, 'exec-ext'))}, '1'); } catch {}\nexport default function () {}\n`;
    const files: Record<string, string> = {
      [join(ws, '.pi', 'models.json')]: models('ws'),
      [join(ws, '.pi', 'settings.json')]: JSON.stringify({ defaultProvider: PI_LANE_PROVIDER, defaultModel: MODEL }),
      [join(ws, '.pi', 'extensions', 'x.ts')]: ext,
      [join(ws, '..', '.pi', 'models.json')]: models('parent'),
      [join(home, '.pi', 'agent', 'models.json')]: models('home'),
      [join(home, '.pi', 'agent', 'auth.json')]: JSON.stringify({ [PI_LANE_PROVIDER]: { type: 'api_key', key: 'HUMAN_LOGIN' } }),
      [join(ws, '..', 'CLAUDE.md')]: 'PLANTED_PARENT_CLAUDE\n',
      [join(ws, '..', 'AGENTS.md')]: 'PLANTED_PARENT_AGENTS\n',
      [join(base, '..', 'CLAUDE.md')]: 'PLANTED_FAR_CLAUDE\n',
    };
    for (const [p, body] of Object.entries(files)) {
      await mkdir(join(p, '..'), { recursive: true });
      await writeFile(p, body);
    }
    return { ws, home, mark };
  }

  async function runTurn(name: string, opts: { approve?: boolean; laneLogin?: boolean; contextFiles?: boolean } = {}): Promise<{ got: Req[]; executed: string[]; loginSeen: boolean }> {
    const { ws, home, mark } = await plant(name);
    const laneRoot = join(root, `lane-${name}`);
    await ensurePiHome({ piHome: laneRoot, mcpServers: {}, lane: true });
    const piHome = await ensurePiLaneThread(laneRoot, `thread-${name}`);
    // 실물 오퍼레이터의 턴 비밀 폴더는 macOS `Application Support` 아래라 빈칸이 든다 — 같은 꼴로 잰다.
    await mkdir(join(root, 'Application Support'), { recursive: true });
    const keyPath = join(root, 'Application Support', `key-${name}`);
    await writeFile(keyPath, `${LANE_KEY}\n`, { mode: 0o600 });
    await writePiLaneModels(piHome, { baseUrl: `http://127.0.0.1:${port}/lane`, keyPath, models: [MODEL] });
    if (opts.laneLogin) await writeFile(join(piHome, 'auth.json'), JSON.stringify({ [PI_LANE_PROVIDER]: { type: 'api_key', key: 'LANE_HOME_LOGIN' } }));
    const loginSeen = await piLaneLoginPresent(piHome);
    const before = reqs.length;
    const systemPromptFile = join(root, `sys-${name}.txt`);
    await writeFile(systemPromptFile, `${RUNNER_WORD}\n`);
    // 러너가 멘션 턴에 붙이는 인자 그대로(TUI 대신 -p). 비교 칸만 그 인자를 바꾼다.
    const plan = buildTurnCommand({
      harness: 'pi', mode: 'mention', sessionId: randomUUID(), isFirstTurn: true, systemPrompt: 'SYS', systemPromptFile, promptCtx: '',
      model: `${PI_LANE_PROVIDER}/${MODEL}`, effort: null, mentionPermission: 'auto', mcpConfigPath: join(root, 'none.json'), operatorBin: '/bin/false',
      codexHome: join(root, 'codex'), claudeConfigDir: null, piHome, workspaceDir: ws,
      providerEnv: { [PI_LANE_BASE_URL_ENV]: `http://127.0.0.1:${port}/lane`, [PI_LANE_KEY_FILE_ENV]: keyPath },
    } as Parameters<typeof buildTurnCommand>[0]);
    let args = plan.args.filter((a) => !(opts.contextFiles && a === '--no-context-files'));
    if (opts.approve) args = args.map((a) => (a === '--no-approve' ? '--approve' : a));
    args = ['-p', ...args, 'say ok'];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(BIN!, args, {
        cwd: ws,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, PI_CODING_AGENT_DIR: piHome, PI_OFFLINE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`pi 시한 초과(${name})`)); }, 90_000);
      child.on('error', reject);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    return { got: reqs.slice(before).filter((r) => r.path.endsWith('/chat/completions')), executed: await readdir(mark), loginSeen };
  }

  it('요청은 lane 주소·lane 키로만 가고, 저장소 확장은 실행되지 않고, 지시는 러너 것만 실린다', async () => {
    const { got, executed, loginSeen } = await runTurn('lane');
    expect(loginSeen).toBe(false);
    expect(got.length).toBeGreaterThan(0);
    for (const r of got) {
      expect(r.path).toBe('/lane/v1/chat/completions');
      expect(r.auth).toBe(`Bearer ${LANE_KEY}`);
      expect(r.body).toContain(RUNNER_WORD);
      for (const w of ['PLANTED_PARENT_CLAUDE', 'PLANTED_PARENT_AGENTS', 'PLANTED_FAR_CLAUDE']) expect(r.body).not.toContain(w);
    }
    expect(executed).toEqual([]);
  }, 120_000);

  // 이빨: context 파일 끄기를 빼면 위 폴더의 지시가 실린다. 이 칸이 비면 위 시험의 「안 실린다」는 아무것도 재지 않는 것이다.
  it('비교 칸 — context 파일 끄기를 빼면 위 폴더 지시가 실린다', async () => {
    const { got } = await runTurn('context', { contextFiles: true });
    // 한 폴더에서는 한 파일만 싣는다(1.4.0 실측: `AGENTS.md` 가 `CLAUDE.md` 를 이긴다).
    expect(got.some((r) => r.body.includes('PLANTED_PARENT_AGENTS') && r.body.includes('PLANTED_FAR_CLAUDE'))).toBe(true);
  }, 120_000);

  // 이빨: 저장소를 믿게 하면 확장이 실행된다. 이 칸이 비면 위 시험의 「실행되지 않는다」는 아무것도 재지 않는 것이다.
  it('비교 칸 — 저장소를 믿게 하면(--approve) 저장소 확장이 실행된다', async () => {
    const { executed } = await runTurn('approve', { approve: true });
    expect(executed).toContain('exec-ext');
  }, 120_000);

  // 이빨: lane 홈에 같은 provider 의 로그인이 있으면 그 키가 이긴다 — 러너가 그 홈을 보고 멈추는 까닭.
  it('비교 칸 — lane 홈에 로그인이 있으면 키가 바뀐다(러너는 이것을 보고 멈춘다)', async () => {
    const { got, loginSeen } = await runTurn('login', { laneLogin: true });
    expect(loginSeen).toBe(true);
    expect(got.some((r) => r.auth === 'Bearer LANE_HOME_LOGIN')).toBe(true);
  }, 120_000);
});
