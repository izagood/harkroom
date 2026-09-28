import { chmod, lstat, mkdir, readFile, readlink, rename, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  CODEX_ACCOUNT_NAME_PATTERN,
  CODEX_ACTIVE_FILE,
  parseCodexActive,
} from '@harkroom/shared/codexAccounts';

/** Codex 가 기본으로 쓰는 사용자 상태 루트. 러너가 받은 CODEX_HOME 도 존중한다. */
export function sourceCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEX_HOME ?? join(homedir(), '.codex'));
}

/**
 * codex 계정 뿌리. 데몬의 `codexAccountsRoot()`(`operator/src/codexAccounts.ts`)와 **같은 값**
 * 이어야 한다 — 쓰는 쪽과 읽는 쪽이 갈리면 활성 계정을 골라도 러너에 닿지 않는다.
 */
export function codexAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HARKROOM_CODEX_ACCOUNTS_DIR ?? join(homedir(), '.harkroom-agent', 'codex-accounts'));
}

/**
 * 이번 턴이 쓸 로그인의 자리(= auth.json 이 있는 디렉터리).
 *
 * `active.json` 이 계정을 가리키고 그 계정에 `auth.json` 이 있으면 그 계정 디렉터리, 아니면
 * 시스템 기본(`sourceCodexHome`). **던지지 않는다** — 턴마다 부르므로 파일 하나가 깨졌다고
 * codex 턴 전부가 죽으면 안 된다. 가리킨 계정에 로그인이 없을 때 시스템으로 떨어지는 것도
 * 같은 이유다(로그인 안 된 홈을 주면 codex 가 로그인 안내를 찍고 턴이 멈춘다).
 */
export async function codexAuthSource(env: NodeJS.ProcessEnv = process.env): Promise<{
  home: string;
  account: string | null;
}> {
  const root = codexAccountsRoot(env);
  const system = { home: sourceCodexHome(env), account: null };
  let active: string | null = null;
  try {
    active = parseCodexActive(JSON.parse(await readFile(join(root, CODEX_ACTIVE_FILE), 'utf8'))).active;
  } catch {
    return system;
  }
  if (!active || !CODEX_ACCOUNT_NAME_PATTERN.test(active)) return system;
  const home = join(root, active);
  const has = await lstat(join(home, 'auth.json')).then(() => true, () => false);
  return has ? { home, account: active } : system;
}

/**
 * Harkroom 전용 Codex 상태 루트를 만든다.
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
  opts: {
    /** 링크를 돌려도 되는 옛 자리들(보통 시스템 기본 홈). */
    knownHomes?: string[];
    /** 이 아래의 계정 홈을 가리키는 링크도 돌려도 된다(`codexAccountsRoot`). */
    accountsRoot?: string;
  } = {},
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

  // 이미 Harkroom 전용 로그인이 있으면 보존한다. 심볼릭 링크라면 엉뚱한 자격증명을 가리키는
  // 상태만 크게 실패시킨다 — 자동 교체는 사용자가 로그인한 파일을 지울 수 있다.
  //
  // **예외는 우리가 아는 자리끼리의 전환이다**(여러 codex 계정). 링크가 시스템 기본 또는 계정
  // 뿌리 아래의 `auth.json` 을 가리키고 있으면, 그것은 이 함수가 앞선 턴에 건 링크다 — 활성
  // 계정이 바뀐 것이므로 새 자리로 돌린다. 링크만 바꾸고 **파일은 건드리지 않는다.**
  if (targetStat.isSymbolicLink()) {
    const target = await readlink(targetAuth);
    const current = resolve(codexHome, target);
    if (current === resolve(sourceAuth)) return codexHome;
    const known = (opts.knownHomes ?? []).map((h) => resolve(h));
    const accountsRoot = opts.accountsRoot ? resolve(opts.accountsRoot) : null;
    const currentHome = dirname(current);
    const ours = known.includes(currentHome)
      || (accountsRoot !== null && dirname(currentHome) === accountsRoot);
    if (ours) {
      // 원자적으로 바꾼다: 새 링크를 옆에 만들고 rename 으로 덮는다. unlink → symlink 사이에
      // 도는 codex 가 "로그인 없음"을 보는 틈을 만들지 않는다.
      const tmp = `${targetAuth}.tmp-${randomUUID()}`;
      await symlink(sourceAuth, tmp);
      await rename(tmp, targetAuth);
      return codexHome;
    }
    throw new Error(
      `Harkroom Codex auth 링크가 예상과 다르다: ${targetAuth} -> ${target}. ` +
        `예상 대상은 ${sourceAuth} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.`,
    );
  }
  return codexHome;
}

/**
 * 러너의 격리 `CODEX_HOME` 을 **지금 활성인 codex 계정**에 맞춘다. 기동 때 한 번, 그리고
 * codex 턴을 띄우기 직전마다 부른다 — 설정 화면에서 활성 계정을 바꾸면 러너를 재시작하지
 * 않아도 다음 턴부터 그 계정으로 돈다. 돌려주는 `account` 는 로그용이다(`null` = 시스템 기본).
 */
export async function syncCodexAuth(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ codexHome: string; account: string | null }> {
  const source = await codexAuthSource(env);
  await ensureCodexHome(codexHome, source.home, {
    knownHomes: [sourceCodexHome(env)],
    accountsRoot: codexAccountsRoot(env),
  });
  return { codexHome, account: source.account };
}

export function codexSessionsDir(codexHome: string): string {
  return join(codexHome, 'sessions');
}
