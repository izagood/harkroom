// `harkroom-operator merge` 래퍼의 골든 — TS(정본)와 Rust 이식(`crates/harkroom-operator`)이 같은 입력에 같은 답을 내는지.
//
// 가짜 오퍼레이터 소켓을 세우고 실제 CLI(`tsx src/main.ts merge …`)를 띄워, 찍힌 한 줄·종료 코드·소켓으로 보낸 줄
// (hello·mcp.request)을 `crates/harkroom-operator/golden/merge.json` 과 비교한다. Rust 쪽 `tests/merge_golden.rs` 가
// 같은 파일을 읽어 같은 가짜 소켓 답으로 Rust 바이너리를 돌린다. TS 동작을 바꿨다면
// `UPDATE_MERGE_GOLDEN=1 npx vitest run test/mergeCliGolden.test.ts` 로 다시 쓴다.
//
// `tsDiffers` 가 있는 경우는 TS 가 그 계약을 아직 지키지 않는 것(알려진 차이)이다 — TS 시험은 건너뛰고 Rust 만 본다.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-operator', 'golden', 'merge.json');
const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const SHA = '53e53ae5d9f3b6fb2712d6281f0ec31e66f572f1';
const GOOD = ['izagood/Harkroom', '1842', '--head', SHA];

type EnvMode = 'turnKey' | 'secret' | 'none';
/** 가짜 오퍼레이터가 mcp.request 에 돌려줄 것. 객체면 `id` 를 요청 id 로 채워 보낸다. */
type Reply = Record<string, unknown> | 'close' | 'rejected' | null;
interface Expect { stdout: string; exit: number; frames: Record<string, unknown>[] }
interface Case { name: string; argv: string[]; env: EnvMode; reply: Reply; tsDiffers?: string; expect?: Expect }

const tool = (text: string, isError = false): Reply => ({
  type: 'mcp.response', messages: [{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }],
});

const CASES: Case[] = [
  { name: 'merged', argv: GOOD, env: 'turnKey', reply: tool('{"merged":true,"sha":"x"}') },
  { name: 'queued', argv: GOOD, env: 'turnKey', reply: tool('{"queued":true,"merged":false,"queue":{"position":2}}') },
  { name: 'denied', argv: GOOD, env: 'turnKey', reply: tool('{"error":{"code":"not_granted","denialId":"d1"}}', true) },
  { name: 'server_error', argv: GOOD, env: 'turnKey', reply: { type: 'mcp.error', status: 403, message: 'nope' } },
  { name: 'raw_text', argv: GOOD, env: 'turnKey', reply: tool('plain text') },
  { name: 'array_result', argv: GOOD, env: 'turnKey', reply: tool('[1,"a"]') },
  { name: 'closed_silently', argv: GOOD, env: 'turnKey', reply: 'close' },
  {
    name: 'link_rejected', argv: GOOD, env: 'turnKey', reply: 'rejected',
    tsDiffers: 'TS 는 link.rejected 를 받으면 아무것도 찍지 않고 exit 0 으로 끝난다(에이전트가 성공으로 읽을 수 있다). Rust 는 link_error·exit 1.',
    expect: {
      stdout: JSON.stringify({ error: { code: 'link_error', message: '오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라' }, merged: false, exit: 1 }),
      exit: 1,
      frames: [{ type: 'hello', version: 1, role: 'runner', runnerId: 'r1', turnKey: 'tk', kind: 'wrapper' }],
    },
  },
  { name: 'secret_credentials', argv: GOOD, env: 'secret', reply: tool('{"merged":true,"sha":"x"}') },
  { name: 'not_in_turn', argv: GOOD, env: 'none', reply: null },
  { name: 'usage', argv: ['a/b'], env: 'turnKey', reply: null },
  { name: 'unknown_flag', argv: ['a/b', '1', '--admin'], env: 'turnKey', reply: null },
  { name: 'bad_head', argv: ['a/b', '1', '--head', 'zz'], env: 'turnKey', reply: null },
];

/** 보낸 줄에서 실행마다 바뀌는 값(요청 id·cwd)을 자리표로 바꾼다. */
function normalize(frame: Record<string, unknown>): Record<string, unknown> {
  const f = { ...frame };
  if (f.type === 'mcp.request') f.id = '<id>';
  if ('cwd' in f) f.cwd = '<cwd>';
  return f;
}

async function runTs(c: Case): Promise<Expect> {
  const dir = mkdtempSync(join(tmpdir(), 'hk-merge-'));
  const sock = join(dir, 's');
  const frames: Record<string, unknown>[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        frames.push(line);
        if (c.reply === 'rejected' && line.type === 'hello') conn.end(`${JSON.stringify({ type: 'link.rejected', reason: 'x' })}\n`);
        if (line.type !== 'mcp.request') continue;
        if (c.reply === 'close') conn.destroy();
        else if (c.reply && typeof c.reply === 'object') conn.write(`${JSON.stringify({ ...c.reply, id: line.id })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (c.env !== 'none') {
    Object.assign(env, { HARKROOM_OPERATOR_SOCKET: sock, HARKROOM_RUNNER_ID: 'r1' });
    Object.assign(env, c.env === 'turnKey' ? { HARKROOM_TURN_GRANT: 'tk' } : { HARKROOM_RUNNER_SECRET: 'sec', HARKROOM_TURN_CAUSE: 'cz' });
  }
  const { stdout, exit } = await new Promise<{ stdout: string; exit: number }>((resolve) => {
    const p = spawn(TSX, [MAIN, 'merge', ...c.argv], { env, cwd: dir });
    let out = '';
    p.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    p.on('close', (code) => resolve({ stdout: out.trim(), exit: code ?? -1 }));
  });
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  return { stdout, exit, frames: frames.slice(0, 2).map(normalize) };
}

describe('merge CLI 골든 (TS 정본 ↔ crates/harkroom-operator)', () => {
  const update = process.env.UPDATE_MERGE_GOLDEN === '1';

  it('골든 파일의 경우 목록이 이 표와 같다', async () => {
    if (update) {
      const cases = [];
      for (const c of CASES) {
        const expectOut = c.tsDiffers ? c.expect! : await runTs(c);
        cases.push({ name: c.name, argv: c.argv, env: c.env, reply: c.reply, ...(c.tsDiffers ? { tsDiffers: c.tsDiffers } : {}), expect: expectOut });
      }
      writeFileSync(GOLDEN, `${JSON.stringify({ note: 'packages/operator/test/mergeCliGolden.test.ts 가 쓴다 — 손으로 고치지 마라', cases }, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: (Case & { expect: Expect })[] };
    expect(golden.cases.map((c) => [c.name, c.argv, c.env, c.reply])).toEqual(CASES.map((c) => [c.name, c.argv, c.env, c.reply]));
  }, 120_000);

  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: (Case & { expect: Expect })[] };
  for (const g of golden.cases) {
    it.skipIf(Boolean(g.tsDiffers) || update)(`${g.name}`, async () => {
      expect(await runTs(g)).toEqual(g.expect);
    }, 30_000);
  }
});
