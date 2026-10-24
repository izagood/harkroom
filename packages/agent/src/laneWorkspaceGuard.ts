// API 키 연결(전용 제공사 경로) 턴의 작업 폴더 검사(security, 2026-10-23).
//
// 작업 폴더의 몇몇 이름은 **다음 턴**의 지시·도구·플러그인을 바꾼다(`.claude/`·`.opencode/`·`.codex/`·`CLAUDE.md`·`AGENTS.md`·`.mcp.json`·
// `opencode.json[c]`·`kilo.json[c]`·`.kilo/`·`.kilocoderules`). 권한 표의 이름 맞추기만으로는 다 닫히지 않는다 — 그래서 하네스를 띄우기 **전에** 폴더를 훑어, 그런 이름이
// (대소문자를 가리지 않고) 우리 것이 아닌 꼴로 있으면 그 턴을 띄우지 않는다. 사람의 파일일 수 있으니 지우지 않는다(fail-closed).
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/** 다음 턴을 바꾸는 이름(소문자). 대소문자를 가리지 않고 맞춘다. */
const PROTECTED_NAMES = new Set([
  // `.codex`: codex 프로젝트 설정 폴더(security F1). 러너는 여기 아무것도 깔지 않는다.
  '.claude', '.opencode', '.agents', '.codex', 'claude.md', 'claude.local.md', 'agents.md', 'context.md', '.mcp.json', 'opencode.json', 'opencode.jsonc',
  // kilo 프로젝트 설정·지시 이름(7.8.17 실측 — 이 이름들이 읽혔다).
  'kilo.json', 'kilo.jsonc', '.kilo', '.kilocode', '.kilocoderules',
]);

/** 러너가 스스로 까는 자리(`syncSkills`): `<이름>/skills/<slug>` 링크만 들어 있으면 우리 것이다. 이름은 글자 그대로 맞춘다. */
const RUNNER_SKILL_DIRS = new Set(['.claude', '.agents']);

async function onlyRunnerSkillLinks(dir: string, skillsDir: string): Promise<boolean> {
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return false;
  const top = await readdir(dir).catch(() => null);
  if (top === null || top.some((n) => n !== 'skills')) return false;
  if (top.length === 0) return true;
  const skills = join(dir, 'skills');
  const sst = await lstat(skills).catch(() => null);
  if (!sst?.isDirectory()) return false;
  for (const name of await readdir(skills).catch(() => [] as string[])) {
    const p = join(skills, name);
    const lst = await lstat(p).catch(() => null);
    if (!lst?.isSymbolicLink()) return false;
    // `syncSkills` 가 만드는 꼴(`<skillsDir>/<slug>`) 그대로일 때만 우리 것이다 — 앞머리 비교는 형제 폴더·`..` 를 통과시킨다.
    const target = await readlink(p).catch(() => null);
    if (target !== join(skillsDir, name)) return false;
  }
  return true;
}

/**
 * 작업 폴더 맨 위에서 다음 턴을 바꾸는 이름 중 우리 것이 아닌 것을 돌려준다(없으면 빈 배열). `skillsDir` 은 러너 상태의
 * 스킬 디렉터리(`<stateDir>/skills`) — 그곳을 가리키는 링크만 우리 것으로 본다.
 */
export async function laneWorkspaceViolations(workspaceDir: string, skillsDir: string): Promise<string[]> {
  const out: string[] = [];
  // 못 읽으면 걸린 것으로 본다(fail-closed) — 빈 목록으로 두면 검사 없이 턴이 뜬다.
  const names = await readdir(workspaceDir).catch(() => null);
  if (names === null) return ['(unreadable)'];
  for (const name of names) {
    if (!PROTECTED_NAMES.has(name.toLowerCase())) continue;
    if (RUNNER_SKILL_DIRS.has(name) && await onlyRunnerSkillLinks(join(workspaceDir, name), skillsDir)) continue;
    out.push(name);
  }
  return out.sort();
}
