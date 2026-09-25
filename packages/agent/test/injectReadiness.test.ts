// **입력창이 보인다 ≠ 입력을 받는다** — 주입 시점과 삼켜진 Enter(2026-09-14).
//
// ## 무슨 일이 있었나
//
// codex 를 TUI 로 올린 뒤 실물 턴이 두 번 매달렸다. 화면을 떠 보니 프롬프트 본문이 입력창에
// **그대로 있고** 그 아래 `tab to queue message` 만 떠 있었다 — 붙여넣기는 갔고 Enter 만
// 삼켜진 것이다. codex 는 부팅 ~0.2초에 자리표시자(`Ask … to do anything`)를 그리는데
// 그때는 아직 제출을 받지 않는다.
//
// 재현(같은 인자·같은 워크스페이스에서 **주입 시각만** 바꿨다):
//   0.3초 → 제출 안 됨 · 2초 → 제출·실행·답변 · 9초 → 제출
//
// ## 이 파일이 지키는 것 둘
//
// 1. 표가 말한 하한 전에는 **한 바이트도 안 쓴다**(예방).
// 2. 그래도 삼켜지면 **화면을 보고 개행을 다시 친다**(그물). 본문은 다시 안 보낸다.
//
// 그물을 따로 두는 이유: 기존 확인(`confirmDelivery`)은 세션 기록이 자랐는지로 재는데,
// 기록을 못 읽는 하네스에서는 그 판정이 늘 참이라 **한 번도 돌지 않는다**. codex 가 그
// 자리였고, 그래서 되살릴 수단이 아무것도 없었다.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runPtyTurn } from '../src/pty.js';
import { injectionFactsFor } from '../src/adapters/index.js';

const fake = new URL('./helpers/fake-harness.mjs', import.meta.url).pathname;
const plan = (mode: string, env: Record<string, string> = {}) =>
  ({ command: process.execPath, args: [fake], env: { FAKE_MODE: mode, ...env }, stdinFile: null });

describe('표가 말하는 주입 하한', () => {
  it('codex 는 하한과 미제출 신호를 둘 다 갖는다 — 실측에서 나온 값이다', () => {
    const facts = injectionFactsFor('codex');
    expect(facts.readyMinMs).toBe(2_500);
    expect(facts.unsentHint?.test('  tab to queue message')).toBe(true);
  });

  it('claude 는 하한도 미제출 신호도 없다 — 그물을 치지 않는다는 뜻이다', () => {
    // 준비 표시가 실제 준비와 같고, 제출 확인은 세션 기록으로 이미 된다.
    const facts = injectionFactsFor('claude-code');
    expect(facts.readyMinMs).toBeUndefined();
    expect(facts.unsentHint).toBeUndefined();
  });

  // 표에 준비 표시가 있어도 **넘기지 않으면** 주입은 `pty.ts` 의 기본 패턴으로 기다린다.
  // opencode 의 `Ask anything…` 은 그 기본에 안 걸려, 첫 실물 턴이 60초를 채우고
  // `PromptNotDeliveredError` 로 죽었다(2026-09-22). 이 셋이 그 갈림을 못박는다.
  it('되살린 세션 화면에도 걸린다 — 자리표시자는 첫 화면에만 있다', () => {
    // 실측 2026-09-25: `-s <id>` 로 뜨면 앞 대화가 replay 되고 `Ask anything…` 은 안 보인다.
    // 그 문구만 보면 **두 번째 턴부터** 준비를 못 보고 60초를 세다 죽는다(첫 턴만 되는 하네스).
    const 되살린화면 = readFileSync(new URL('./fixtures/opencode-tui-resumed.txt', import.meta.url), 'utf8');

    expect(되살린화면).not.toContain('Ask anything');
    expect(injectionFactsFor('opencode').readyPattern.test(되살린화면)).toBe(true);
  });

  it('준비 표시는 하네스마다 다르고, 주입은 **그 표의 것**으로 기다린다', () => {
    const 화면 = readFileSync(new URL('./fixtures/opencode-tui-ready.txt', import.meta.url), 'utf8');

    expect(injectionFactsFor('opencode').readyPattern.test(화면)).toBe(true);
    // 기본 패턴에는 안 걸린다 — 이것이 표를 넘겨야 하는 이유 그 자체다.
    expect(/[❯›]\u00a0|Ask\s+\S+\s+to\s+do\s+anything/.test(화면)).toBe(false);
    expect(injectionFactsFor('claude-code').readyPattern.test(화면)).toBe(false);
    expect(injectionFactsFor('codex').readyPattern.test(화면)).toBe(false);
  });
});

describe('하한 전에는 쓰지 않는다', () => {
  it('준비 표시를 즉시 봐도 하한까지 기다린다', async () => {
    const chunks: Buffer[] = [];
    const marks: number[] = [];
    const startedAt = Date.now();
    // 가짜는 준비 표시를 **즉시** 찍는다. 하한이 없으면 러너는 곧바로 넣는다.
    const result = await runPtyTurn(plan('ready-early-submit-late', { FAKE_SUBMIT_AT_MS: '600' }), {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      onData: (c) => {
        chunks.push(c);
        // 우리가 쓴 것은 PTY 가 에코한다 — 그 첫 순간이 곧 주입 시각이다.
        if (Buffer.concat(chunks).toString('utf8').includes('[200~')) marks.push(Date.now() - startedAt);
      },
      injectPrompt: {
        text: 'HELLO_MIN_MS',
        readyPattern: /READY/,
        readyTimeoutMs: 10_000,
        readyQuietMs: 50,
        readyMinMs: 1_000,
      },
    });

    // 제출됐다(가짜는 600ms 뒤부터 받는다). 그리고 그 주입은 1초 전에는 없었다.
    expect(result.tail).toContain('SUBMITTED:');
    expect(marks[0]).toBeGreaterThanOrEqual(1_000);
  }, 25_000);
});

describe('삼켜진 Enter 를 화면으로 보고 다시 친다', () => {
  it('하한이 없어 일찍 넣어도 그물이 턴을 살린다 — 본문은 다시 안 보낸다', async () => {
    // 하한을 **0** 으로 둔다: 일부러 삼켜지는 자리에 넣어, 그물만으로 살아나는지 잰다.
    const chunks: Buffer[] = [];
    const result = await runPtyTurn(plan('ready-early-submit-late', { FAKE_SUBMIT_AT_MS: '2500' }), {
      cwd: process.cwd(),
      timeoutMs: 25_000,
      onData: (c) => chunks.push(c),
      injectPrompt: {
        text: 'HELLO_NUDGE',
        readyPattern: /READY/,
        readyTimeoutMs: 10_000,
        readyQuietMs: 50,
        unsentHint: /tab to queue message/,
        unsentProbeMs: 800,
        unsentRetries: 5,
      },
    });

    expect(result.tail).toContain('SUBMITTED:');
    // 본문은 한 번만 갔다 — 두 번 보내면 하네스가 같은 일을 두 번 한다.
    const seen = Buffer.concat(chunks).toString('utf8');
    expect(seen.split('HELLO_NUDGE').length - 1).toBe(1);
  }, 30_000);

  it('그물이 없으면 그 턴은 매달린 채 끝난다 — 이 테스트가 그물의 값을 잰다', async () => {
    // 대조군. 같은 가짜, 같은 이른 주입, `unsentHint` 만 뺐다. 가짜의 안전망(12초·코드 23)이
    // 그 사실을 말한다: 아무도 다시 치지 않아 제출이 영영 안 일어났다.
    const result = await runPtyTurn(plan('ready-early-submit-late', { FAKE_SUBMIT_AT_MS: '2500' }), {
      cwd: process.cwd(),
      timeoutMs: 25_000,
      injectPrompt: {
        text: 'HELLO_NO_NET',
        readyPattern: /READY/,
        readyTimeoutMs: 10_000,
        readyQuietMs: 50,
      },
    });
    expect(result.exitCode).toBe(23);
    expect(result.tail).not.toContain('SUBMITTED:');
  }, 30_000);
});
