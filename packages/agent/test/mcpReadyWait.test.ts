// **MCP 준비 신호를 기다린 뒤 넣는다**(2026-10-10, 스레드 20914e42) — `injectPrompt.waitFor`.
//
// claude 는 harkroom 브릿지가 도구 목록을 넘기기 전에도 입력을 받아 첫 호출을 낸다. 이어 받은 턴에서는
// 그 때문에 캐시가 깨진다. 러너는 브릿지의 표식을 기다렸다가 넣되, **시한을 넘기면 그냥 넣는다** —
// 신호가 안 와도 턴이 막히면 안 된다. 이 파일은 그 두 갈래와 "판정이 던진다"를 잰다.
import { describe, expect, it } from 'vitest';

import { runPtyTurn } from '../src/pty.js';

const fake = new URL('./helpers/fake-harness.mjs', import.meta.url).pathname;
const plan = () => ({
  command: process.execPath, args: [fake],
  env: { FAKE_MODE: 'ready-early-submit-late', FAKE_SUBMIT_AT_MS: '0' }, stdinFile: null,
});

/** 주입 시각(스폰 기준 ms)과 `onSettled` 결과를 함께 잰다. */
async function run(waitFor: { ready: () => boolean; maxMs: number }) {
  const chunks: Buffer[] = [];
  const marks: number[] = [];
  const settled: { ready: boolean; waitedMs: number }[] = [];
  const startedAt = Date.now();
  const result = await runPtyTurn(plan(), {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    onData: (c) => {
      chunks.push(c);
      if (marks.length === 0 && Buffer.concat(chunks).toString('utf8').includes('[200~')) marks.push(Date.now() - startedAt);
    },
    injectPrompt: {
      text: 'HELLO_MCP_WAIT',
      readyPattern: /READY/,
      readyTimeoutMs: 10_000,
      readyQuietMs: 50,
      waitFor: { ...waitFor, pollMs: 50, onSettled: (r) => settled.push(r) },
    },
  });
  return { result, injectedAt: marks[0], settled };
}

describe('MCP 준비 신호를 기다린다', () => {
  it('신호가 시한 안에 오면 그때 넣는다', async () => {
    const startedAt = Date.now();
    const { result, injectedAt, settled } = await run({ ready: () => Date.now() - startedAt >= 700, maxMs: 5_000 });
    expect(result.tail).toContain('SUBMITTED:');
    expect(injectedAt).toBeGreaterThanOrEqual(700);
    expect(injectedAt).toBeLessThan(5_000);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.ready).toBe(true);
  }, 25_000);

  it('신호가 안 오면(브릿지가 안 떴다) 시한에서 그냥 넣는다 — 턴은 막히지 않는다', async () => {
    const { result, injectedAt, settled } = await run({ ready: () => false, maxMs: 900 });
    expect(result.tail).toContain('SUBMITTED:');
    expect(injectedAt).toBeGreaterThanOrEqual(900);
    expect(settled).toEqual([{ ready: false, waitedMs: expect.any(Number) }]);
    expect(settled[0]!.waitedMs).toBeGreaterThanOrEqual(900);
  }, 25_000);

  it('판정이 던지면 안 선 것으로 보고 시한까지 간다', async () => {
    const { result, injectedAt, settled } = await run({ ready: () => { throw new Error('boom'); }, maxMs: 600 });
    expect(result.tail).toContain('SUBMITTED:');
    expect(injectedAt).toBeGreaterThanOrEqual(600);
    expect(settled[0]?.ready).toBe(false);
  }, 25_000);
});
