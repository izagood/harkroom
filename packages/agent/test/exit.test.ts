/**
 * 러너 종료 코드 회귀선(#250).
 *
 * 이 계약이 왜 중요한가: 앱이 PAT 를 회전할 때 옛 PAT 로 돌던 러너를 물러나게 하는 수단은
 * 서버의 401 과 **이 종료 코드뿐**이다(러너↔앱 통신 채널을 만들지 않기로 했다). 78 이
 * 아니면 앱은 "그냥 죽었다"와 구분할 수 없고, 사람에게 "재발급하면 다시 뜬다"를 말할 수 없다.
 */
import { describe, it, expect } from 'vitest';
import { CREDENTIAL_REJECTED_LINE, EX_CONFIG, EXECUTABLE_NOT_FOUND_LINE, runnerExitPlan } from '../src/exit.js';
import { MURMUR_ERROR_SOURCE } from '../src/policy.js';
import { ExecutableNotFoundError } from '../src/pty.js';

const murmurErr = (status: number) =>
  Object.assign(new Error(`murmur ${status}`), { status, source: MURMUR_ERROR_SOURCE });

describe('자격증명 실패는 78 로 물러난다', () => {
  it('murmur 401 → 78', () => {
    const plan = runnerExitPlan(murmurErr(401));
    expect(plan?.code).toBe(78);
    expect(EX_CONFIG).toBe(78);
  });

  it('murmur 403 → 78', () => {
    expect(runnerExitPlan(murmurErr(403))?.code).toBe(78);
  });

  it('하네스 로그인 실패도 78 — 재시도로 낫지 않는 것이 같다', () => {
    expect(runnerExitPlan(new Error('could not resolve authentication'))?.code).toBe(78);
  });

  it('마지막 줄이 앱과 사람이 찾는 그 한 줄이다', () => {
    expect(runnerExitPlan(murmurErr(401))!.lines.at(-1)).toBe(CREDENTIAL_REJECTED_LINE);
  });

  it('murmur PAT 문제와 하네스 로그인 문제를 다르게 안내한다 — 볼 곳이 다르다', () => {
    expect(runnerExitPlan(murmurErr(401))!.lines.join('\n')).toContain('MURMUR_PAT');
    expect(runnerExitPlan(new Error('x-api-key'))!.lines.join('\n')).toContain('claude CLI');
  });

  it('앱이 띄운 러너에게는 재발급 버튼을 가리킨다 — 환경변수를 손으로 바꾸라는 안내만으로는 길이 없다', () => {
    expect(runnerExitPlan(murmurErr(401))!.lines.join('\n')).toContain('PAT 재발급');
  });
});

describe('자격증명 실패가 아니면 물러나지 않는다', () => {
  it('네트워크 오류는 null — 재접속하면 되는 것으로 러너를 죽이지 않는다', () => {
    expect(runnerExitPlan(new Error('ECONNREFUSED'))).toBeNull();
  });

  it('murmur 500 은 null', () => {
    expect(runnerExitPlan(murmurErr(500))).toBeNull();
  });

  it('본문에 401 이라는 숫자가 우연히 든 오류는 null', () => {
    // 판정은 status 로만 한다(policy.ts). 문구로 판정하면 이것이 오탐이 된다.
    expect(runnerExitPlan(new Error('response body was 401 bytes'))).toBeNull();
  });
});

describe('#340 실행 파일 부재는 78 로 물러난다', () => {
  // 실행 파일 부재는 재시도로 낫지 않는다 — launchd KeepAlive 가 재기동해도 같은 이유로
  // 즉시 죽는다. 운영자가 로그에서 원인을 바로 볼 수 있게 한다.
  it('ExecutableNotFoundError → 78', () => {
    const err = new ExecutableNotFoundError('/nonexistent/harness', '/usr/bin:/bin');
    const plan = runnerExitPlan(err);
    expect(plan?.code).toBe(78);
    expect(EX_CONFIG).toBe(78);
  });

  it('마지막 줄이 앱과 사람이 찾는 그 한 줄이다', () => {
    const err = new ExecutableNotFoundError('/nonexistent/harness', '/usr/bin:/bin');
    expect(runnerExitPlan(err)!.lines.at(-1)).toBe(EXECUTABLE_NOT_FOUND_LINE);
  });

  // 로그에 실행 파일 경로와 PATH 가 남는다 — 운영자가 원인을 바로 본다.
  it('로그에 실행 파일 경로와 PATH 가 포함된다', () => {
    const err = new ExecutableNotFoundError('/opt/harness/bin/claude', '/usr/local/bin:/usr/bin:/bin');
    const plan = runnerExitPlan(err)!;
    expect(plan.lines.join('\n')).toContain('/opt/harness/bin/claude');
    expect(plan.lines.join('\n')).toContain('/usr/local/bin:/usr/bin:/bin');
  });

  // launchd KeepAlive 가 재기동해도 같은 이유로 즉시 죽으므로, 반드시 크게 실패한다.
  // 이 근거를 주석에 남겨서 다음 사람이 "왜 재시도 안 하나"로 되돌리지 않도록 한다.
  it('실행 파일 부재는 재시도로 낫지 않는다 — launchd KeepAlive 가 재기동해도 같은 이유로 죽는다', () => {
    const err = new ExecutableNotFoundError('/nonexistent/harness', '/usr/bin');
    const plan = runnerExitPlan(err);
    expect(plan).not.toBeNull();
    expect(plan?.code).toBe(78);
  });
});
