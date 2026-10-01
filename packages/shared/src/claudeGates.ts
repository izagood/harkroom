// claude TUI 의 **계정 단위 관문**을 미리 지나 둔다(2026-10-01). 러너(`agent/src/workspaceTrust.ts`)와
// operator(계정 로그인 직후, `operator/src/claudeAccounts.ts`)가 같은 함수를 쓴다 — 두 벌이면
// 한쪽만 고쳐지는 날이 온다.
//
// ## 왜 필요한가 (실측, claude 2.1.286)
// - **첫 실행 테마 선택.** `<configDir>/.claude.json` 에 `hasCompletedOnboarding: true` 가 없으면
//   TUI 가 테마 선택 화면부터 띄운다. 러너는 답할 수 없어 준비 상한(60초)을 다 태운 뒤 다음
//   계정으로 넘어갔다 — 풀의 계정 하나가 배정마다 그렇게 넘어가 한 번도 돌지 않았다. 빈 config
//   디렉터리로 띄워 재 보면 이 키 하나로 그 화면이 사라진다(테마 값만 적어서는 안 사라진다).
// - **"Teach auto mode about your environment?"** auto mode 분류기 거부가 계정에 5번 쌓이면
//   턴이 **끝난 뒤** 이 선택 창이 뜬다. 턴 끝 판정에는 영향이 없지만 화면에 남아, 그 세션을
//   터미널로 연 사람이 친 글을 먹는다. "Don't show again" 이 적는 값이 `autoModeEnvSetup.dismissed`
//   다(바이너리에서 읽었다). 같은 값을 적는다 — 안내 창일 뿐이라 권한이 새로 열리지 않는다.
//
// ## 규율 (`workspaceTrust.ts` 판례)
// - **이미 적혀 있으면 아무것도 쓰지 않는다.** 이 파일은 하네스가 비용·통계 등을 함께 담는
//   곳이라, 매번 다시 쓰면 그 상태를 놓고 하네스와 경합한다.
// - **다른 키는 건드리지 않는다.** `autoModeEnvSetup` 안의 `denials` 등도 그대로 둔다.
// - 파일이 깨졌으면 **쓰지 않는다** — 하네스의 상태를 우리 최소 문서로 덮으면 되돌릴 수 없다.
//   (없을 때만 새로 만든다.)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 계정 config 디렉터리 안의 claude 전역 설정 파일. */
export const CLAUDE_GLOBAL_CONFIG_FILE = '.claude.json';

/**
 * 관문 키를 채운 새 문서. **바꿀 것이 없으면 `null`** — 호출자는 그때 파일을 쓰지 않는다.
 * 순수 함수다(테스트가 파일 없이 규칙을 잰다).
 */
export function withClaudeAccountGates(doc: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;
  const next: Record<string, unknown> = { ...doc };
  if (next.hasCompletedOnboarding !== true) {
    next.hasCompletedOnboarding = true;
    changed = true;
  }
  const raw = next.autoModeEnvSetup;
  const setup = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (setup.dismissed !== true) {
    next.autoModeEnvSetup = { ...setup, dismissed: true };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * `<configDir>/.claude.json` 에 관문 키를 적는다. 썼으면 `true`.
 *
 * **던진다** — 삼킬지는 호출자가 정한다(러너는 삼키고 로그를 남긴다: 못 적으면 관문이 뜨고
 * 준비 대기가 그 사실을 드러낸다).
 */
export async function markClaudeAccountGates(configDir: string): Promise<boolean> {
  const path = join(configDir, CLAUDE_GLOBAL_CONFIG_FILE);
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let doc: Record<string, unknown> = {};
  if (text !== null) {
    const parsed: unknown = JSON.parse(text); // 깨졌으면 던진다 — 위 "쓰지 않는다"
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path} 가 객체가 아니다 — 덮어쓰지 않는다`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const next = withClaudeAccountGates(doc);
  if (next === null) return false;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // 0600 — 이 파일에는 MCP 설정과 사용 통계가 함께 산다(`workspaceTrust.ts` 와 같다).
  await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}
