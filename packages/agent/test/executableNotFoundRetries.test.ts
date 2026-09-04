/**
 * #340 — 하네스 실행 파일이 없을 때 **재시도 횟수가 0** 인지 센다.
 *
 * 왜 "종료했다"만으로는 부족한가: 3회(`MAX_ATTEMPTS`) 재시도한 **뒤에** 종료해도 "러너가
 * 죽었다"는 단언은 초록이다. 이 이슈가 고치려는 것은 정확히 그 3회다 — PATH 하나 틀린
 * 러너가 사람의 멘션 세 건을 태우고 `FAILURE_NOTICE` 를 남긴 뒤에야 흔적을 남기는 것.
 * 그래서 여기서는 **시도 횟수를 센다**.
 *
 * 무엇을 복제하고 무엇을 복제하지 않는가(이 파일을 읽는 사람이 속지 않도록):
 * - **판정은 복제하지 않는다.** 아래 루프는 `runnerExitPlan`(프로덕션)을 그대로 부른다.
 *   실패를 만드는 쪽도 진짜 `runPtyTurn` 이다 — 없는 하네스로 실제로 부른다.
 * - **복제한 것은 루프의 모양뿐이다.** `main.ts` 는 top-level await 로 서버에 붙어 버려
 *   테스트가 import 할 수 없다(그 파일 머리 주석). 그 루프가 실제 `main.ts` 의 모양과 같은지는
 *   `mainCredentialSites.test.ts` 가 소스를 읽어 따로 지킨다 — 판정 호출이 세 자리에 있는지,
 *   그리고 멘션 catch 에서 그 호출이 **재시도 회계보다 앞인지**. 두 파일이 함께 있어야 이
 *   보증이 성립하고, 어느 한쪽만으로는 성립하지 않는다.
 */
import { describe, it, expect } from 'vitest';
import { runnerExitPlan, EXECUTABLE_NOT_FOUND_LINE, CREDENTIAL_REJECTED_LINE } from '../src/exit.js';
import { MAX_ATTEMPTS, exhausted, MURMUR_ERROR_SOURCE } from '../src/policy.js';
import { runPtyTurn } from '../src/pty.js';

interface LoopResult {
  /** 이 항목을 실제로 몇 번 시도했나. */
  attempts: number;
  /** 러너가 물러났나(= `process.exit(plan.code)` 자리에 도달했나). */
  exited: boolean;
  /** 물러났다면 stderr 에 찍었을 줄들. */
  lines: string[];
  /** 한도까지 실패해 `FAILURE_NOTICE` 를 남겼나. */
  noticed: boolean;
}

/**
 * `main.ts` 의 항목 재시도 회계를 그대로 본뜬 루프. 시도 횟수를 올리는 자리, 판정을 보는
 * 자리, 실패를 계상하는 자리의 **순서**가 main.ts 와 같다.
 */
async function runUntilStop(attempt: () => Promise<unknown>): Promise<LoopResult> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const tried = attempts;
    try {
      await attempt();
      return { attempts, exited: false, lines: [], noticed: false };
    } catch (err) {
      const plan = runnerExitPlan(err);
      if (plan) return { attempts, exited: true, lines: plan.lines, noticed: false };
      if (exhausted(tried)) return { attempts, exited: false, lines: [], noticed: true };
    }
  }
}

const missingHarness = {
  command: '/nonexistent/bin/harness-xyz',
  args: [] as string[],
  env: {} as Record<string, string>,
  stdinFile: null,
};

describe('#340 실행 파일 부재는 한 번 만에 러너를 세운다', () => {
  // 이 이슈의 본체. 고치기 전에는 3이 나왔다(멘션 3건 소모 + FAILURE_NOTICE).
  it('시도는 딱 1회다 — 재시도 0회', async () => {
    const r = await runUntilStop(() =>
      runPtyTurn(missingHarness, { cwd: process.cwd(), timeoutMs: 5_000 }));
    expect(r.attempts).toBe(1);
    expect(r.exited).toBe(true);
    expect(r.noticed).toBe(false);
    expect(r.lines.at(-1)).toBe(EXECUTABLE_NOT_FOUND_LINE);
  });

  // 이번 변경이 재시도 **전반**을 죽이지 않았는지. 모든 실패를 실행 파일 부재로 취급하도록
  // 되돌리면 이 단언이 빨개진다 — 위 단언만으로는 그 사고가 전부 초록이다.
  it('일반 실패는 여전히 MAX_ATTEMPTS 까지 재시도하고 통지로 끝난다', async () => {
    const r = await runUntilStop(() => Promise.reject(new Error('일시적인 네트워크 오류')));
    expect(r.attempts).toBe(MAX_ATTEMPTS);
    expect(r.exited).toBe(false);
    expect(r.noticed).toBe(true);
  });

  // 자격증명 실패(#250)의 기존 동작이 그대로다 — 같은 자리에서 나란히 판정되므로, 새 판정이
  // 앞에 붙으면서 이쪽 안내문을 가로챌 수 있었다.
  it('자격증명 실패도 그대로 1회 만에 물러난다 — 안내문은 자격증명 쪽이다', async () => {
    const cred = Object.assign(new Error('murmur 401'), { status: 401, source: MURMUR_ERROR_SOURCE });
    const r = await runUntilStop(() => Promise.reject(cred));
    expect(r.attempts).toBe(1);
    expect(r.exited).toBe(true);
    expect(r.lines.at(-1)).toBe(CREDENTIAL_REJECTED_LINE);
  });

  // 정상 하네스는 재시도도 종료도 없이 한 번에 끝난다 — 루프 자체가 고장 났는지를 가른다.
  it('정상 하네스는 1회에 성공하고 러너는 살아 있다', async () => {
    const r = await runUntilStop(() =>
      runPtyTurn(
        { command: process.execPath, args: ['-e', ''], env: {}, stdinFile: null },
        { cwd: process.cwd(), timeoutMs: 5_000 },
      ));
    expect(r.attempts).toBe(1);
    expect(r.exited).toBe(false);
    expect(r.noticed).toBe(false);
  });
});
