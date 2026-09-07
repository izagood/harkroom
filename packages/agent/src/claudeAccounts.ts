// claude 계정 풀. 계정 하나 = `CLAUDE_CONFIG_DIR` 하나다.
//
// **왜 이 축이 성립하는가**(2026-09-07 실측, claude 2.1.263): macOS 의 claude 는 자격증명을
// Keychain 에서 먼저 읽고 **서비스 이름을 `CLAUDE_CONFIG_DIR` 경로의 sha256 앞 8자로
// 파생한다**(미설정이면 `Claude Code-credentials`). 파일 폴백은 `<configDir>/.credentials.json`.
// 즉 config 디렉터리를 바꾸면 자격증명이 통째로 갈린다 — 빈 디렉터리를 주고 `claude -p` 를
// 돌리면 `Not logged in · Please run /login` 이 뜬다(종료 코드 1). 세션 파일
// (`<configDir>/projects`)도 같이 따라간다 — 그래서 `claudeSessions.ts` 가 이 값을 받는다.
//
// **이 모듈이 있는 이유는 러너가 시스템 기본 계정에 묶여 있었다는 것이다.** 러너는
// `CLAUDE_CONFIG_DIR` 를 설정하지 않아 언제나 `~/.claude` 를 썼고, 계정 전환을 그 경로로
// 하지 않는 도구(Orca 등은 `CLAUDE_CONFIG_DIR` 주입으로 전환한다)에서는 사람이 계정을 바꿔도
// 러너에 닿지 않았다. 러너 env 는 데몬 env 를 통째로 상속하고 `MURMUR_PAT`·`MURMUR_URL`·
// `PATH` 만 덮어쓰므로(`desktop/src/lib/runnerLauncher.ts`), 그 자리에 계정이 들어올 길이
// 아예 없었다.
//
// **계정 뿌리는 러너 상태 디렉터리 밖이다.** `codexHome` 은 러너별로 격리하는 것이 목적
// (개인 config.toml 을 물려주지 않는다)이지만, 계정은 그 반대다 — 에이전트·인스턴스·서버를
// 가로지르는 자산이고, `resolveAgentStateDir` 아래 두면 에이전트마다 다시 로그인해야 한다.
//
// **목록의 진실은 디스크다.** 별도 설정 파일을 두지 않는다. 파일을 두면 파일과 디스크가
// 갈리는 날이 오고, 그날 러너는 없는 계정을 가리킨다(`ensureCodexHome` 이 `auth.json` 의
// 존재로 판정하는 것과 같은 규율).
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 계정 이름 문법. `config.ts::INSTANCE_PATTERN` 과 **같은 값**이고 같은 이유다 — 이 이름이
 * 경로 세그먼트가 되므로 `..` 나 `/` 가 들어올 여지를 문법에서 끊는다.
 */
export const CLAUDE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ClaudeAccount {
  name: string;
  /** 이 계정의 `CLAUDE_CONFIG_DIR`. 자격증명·세션·설정이 모두 이 아래 있다. */
  configDir: string;
}

/** 계정 풀의 뿌리. `MURMUR_CLAUDE_ACCOUNTS_DIR` 로 옮길 수 있다(테스트와 다른 볼륨용). */
export function claudeAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MURMUR_CLAUDE_ACCOUNTS_DIR ?? join(homedir(), '.murmur-agent', 'claude-accounts');
}

/**
 * 계정 풀을 읽는다. **빈 배열은 정상이다** — 풀을 안 만든 러너는 `CLAUDE_CONFIG_DIR` 주입
 * 없이 시스템 기본(`~/.claude`)을 쓴다. 하위 호환이 그 한 줄에 걸려 있다.
 *
 * `order` 는 `MURMUR_CLAUDE_ACCOUNTS`(쉼표 구분)다. 순서와 부분집합을 동시에 정한다.
 * 없는 이름이 오면 **던진다**: 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로
 * 돌고, 그 사고는 화면에 아무 흔적을 남기지 않는다(`config.ts::validateInstance` 판례).
 */
export async function loadClaudeAccounts(
  opts: { root?: string; order?: string | undefined } = {},
): Promise<ClaudeAccount[]> {
  const root = opts.root ?? claudeAccountsRoot();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // 뿌리가 없다 = 계정을 하나도 안 만들었다. "없음"의 정상 경로이지 에러가 아니다
    // (`claudeSessions.ts` 가 projects 디렉터리 부재를 같게 다루는 것과 짝을 이룬다).
    return [];
  }

  // 사전순으로 고정한다 — 순서가 예측 불가능하면 로그를 읽어도 다음 계정을 알 수 없다.
  // 문법에 안 맞는 이름은 여기서 걸러 낸다: `.DS_Store` 나 `Lime Backup` 같은 것을 계정으로
  // 세면 러너가 없는 로그인을 가리키고, 계정 축이 한 칸 헛돈다.
  const found = entries
    .filter((e) => e.isDirectory() && CLAUDE_ACCOUNT_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();

  const order = (opts.order ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!order.length) return found.map((name) => ({ name, configDir: join(root, name) }));

  const missing = order.filter((name) => !found.includes(name));
  if (missing.length) {
    throw new Error(
      `MURMUR_CLAUDE_ACCOUNTS 에 없는 계정이 있다: ${missing.join(', ')}. ` +
      `${root} 아래에 있는 계정은 ${found.length ? found.join(', ') : '(없음)'} 이다.`,
    );
  }
  return order.map((name) => ({ name, configDir: join(root, name) }));
}
