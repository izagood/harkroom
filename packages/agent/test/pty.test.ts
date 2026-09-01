import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer, runPtyTurn } from '../src/pty.js';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-harness.mjs');
const plan = (mode: string) => ({ command: process.execPath, args: [fake], env: { ...process.env, FAKE_MODE: mode } as Record<string, string> });

describe('runPtyTurn', () => {
  it('정상 종료: exitCode 0, 출력이 ring 에 남는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(0);
    expect(ring.snapshot().toString()).toContain('done');
  });

  it('비정상 종료: exitCode 전달', async () => {
    const r = await runPtyTurn(plan('fail'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(3);
  });

  it('타임아웃: SIGTERM → 안 죽으면 SIGKILL, timedOut 표시 (spec §4)', async () => {
    const r = await runPtyTurn(plan('hang'), { cwd: process.cwd(), timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
  }, 15_000);

  // ring 을 안 넘겨도 tail 은 항상 채워져야 한다 — policy.ts::isCredentialFailure 가 이걸로만
  // 자격증명 실패를 판단한다(PTY 안에서 stdout/stderr 가 섞여 tail 이 유일한 증거다). ring 이
  // 선택인 이유로 이 계약까지 선택이 되면, ring 을 안 넘기는 모든 호출에서 자격증명 실패가
  // 보이지 않는 재시도로 조용히 감춰진다.
  it('ring 을 안 넘겨도 tail 은 채워진다', async () => {
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.tail).toContain('done');
  });

  // 많이 쓰고 끝나는 하네스: tail 은 2KB 로 고정이라 앞부분(line 0)은 잘리고 끝부분
  // (line 9999)은 남아야 한다 — "앞이 잘린다"가 아니라 "끝이 남는다"를 확인하는 것이 핵심이다.
  // ring 은 사양대로 256KB 라 전체(총 10,000 줄, 대략 6~90KB)가 다 들어가야 한다.
  it('출력이 많은 하네스: ring 은 전체를 담고, tail 은 끝 2KB 만 남는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('chatty'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(0);
    expect(ring.snapshot().toString()).toContain('line 0');
    expect(ring.snapshot().toString()).toContain('line 9999');
    expect(r.tail).not.toContain('line 0');
    expect(r.tail).toContain('line 9999');
  });

  // 출력을 한 바이트도 안 남기고 바로 죽는 하네스 — tail/ring 이 빈 상태에서도 죽지 않고
  // exitCode 를 그대로 돌려줘야 한다. 이 케이스가 실제로 나오는 이유: 인자 파싱 실패 등으로
  // 하네스가 아무것도 못 찍고 죽는 턴은 드물지 않다.
  it('출력 없이 바로 종료하는 하네스: exitCode 는 전달되고 tail/ring 은 빈 채로 남는다', async () => {
    const ring = new RingBuffer(1024);
    const r = await runPtyTurn(plan('silent'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.tail).toBe('');
    expect(ring.snapshot().length).toBe(0);
  });

  // 정상 종료 경로에서 타임아웃 타이머가 안 지워지면, 그 타이머가 나중에 (이미 죽은
  // 프로세스에) SIGTERM/SIGKILL 을 쏘려고 살아있는 핸들로 남는다 — 바로 이 문제가 프로세스
  // 종료 후에도 이벤트 루프를 붙잡아 "동작은 하지만 정리가 안 되는" 좀비를 만든다(리뷰가
  // 우려한 지점). 타임아웃을 넉넉히 잡고도 종료가 그 안에서 빠르게 오는지로 간접 확인한다.
  it('정상 종료는 넉넉한 타임아웃과 무관하게 빠르게 resolve 된다 — 타이머가 안 걸려 있다', async () => {
    const start = Date.now();
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(r.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe('RingBuffer', () => {
  it('용량을 넘으면 앞이 잘린다', () => {
    const ring = new RingBuffer(8);
    ring.push(Buffer.from('12345'));
    ring.push(Buffer.from('67890'));
    expect(ring.snapshot().toString()).toBe('34567890');
  });

  it('빈 버퍼의 snapshot 은 빈 Buffer 다', () => {
    const ring = new RingBuffer(8);
    expect(ring.snapshot().length).toBe(0);
  });
});
