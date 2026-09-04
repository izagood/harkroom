/**
 * 러너의 종료 코드 판정(#250).
 *
 * 왜 별 모듈인가: `main.ts` 는 top-level await 로 접속·설정 파일 쓰기 같은 부작용을 곧바로
 * 일으켜 테스트가 import 할 수 없다. 판정을 거기 두면 "401 이면 78 로 물러난다"는 보증에
 * 회귀선을 걸 자리가 없다 — 그리고 이 보증은 앱의 PAT 회전이 기대는 유일한 계약이다
 * (러너↔앱 통신 채널은 만들지 않기로 했으므로, 옛 PAT 로 돌던 러너를 물러나게 하는 것은
 * 서버의 401 과 이 종료 코드뿐이다).
 */
import { ExecutableNotFoundError, isCredentialFailure, isExecutableNotFound } from './policy.js';

/** `sysexits.h` 의 `EX_CONFIG`. "설정이 틀렸다 — 재시도로 낫지 않는다"는 뜻이다. */
export const EX_CONFIG = 78;

/**
 * 앱(그리고 사람)이 이 한 줄을 찾는다. 문구를 바꾸면 앱의 로그 판정이 아니라 **사람의
 * 판정**이 깨진다 — 앱은 종료 코드로 판정하므로 여기 의존하지 않는다(의도적이다:
 * stdout 파싱은 언어·로케일에 흔들린다).
 */
export const CREDENTIAL_REJECTED_LINE =
  'murmur-agent: credential rejected (revoked or rotated); exiting';

/**
 * 하네스 실행 파일 부재(#340)의 마지막 줄. 위 `CREDENTIAL_REJECTED_LINE` 과 같은 규율이다 —
 * 사람이 로그에서 이 한 줄을 찾는다. 종료 코드는 둘 다 78 이라 로그의 이 줄만이 "PAT 를
 * 재발급해라"와 "PATH 를 고쳐라"를 갈라 준다.
 */
export const EXECUTABLE_NOT_FOUND_LINE =
  'murmur-agent: harness executable not found; exiting';

export interface RunnerExitPlan {
  code: typeof EX_CONFIG;
  /**
   * stderr 에 이 순서대로 찍는다. 마지막 줄은 어느 실패냐에 따라 `CREDENTIAL_REJECTED_LINE`
   * 이거나 `EXECUTABLE_NOT_FOUND_LINE` 이다 — 종료 코드(78)가 같으므로 **그 줄이 유일한
   * 구분자**다.
   */
  lines: string[];
}

/**
 * 이 오류로 러너가 물러나야 하는가. **재시도로 낫지 않는 실패**가 아니면 `null` — 호출부가
 * 원래 흐름(재시도·백오프)을 그대로 잇는다. 지금 그 부류는 둘이다: 자격증명 실패(#250)와
 * 하네스 실행 파일 부재(#340).
 *
 * **자격증명 실패는 세 자리에서 온다**: 기동 시점의 첫 호출(`murmur.me()`), 멘션 턴,
 * 그리고 **폴 루프**. 폴 루프가 가장 중요하다 — 앱이 PAT 를 회전할 때 옛 러너는 거의 항상
 * 롱폴에 park 돼 있고, 거기서 온 401 을 "재접속하면 된다"로 삼키면 러너는 영원히 물러나지
 * 않는다(회전이 약속한 것이 그 반대다).
 *
 * 실행 파일 부재는 그중 **멘션 턴** 한 자리에서만 온다(`pty.ts::runPtyTurn`). 자격증명보다
 * **먼저** 보는 이유는 순서가 아니라 배타성이다 — 두 판정이 같은 오류를 물 일이 없으므로
 * 순서는 결과를 바꾸지 않고, 읽는 사람이 "새로 생긴 쪽"을 먼저 보게 두는 편이 낫다.
 */
export function runnerExitPlan(err: unknown): RunnerExitPlan | null {
  // 왜 재시도하지 않고 죽나: PATH 나 설치 상태가 그대로인 한 다음 시도도 같은 자리에서
  // 실패한다. launchd `KeepAlive` 가 다시 띄워도 같은 이유로 즉시 죽으므로 로그에 같은 줄이
  // 쌓이고, 운영자는 원인을 바로 본다 — 조용히 살아서 멘션을 MAX_ATTEMPTS 건씩 삼키는 것보다
  // 낫다(스펙 §8 실패 표 1행).
  if (isExecutableNotFound(err) === 'executable-not-found') {
    // 판정은 위 한 줄이 전부다(`policy.ts` 가 클래스로 판정한다) — 여기서 다시 재지 않는다.
    // 그 판정이 참이면 err 는 그 클래스이므로, 아래 캐스팅은 좁히기일 뿐 새 판정이 아니다.
    const notFound = err as ExecutableNotFoundError;
    return {
      code: EX_CONFIG,
      lines: [
        '\nharness 실행 파일을 찾을 수 없다. 러너를 멈춘다.',
        `  실행 파일: ${notFound.command}`,
        // 러너 자신의 PATH 가 아니라 **자식에게 넘긴** PATH 다. launchd 로 뜬 러너는 로그인
        // 셸의 PATH 를 못 물려받아 이 둘이 갈리고, 그 갈림이 정확히 이 실패의 원인이다.
        `  자식에게 넘긴 PATH: ${notFound.path || '(empty)'}`,
        '  하네스를 설치했는지, 그 경로가 러너의 PATH 에 있는지 확인해라.',
        '  launchd/systemd 로 띄웠다면 로그인 셸의 PATH 가 상속되지 않는다 — 서비스 정의에 직접 적어라.',
        EXECUTABLE_NOT_FOUND_LINE,
      ],
    };
  }

  const credType = isCredentialFailure(err);
  if (credType === 'other') return null;

  const lines = [
    `\n${credType === 'murmur-credential' ? 'Murmur' : 'Harness'} 자격증명을 해결할 수 없다. 러너를 멈춘다.`,
  ];
  if (credType === 'murmur-credential') {
    lines.push('  Murmur API 의 PAT 가 만료·폐기됐는지 확인해라.');
    lines.push('  MURMUR_PAT 환경변수를 새 PAT 로 교체하고 러너를 재시작한다.');
    lines.push('  데스크탑 앱이 띄운 러너라면 설정 → 에이전트에서 "PAT 재발급"을 누른다.');
  } else {
    lines.push('  claude-code harness 는 claude CLI 의 로그인을 쓴다 — `claude` 를 한 번 실행해 로그인해라.');
  }
  lines.push(`  원문: ${err instanceof Error ? err.message : String(err)}`);
  lines.push(CREDENTIAL_REJECTED_LINE);
  return { code: EX_CONFIG, lines };
}
