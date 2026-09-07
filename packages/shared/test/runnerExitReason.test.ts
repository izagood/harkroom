/**
 * `runnerExitReason` 회귀선 — **78 의 두 사유를 가르는 판정 그 자체**(`#473`).
 *
 * 이 판정이 서는 자리가 하나여야 하는 이유는 `acceptRunnerExit` 이 함수인 이유와 같다:
 * 호출부마다 다시 쓰이면 한 곳에서 두 상수가 뒤바뀌어도 아무도 모른다. 그리고 그 사고의
 * 결과가 정확히 `#473` 이다 — 하네스가 없는 사람에게 PAT 재발급을 시키는 것.
 *
 * 앱 쪽 배선(문구·상태)은 `packages/desktop/test/runnerHarnessMissing.test.tsx` 가,
 * 실행 파일 이름 표가 러너의 것과 같은지는 `packages/agent/test/harnessBinary.test.ts` 가
 * 잰다. 여기서 재는 것은 **판정 함수 하나**다.
 */
import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_REJECTED_LINE,
  HARNESS_LOGIN_REQUIRED_LINE,
  EX_CONFIG,
  EXECUTABLE_NOT_FOUND_LINE,
  harnessBinaryName,
  runnerExitReason,
} from '../src/index.js';

describe('runnerExitReason — 로그 꼬리가 78 의 두 사유를 가른다', () => {
  /**
   * 2026-09-07 16:09 실측이 만든 세 번째 사유. 그때까지 78 의 자격증명 갈래는 하나였고,
   * 앱은 **하네스 로그인이 풀린 사람에게 "PAT 를 재발급하라"고 말했다** — `#473` 이 하네스
   * 부재에서 고친 것과 정확히 같은 결함이 자격증명 안에서 되풀이됐다.
   *
   * `policy.ts` 는 이미 둘을 갈라 놓고 있었다(`murmur-credential`·`harness-credential`).
   * 갈라지지 않은 곳은 **로그 마커**뿐이었고, 앱이 볼 수 있는 것은 그 마커뿐이다.
   */
  it('하네스 로그인 마커를 세 번째 사유로 가른다', () => {
    expect(runnerExitReason([HARNESS_LOGIN_REQUIRED_LINE])).toBe('harness-login-required');
  });

  it('두 자격증명 마커가 함께 보이면 모른다고 한다 — 지어내지 않는다', () => {
    expect(runnerExitReason([CREDENTIAL_REJECTED_LINE, HARNESS_LOGIN_REQUIRED_LINE])).toBeNull();
  });

  it('두 구분자를 각각 알아본다', () => {
    expect(runnerExitReason([EXECUTABLE_NOT_FOUND_LINE])).toBe('executable-not-found');
    expect(runnerExitReason([CREDENTIAL_REJECTED_LINE])).toBe('credential-rejected');
  });

  /**
   * **마지막 줄이 아니라 꼬리 안에 있는가로 잰다.**
   *
   * 러너의 stdout·stderr 가 같은 파일로 가므로(`#434` 의 리다이렉션) 물러나는 순간 다른
   * 경로가 한 줄 더 찍으면 구분자가 마지막 줄이 아니게 된다. `at(-1)` 로 재면 그 한 줄에
   * 판정이 뒤집히고, 그 실패는 조용하다 — 앱은 다시 사유를 지어내는 상태로 돌아간다.
   *
   * **되돌려 RED**: `some(...)` 을 `tailLines.at(-1)?.includes(...)` 로 바꾸면 빨개진다.
   */
  it('구분자 뒤에 다른 줄이 더 찍혀도 판정이 뒤집히지 않는다', () => {
    expect(
      runnerExitReason([EXECUTABLE_NOT_FOUND_LINE, '무관한 마지막 줄']),
    ).toBe('executable-not-found');
    expect(
      runnerExitReason(['앞선 안내', CREDENTIAL_REJECTED_LINE, '무관한 마지막 줄']),
    ).toBe('credential-rejected');
  });

  it('구분자가 긴 줄 안에 들어 있어도 알아본다', () => {
    expect(runnerExitReason([`2026-09-06T00:00:00Z ${EXECUTABLE_NOT_FOUND_LINE}`]))
      .toBe('executable-not-found');
  });

  /** 없으면 **모른다고 한다.** 지어내지 않는다(`#368`) — 그것이 `#473` 의 결함이었다. */
  it('꼬리가 없거나 구분자가 없으면 null 이다', () => {
    expect(runnerExitReason(undefined)).toBeNull();
    expect(runnerExitReason([])).toBeNull();
    expect(runnerExitReason(['알 수 없는 사유', '스택 어쩌고'])).toBeNull();
  });

  /**
   * 둘 다 보이면 **모른다고 한다.**
   *
   * 실제로는 러너가 하나만 찍으므로(`runnerExitPlan` 이 두 갈래 중 하나를 고른다) 이
   * 경우는 회전 직후 옛 세대의 꼬리가 섞였다는 뜻이다. 그때 하나를 골라 단정하는 것이
   * 바로 이 이슈가 막으려는 짓이다.
   */
  it('두 구분자가 다 보이면 하나를 골라 단정하지 않는다', () => {
    expect(runnerExitReason([CREDENTIAL_REJECTED_LINE, EXECUTABLE_NOT_FOUND_LINE])).toBeNull();
    expect(runnerExitReason([EXECUTABLE_NOT_FOUND_LINE, CREDENTIAL_REJECTED_LINE])).toBeNull();
  });
});

describe('상수 — 러너가 실제로 찍는 값이다', () => {
  /**
   * `EX_CONFIG` 가 78 인 것이 이 이슈의 전제다. 다른 값이 되면 두 사유가 코드를 공유하지
   * 않게 되어 이 판정 전체의 근거가 바뀐다 — 그때는 이 파일부터 다시 읽어야 한다.
   */
  it('EX_CONFIG 는 sysexits.h 의 78 이다', () => {
    expect(EX_CONFIG).toBe(78);
  });

  /**
   * **두 구분자가 서로 달라야 한다.** 같으면 `runnerExitReason` 은 언제나 둘 다 참으로
   * 보고 `null` 을 돌려준다 — 판정이 조용히 죽는다.
   */
  it('두 구분자는 서로 다르고, 한쪽이 다른 쪽을 품지 않는다', () => {
    expect(CREDENTIAL_REJECTED_LINE).not.toBe(EXECUTABLE_NOT_FOUND_LINE);
    expect(CREDENTIAL_REJECTED_LINE).not.toContain(EXECUTABLE_NOT_FOUND_LINE);
    expect(EXECUTABLE_NOT_FOUND_LINE).not.toContain(CREDENTIAL_REJECTED_LINE);
  });

  /**
   * **번역하지 않는다.** 이 두 줄은 러너가 영어 리터럴로 찍고 앱이 그대로 비교하는
   * 계약이다 — 다른 안내문과 달리 한국어가 아닌 이유가 그것이다. 로케일에 따라 바뀌면
   * 앱은 영원히 "구분자를 못 봤다"로 떨어진다.
   */
  it('구분자는 영어 리터럴이다 — 로케일에 흔들리지 않는다', () => {
    for (const line of [CREDENTIAL_REJECTED_LINE, EXECUTABLE_NOT_FOUND_LINE]) {
      expect(line.startsWith('murmur-agent: ')).toBe(true);
      // 한글이 섞이면 어딘가에서 번역됐다는 뜻이다.
      expect(/[가-힣]/.test(line)).toBe(false);
    }
  });
});

describe('harnessBinaryName — 사람이 설치할 것의 이름', () => {
  it('하네스 이름과 실행 파일 이름이 다르다는 사실을 담는다', () => {
    expect(harnessBinaryName('claude-code')).toBe('claude');
    expect(harnessBinaryName('codex')).toBe('codex');
  });

  it('모르는 값에는 지어내지 않는다', () => {
    expect(harnessBinaryName('gemini')).toBeNull();
    expect(harnessBinaryName(undefined)).toBeNull();
    expect(harnessBinaryName(null)).toBeNull();
    expect(harnessBinaryName('')).toBeNull();
  });
});
