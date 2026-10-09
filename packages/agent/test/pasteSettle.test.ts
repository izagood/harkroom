/**
 * **붙여넣기를 받아 들이는 동안 친 Enter 는 버려진다**(2026-10-09, 스레드 0c1b72cb)의 회귀선.
 *
 * claude 2.1.295 는 칩으로 접히는 긴 붙여넣기를 `Pasting…` 으로 받는 동안 들어온 Enter 를 버린다.
 * 실측(실제 정지 턴의 프롬프트 4,546자·62줄): 같은 틱 `\r` 제출 0/6, 300ms 뒤 3/3. 러너는 같은
 * 틱에 쳤고, 칩만 남은 턴이 10분 정지로 접혔다. 가짜 하네스(`pasting-drop`)가 그 성질을 갖는다.
 */
import { describe, expect, it } from 'vitest';
import { runPtyTurn } from '../src/pty.js';

const fake = new URL('./helpers/fake-harness.mjs', import.meta.url).pathname;
const plan = (env: Record<string, string>) =>
  ({ command: process.execPath, args: [fake], env: { FAKE_MODE: 'pasting-drop', ...env }, stdinFile: null });

describe('붙여넣기 뒤 Enter 는 화면이 가라앉은 뒤에 친다', () => {
  it('받아 들이는 창(200ms) 안에 Enter 를 치지 않는다 — 그물 없이 한 번에 제출된다', async () => {
    const result = await runPtyTurn(plan({ FAKE_PASTING_MS: '200' }), {
      cwd: process.cwd(), timeoutMs: 15_000,
      injectPrompt: { text: '첫 줄\n둘째 줄\n셋째 줄', readyPattern: /READY/, readyTimeoutMs: 5_000, readyQuietMs: 50 },
    });
    expect(result.tail).toContain('SUBMITTED DROPPED:0');
  }, 20_000);

  it('창이 최소 대기보다 길어도 화면이 잠잠해질 때까지 기다린다', async () => {
    const result = await runPtyTurn(plan({ FAKE_PASTING_MS: '500' }), {
      cwd: process.cwd(), timeoutMs: 15_000,
      injectPrompt: { text: 'a\nb', readyPattern: /READY/, readyTimeoutMs: 5_000, readyQuietMs: 50 },
    });
    expect(result.tail).toContain('SUBMITTED DROPPED:0');
  }, 20_000);

  it('대조군 — 최소 대기를 0 으로 두면(옛 동작) Enter 가 버려지고 제출이 안 된다', async () => {
    const result = await runPtyTurn(plan({ FAKE_PASTING_MS: '200', FAKE_GIVE_UP_MS: '1500' }), {
      cwd: process.cwd(), timeoutMs: 15_000,
      injectPrompt: {
        text: 'a\nb', readyPattern: /READY/, readyTimeoutMs: 5_000, readyQuietMs: 50,
        submitMinMs: 0, submitQuietMs: 0, submitPastingMaxMs: 0,
      },
    });
    expect(result.tail).not.toContain('SUBMITTED');
    expect(result.exitCode).toBe(23);
  }, 20_000);
});
