import { chmod, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Codex 가 기본으로 쓰는 사용자 상태 루트. 러너가 받은 CODEX_HOME 도 존중한다. */
export function sourceCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEX_HOME ?? join(homedir(), '.codex'));
}

/**
 * Murmur 전용 Codex 상태 루트를 만든다.
 *
 * Codex 의 `CODEX_HOME` 은 config·auth·sessions 를 한꺼번에 바꾼다. 대화형 `codex resume` 은
 * `--ignore-user-config` 를 실제 파서에서 거부하므로, 개인 config.toml/MCP 를 상속하지 않게
 * 하려면 별도 CODEX_HOME 이 필요하다. 로그인만 재사용할 수 있도록 기존 auth.json 이 있을
 * 때에만 심볼릭 링크하고, config·sessions·logs 는 이 에이전트 상태 디렉터리에 격리한다.
 *
 * 링크 대상 auth.json 이 아직 없으면 아무것도 만들지 않는다. 그러면 Codex 자신의 로그인
 * 안내가 그대로 보이고, 사용자는 해당 러너 환경에서 로그인할 수 있다.
 */
export async function ensureCodexHome(
  codexHome: string,
  sourceHome: string = sourceCodexHome(),
): Promise<string> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await chmod(codexHome, 0o700);

  const sourceAuth = join(sourceHome, 'auth.json');
  const targetAuth = join(codexHome, 'auth.json');
  const sourceStat = await lstat(sourceAuth).catch(() => null);
  if (!sourceStat) return codexHome;

  const targetStat = await lstat(targetAuth).catch(() => null);
  if (!targetStat) {
    await symlink(sourceAuth, targetAuth);
    return codexHome;
  }

  // 이미 Murmur 전용 로그인이 있으면 보존한다. 심볼릭 링크라면 엉뚱한 자격증명을 가리키는
  // 상태만 크게 실패시킨다 — 자동 교체는 사용자가 로그인한 파일을 지울 수 있다.
  if (targetStat.isSymbolicLink()) {
    const target = await readlink(targetAuth);
    if (resolve(codexHome, target) !== resolve(sourceAuth)) {
      throw new Error(
        `Murmur Codex auth 링크가 예상과 다르다: ${targetAuth} -> ${target}. ` +
          `예상 대상은 ${sourceAuth} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.`,
      );
    }
  }
  return codexHome;
}

export function codexSessionsDir(codexHome: string): string {
  return join(codexHome, 'sessions');
}
