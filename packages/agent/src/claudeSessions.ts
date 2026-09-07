// claude 세션 파일의 존재 확인(#337) — 인터랙티브 첫 턴이 끝난 뒤 "하네스 세션이 실재하게
// 됐는가"를 판정한다.
//
// 왜 필요한가(스파이크 실측, 계획 문서 "스파이크 결과" §2): claude 는 `--session-id` 로
// 띄워도 **첫 사용자 메시지 전에는 세션 파일을 만들지 않고**, 이미 존재하는 세션 id 로
// `--session-id` 를 다시 주면 "Session ID <uuid> is already in use." 로 즉시 죽는다.
// 즉 인터랙티브 첫 턴 뒤의 두 세계가 서로 반대의 조립을 요구한다:
//   - 사람이 대화했다(파일 있음) → 다음 턴은 resume(`-r`) 이어야 한다 — turnsRun 을 올린다.
//   - 열었다 그냥 닫았다(파일 없음) → 다음 턴은 다시 첫 턴(`--session-id`) — 그대로 둔다.
// 하네스 **출력**을 파싱하는 것이 아니다 — codex 의 rollout 발견(codexSessions.ts)과 같은
// "디스크의 사실" 관측이고, 그쪽과 같은 이유로 러너의 파싱 금지 원칙에 어긋나지 않는다.
//
// 탐색은 파일 이름(`<uuid>.jsonl`)으로만 한다. claude 는 세션을
// `~/.claude/projects/<cwd 를 뭉갠 이름>/<uuid>.jsonl` 에 두는데, cwd 뭉개기 규칙은
// claude 내부 구현이라 버전마다 바뀔 수 있다 — uuid 는 우리가 발급한 전역 유일값이므로
// 디렉터리 한 층을 훑어 이름만 대조하는 쪽이 규칙 변화에 강하다.
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * **경로는 `CLAUDE_CONFIG_DIR` 를 따라간다(2026-09-07).** 계정별 config 디렉터리로 claude 를
 * 띄우면 세션 파일도 `<configDir>/projects` 아래로 옮겨간다(실측). 이 판정이 계속 홈만 보면
 * 계정 디렉터리의 세션을 "없음"으로 읽고, 다음 턴이 첫 턴으로 조립돼 claude 가 이미 쓰인
 * 세션 id 를 `--session-id` 로 다시 받아 즉사한다 — 위 모듈 주석이 적은 바로 그 함정이다.
 *
 * 우선순위: `projectsDir`(직접 지정) → `configDir`(계정) → 시스템 기본. `projectsDir` 가
 * 이기는 이유는 그것이 projects 디렉터리 **자체**를 가리키는 더 구체적인 지정이기 때문이다.
 */
export async function claudeSessionFileExists(
  sessionId: string,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<boolean> {
  const root = opts.projectsDir
    ?? (opts.configDir ? join(opts.configDir, 'projects') : join(homedir(), '.claude', 'projects'));
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    // 디렉터리가 없다 = claude 세션이 하나도 없다 — "없음"의 정상 경로이지 에러가 아니다.
    return false;
  }
  const wanted = `${sessionId}.jsonl`;
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    try {
      const files = await readdir(join(root, entry.name));
      if (files.includes(wanted)) return true;
    } catch { /* 프로젝트 하나를 못 읽는 것이 나머지 탐색을 막지 않는다 */ }
  }
  return false;
}
