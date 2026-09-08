// 어느 계정으로 이미 사람을 불렀는지 기억한다(2026-09-08).
//
// **왜 계정 단위인가.** 첫 실행 관문은 계정 설정에 기록된다 — 온보딩은
// `<configDir>/.claude.json` 의 `hasCompletedOnboarding`, bypass 수락은
// `<configDir>/settings.json` 의 `skipDangerousModePermissionPrompt` 다(실측). 한 번
// 지나면 그 계정의 모든 워크스페이스가 풀리므로, 스레드마다 부르면 사람이 같은 승인을
// 반복한다 — 2026-09-08 에 7개 스레드가 동시에 걸렸고, 그대로였다면 창이 7개 떴다.
//
// 워크스페이스 단위 관문(폴더 신뢰)은 여기 오지 않는다. `workspaceTrust.ts` 가 PTY 를
// 띄우기 전에 심어서 아예 뜨지 않기 때문이다.
//
// **왜 러너 안의 Map 인가.** 이 사실은 러너 프로세스보다 오래 살 필요가 없다. 러너가
// 다시 뜨면 관문도 다시 재는 것이 맞다 — 디스크에 남기면 "예전에 불렀다"가 "사람이 그
// 승인을 실제로 했다"는 뜻으로 잘못 굳는다.

export interface AttentionLedger {
  /**
   * 이 계정으로 **처음** 부르는가. `true` 면 부른다.
   *
   * `sessionId` 를 함께 받는 이유: 같은 세션이 두 자리에서 부를 수 있고(준비 상한,
   * 주입 확인 창) 사람에게 같은 말을 두 번 하지 않기 위해서다.
   */
  claim(accountLabel: string, sessionId: string): boolean;
  /** 그 계정의 부름을 놓는다(세션 종료). 다음 관문은 다시 부를 수 있다. */
  release(accountLabel: string): void;
}

export function createAttentionLedger(): AttentionLedger {
  const held = new Map<string, string>();
  return {
    claim(accountLabel, sessionId) {
      if (held.has(accountLabel)) return false;
      // 세션 id 를 함께 담는다 — 운영 중 "어느 세션이 사람을 기다리는가"를 로그로
      // 답할 수 있어야 한다. 잡는 판정 자체는 계정만으로 한다(관문이 계정 단위다).
      held.set(accountLabel, sessionId);
      return true;
    },
    release(accountLabel) {
      held.delete(accountLabel);
    },
  };
}
