// `harkroom-operator merge` 래퍼가 링크를 못 얻었을 때 **답 없이 exit 0 으로 빠지지 않는다**(2026-11-10).
//
// 실제 CLI(`tsx src/main.ts merge …`)를 가짜 오퍼레이터 소켓에 붙여 돌린다 — 이 결함은 이벤트 루프가 비어 프로세스가
// 먼저 끝나는 것이라 함수 단위 시험으로는 보이지 않는다. 고치기 전: 출력 없음·exit 0. 고친 뒤: `link_error` 한 줄·exit 1.
// 정상 답 경우(머지됨·거절)의 출력은 그대로인지 함께 본다.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TSX = join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
const ARGV = ['merge', 'example/repo', '12', '--head', 'a'.repeat(40)];
const API_ARGV = ['api', 'example-api', 'GET', '/v1/items'];

type Mode = 'rejected' | 'merged' | 'denied';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function run(mode: Mode, argv: string[] = ARGV): Promise<{ stdout: string; code: number | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'hr-wrap-'));
  dirs.push(dir);
  const sock = join(dir, 'op.sock');
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = JSON.parse(buf.slice(0, nl)) as { type: string; id?: string };
        buf = buf.slice(nl + 1);
        if (mode === 'rejected' && line.type === 'hello') { conn.end(`${JSON.stringify({ type: 'link.rejected', reason: 'unknown_runner' })}\n`); return; }
        if (line.type !== 'mcp.request') continue;
        const text = mode === 'merged' ? '{"merged":true,"repo":"example/repo"}' : '{"error":{"code":"not_granted","message":"no","denialId":"d1"}}';
        const result = { content: [{ type: 'text', text }], ...(mode === 'denied' ? { isError: true } : {}) };
        conn.write(`${JSON.stringify({ type: 'mcp.response', id: line.id, messages: [{ jsonrpc: '2.0', id: 1, result }] })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  try {
    return await new Promise((resolve) => {
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        HARKROOM_OPERATOR_SOCKET: sock, HARKROOM_RUNNER_ID: 'r1', HARKROOM_TURN_GRANT: 'f'.repeat(64),
      };
      const child = spawn(TSX, [MAIN, ...argv], { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
      child.on('close', (code) => resolve({ stdout: stdout.trim(), code }));
    });
  } finally {
    server.close();
  }
}

describe('merge 래퍼 — 링크가 없을 때', () => {
  it('오퍼레이터가 링크를 거절하면 link_error 한 줄과 exit 1 로 끝난다(답 없이 exit 0 이 아니다)', async () => {
    const r = await run('rejected');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(JSON.stringify({
      error: { code: 'link_error', message: '오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라' }, merged: false, exit: 1,
    }));
  }, 40_000);

  it('답이 오면 출력은 전과 같다 — 머지됨 · 거절', async () => {
    expect(await run('merged')).toEqual({ stdout: '{"merged":true,"repo":"example/repo","exit":0}', code: 0 });
    expect(await run('denied')).toEqual({
      stdout: '{"error":{"code":"not_granted","message":"no","denialId":"d1"},"merged":false,"exit":1}', code: 1,
    });
  }, 40_000);
});

describe('api 래퍼 — 링크가 없을 때(merge 와 같은 빈틈, 2026-11-10)', () => {
  it('오퍼레이터가 링크를 거절하면 link_error 한 줄과 exit 1 로 끝난다', async () => {
    const r = await run('rejected', API_ARGV);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(JSON.stringify({
      error: { code: 'link_error', message: '오퍼레이터 링크가 없다 — 재접속 중이다. 잠시 뒤 다시 불러라' }, exit: 1,
    }));
  }, 40_000);

  it('답이 오면 출력은 전과 같다 — 성공 · 거절', async () => {
    // api 출력은 `{ ...out, exit }` 이다(merge 처럼 `merged` 를 덧붙이지 않는다).
    expect(await run('merged', API_ARGV)).toEqual({ stdout: '{"merged":true,"repo":"example/repo","exit":0}', code: 0 });
    expect(await run('denied', API_ARGV)).toEqual({
      stdout: '{"error":{"code":"not_granted","message":"no","denialId":"d1"},"exit":1}', code: 1,
    });
  }, 40_000);
});
