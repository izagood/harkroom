/**
 * 러너 종료 코드 회귀선(#250).
 *
 * 이 계약이 왜 중요한가: 앱이 PAT 를 회전할 때 옛 PAT 로 돌던 러너를 물러나게 하는 수단은
 * 서버의 401 과 **이 종료 코드뿐**이다(러너↔앱 통신 채널을 만들지 않기로 했다). 78 이
 * 아니면 앱은 "그냥 죽었다"와 구분할 수 없고, 사람에게 "재발급하면 다시 뜬다"를 말할 수 없다.
 */
import { describe, it, expect } from 'vitest';
import { CREDENTIAL_REJECTED_LINE, EX_CONFIG, EXECUTABLE_NOT_FOUND_LINE, runnerExitPlan } from '../src/exit.js';
import { ExecutableNotFoundError, MURMUR_ERROR_SOURCE } from '../src/policy.js';

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

describe('#340 하네스 실행 파일 부재는 78 로 물러난다', () => {
  const err = new ExecutableNotFoundError('claude', '/usr/bin:/bin');

  it('78 로 물러난다 — 재시도로 낫지 않으므로 크게 실패한다', () => {
    expect(runnerExitPlan(err)?.code).toBe(EX_CONFIG);
    expect(EX_CONFIG).toBe(78);
  });

  // 종료 코드는 자격증명 실패와 같은 78 이다. 그래서 **마지막 줄만이** 운영자에게 "PAT 를
  // 재발급해라"와 "PATH 를 고쳐라"를 갈라 준다 — 이 줄이 흔들리면 두 사고가 구별되지 않는다.
  it('마지막 줄이 자격증명 쪽과 다르다 — 같은 78 을 가르는 유일한 표식이다', () => {
    const plan = runnerExitPlan(err)!;
    expect(plan.lines.at(-1)).toBe(EXECUTABLE_NOT_FOUND_LINE);
    expect(plan.lines.at(-1)).not.toBe(CREDENTIAL_REJECTED_LINE);
    expect(plan.lines.join('\n')).not.toContain(CREDENTIAL_REJECTED_LINE);
  });

  // 운영자가 로그만 보고 고칠 수 있어야 한다: **무엇을** 못 찾았는지(실행 파일)와 **어디를**
  // 뒤졌는지(자식에게 넘긴 PATH), 그리고 launchd 가 PATH 를 안 물려준다는 안내.
  it('로그에 실행 파일과 자식의 PATH, PATH 안내가 남는다', () => {
    const log = runnerExitPlan(new ExecutableNotFoundError('claude', '/usr/bin:/bin'))!.lines.join('\n');
    expect(log).toContain('claude');
    expect(log).toContain('/usr/bin:/bin');
    expect(log).toContain('PATH');
    expect(log).toContain('launchd');
  });

  // PATH 가 통째로 비어서 나는 사고가 이 결함의 원형이다 — 그때 빈 문자열을 그대로 찍으면
  // 로그가 "PATH: " 로 끝나 사람이 잘린 줄로 읽는다.
  it('PATH 가 비면 (empty) 로 적는다', () => {
    expect(runnerExitPlan(new ExecutableNotFoundError('claude', ''))!.lines.join('\n'))
      .toContain('(empty)');
    expect(runnerExitPlan(new ExecutableNotFoundError('claude', undefined))!.lines.join('\n'))
      .toContain('(empty)');
  });

  // 자격증명 실패의 기존 동작이 이 추가로 흔들리지 않았다 — 두 판정이 같은 자리에 나란히
  // 있으므로, 앞쪽이 뒤쪽 입력을 물면 안내문이 통째로 뒤바뀐다.
  it('자격증명 실패는 그대로 자격증명 안내로 간다', () => {
    const plan = runnerExitPlan(new Error('could not resolve authentication'))!;
    expect(plan.code).toBe(EX_CONFIG);
    expect(plan.lines.at(-1)).toBe(CREDENTIAL_REJECTED_LINE);
    expect(plan.lines.join('\n')).not.toContain(EXECUTABLE_NOT_FOUND_LINE);
  });
});
