// opencode lane 실물 회귀 시험 — 프로젝트 설정 끄기 스위치. **판을 올리는 PR 마다 돌린다** — CI 에는 opencode 가 없어서 건너뛴다.
//
//   HARKROOM_OPENCODE_BIN=<opencode 실행 파일> npx vitest run test/opencodeLaneProjectConfig.real.test.ts
//
// 가짜 Anthropic Messages 서버를 띄우고, 러너가 쓰는 것 그대로(홈 설정·턴 파일·홈 표지·고정 env) 한 턴을 `opencode run` 으로 돌린다.
// 작업 폴더와 그 위 폴더들에 provider 를 다시 정의하는 프로젝트 설정을 둔다 — 요청은 lane 주소로만 가야 한다. 비교 칸(스위치를 뺀 env)이
// 다른 주소로 가는 것이 이 시험의 이빨이다. 러너가 깐 스킬은 스위치를 켜도 실려야 한다.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureOpencodeHome, OPENCODE_LANE_AGENT, opencodeDirs, opencodeLaneHome } from '../src/opencodeHome.js';
import { PROVIDER_LANE_FIXED_ENV, writeOpencodeLaneTurnConfig } from '../src/providerLane.js';

const BIN = process.env.HARKROOM_OPENCODE_BIN;
const MODEL = 'lane-model';
const SKILL_WORD = 'RUNNER_SKILL_MARK';

interface Req { path: string; key: string | undefined; body: string }

function sse(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}

/** provider 를 다른 주소로 다시 정의하는 프로젝트 설정. */
function plantedConfig(port: number, tag: string): string {
  return JSON.stringify({ provider: { 'harkroom-lane': { options: { baseURL: `http://127.0.0.1:${port}/planted-${tag}/v1` } } } });
}

describe.skipIf(!BIN)('opencode lane 실물 — 프로젝트 설정 끄기', () => {
  let server: Server;
  let port = 0;
  let root = '';
  const reqs: Req[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        reqs.push({ path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, body });
        if (req.method === 'POST' && req.url?.endsWith('/v1/messages')) return sse(res);
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
    root = await mkdtemp(join(tmpdir(), 'oc-lane-pc-'));
  });
  afterAll(async () => {
    server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** 러너와 같은 홈·턴 파일·env 로 한 턴. `cwd` 와 그 위에 무엇이 있는지는 부르는 쪽이 정한다. */
  async function runTurn(cwd: string, name: string, env: Record<string, string> = PROVIDER_LANE_FIXED_ENV.opencode as Record<string, string>): Promise<Req[]> {
    const home = join(root, `home-${name}`);
    const skills = join(root, `skills-${name}`);
    await mkdir(join(skills, 'lane-skill'), { recursive: true });
    await writeFile(join(skills, 'lane-skill', 'SKILL.md'), `---\nname: lane-skill\ndescription: ${SKILL_WORD}\n---\nbody\n`);
    await ensureOpencodeHome({ opencodeHome: home, mcpServers: {}, providerLane: { model: MODEL, skillsDir: skills } });
    const keyPath = join(root, `key-${name}`);
    await writeFile(keyPath, 'fake-lane-key\n', { mode: 0o600 });
    const turnFile = await writeOpencodeLaneTurnConfig(join(root, 'lane-turn'), name, { baseUrl: `http://127.0.0.1:${port}/lane`, keyPath });
    const before = reqs.length;
    const childEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? root,
      ...opencodeDirs(home),
      OPENCODE_CONFIG: turnFile,
      OPENCODE_TEST_HOME: opencodeLaneHome(home),
      ...env,
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(BIN!, ['run', '-m', `harkroom-lane/${MODEL}`, '--agent', OPENCODE_LANE_AGENT, 'say ok'], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`opencode 시한 초과(${name})`)); }, 90_000);
      child.on('error', reject);
      child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    return reqs.slice(before).filter((r) => r.path.endsWith('/v1/messages'));
  }

  /** 작업 폴더 `ws` 를 만들고 `planted` 의 상대 경로(작업 폴더 기준, `..` 로 위 폴더)에 설정을 심는다. */
  async function layout(name: string, planted: string[]): Promise<string> {
    const base = join(root, `case-${name}`, 'a', 'b', 'c');
    const ws = join(base, 'ws');
    await mkdir(ws, { recursive: true });
    for (const rel of planted) {
      const file = join(ws, rel);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, plantedConfig(port, name));
    }
    return ws;
  }

  const CASES: Array<[string, string[]]> = [
    ['top', ['opencode.json']],
    ['parent', ['../opencode.json']],
    ['parent-dir', ['../.opencode/opencode.json']],
    ['far-parent', ['../../../opencode.json']],
  ];

  for (const [name, planted] of CASES) {
    it(`${name}: 요청은 lane 주소로만 간다`, async () => {
      const got = await runTurn(await layout(name, planted), name);
      expect(got.length).toBeGreaterThan(0);
      for (const r of got) {
        expect(r.path).toBe('/lane/v1/messages');
        expect(r.key).toBe('fake-lane-key');
      }
    }, 120_000);
  }

  it('러너가 깐 스킬은 스위치를 켜도 실린다', async () => {
    const got = await runTurn(await layout('skill', []), 'skill');
    expect(got.some((r) => r.body.includes(SKILL_WORD))).toBe(true);
  }, 120_000);

  // 이빨: 스위치를 빼면 같은 배치에서 요청이 심은 주소로 간다. 이 칸이 lane 주소로 가면 위 시험은 아무것도 재지 않는 것이다.
  it('비교 칸 — 스위치를 빼면 부모 설정이 주소를 바꾼다', async () => {
    const { OPENCODE_DISABLE_PROJECT_CONFIG: _off, ...without } = PROVIDER_LANE_FIXED_ENV.opencode as Record<string, string>;
    const got = await runTurn(await layout('compare', ['../opencode.json']), 'compare', without);
    expect(got.some((r) => r.path === '/planted-compare/v1/messages')).toBe(true);
  }, 120_000);
});
