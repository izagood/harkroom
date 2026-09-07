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

import { isCredentialFailure, isExecutableNotFound, isQuotaExhausted } from './policy.js';

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

/**
 * 이 오류에서 **계정을 바꿔 다시 해 볼 만한가**.
 *
 * `policy.ts` 가 아니라 여기 있는 이유: 그 파일은 아무것도 import 하지 않는다는 규율이
 * 있고(파일 머리 주석), 이 판정은 그 파일의 세 판정을 **조합**한다. 조합을 거기 두면 그
 * 규율이 깨지고, 여기 두면 "계정 축의 판단은 계정 모듈에 있다"가 성립한다.
 *
 * 참인 경우 둘:
 * - **사용량 한도** — `policy.ts::isQuotaExhausted` 주석은 "여기서 할 일은 기다리는 것뿐"
 *   이라 적었다. 계정이 여러 개면 그 말이 더는 참이 아니다 — 기다리지 않고 옮겨 탈 수 있다.
 * - **harness 자격증명 실패** — 그 계정의 로그인이 만료·부재다. 다른 계정은 멀쩡할 수 있다.
 *
 * 거짓인 경우: murmur PAT 실패(계정과 무관하다 — 러너가 물러나야 한다, #250), 실행 파일
 * 부재(PATH 문제다, #340), 그리고 평범한 실패(기존 재시도 회계로 간다).
 *
 * **실행 파일 부재를 먼저 보는 이유는 순서가 아니라 배타성이다.**
 * `ExecutableNotFoundError` 의 메시지에는 자식에게 넘긴 PATH 가 그대로 실려 있어, 그 경로에
 * `notloggedin` 같은 문구가 들어 있으면 아래 자격증명 판정이 문구 매칭으로 걸린다.
 */
export function switchesAccount(err: unknown): boolean {
  if (isExecutableNotFound(err) === 'executable-not-found') return false;
  if (isQuotaExhausted(err) !== null) return true;
  return isCredentialFailure(err) === 'harness-credential';
}

/**
 * 계정 축을 돌며 `attempt` 를 시도한다. 계정을 바꿔서 나을 실패(`switchesAccount`)면 다음
 * 계정으로 **같은 일**을 다시 시도하고, 아니면 즉시 그 오류를 던진다.
 *
 * **별 함수로 뺀 이유는 제어 흐름이다.** `main.ts` 의 멘션 루프는 유예·종료요청·한도
 * 분기에서 `continue`·`break` 를 쓴다. 계정 루프를 그 안에 인라인으로 넣으면 그 제어문이
 * 계정 루프를 향하게 되어 조용히 멘션 루프를 못 벗어난다. 함수 경계로 끊고, 그 덕에 이
 * 판단이 루프 없이 검증된다.
 *
 * **재시도 회계(`MAX_ATTEMPTS`)와 별개로 돈다.** 그 회계는 "같은 조건으로 또 해 봤다"를
 * 세는 것이고, 계정을 바꾼 것은 조건이 달라진 것이다. 두 축을 곱하면 계정 3개 × 3회 = 9번을
 * 태우게 되고 그중 8번은 이미 답을 아는 실패다. 그래서 한 계정에서는 **한 번만** 시도한다 —
 * 방아쇠가 참이라는 것은 그 계정에서 재시도로 낫지 않는다는 판정이 이미 끝났다는 뜻이다.
 *
 * `accounts` 가 `[null]` 이면 한 번 돌고 기존 동작과 같아진다(계정 풀을 안 만든 러너).
 * **빈 배열은 호출자 결함이다** — 조용히 성공값을 지어내면 답하지 않은 멘션이 답한 것으로
 * 처리되므로 던진다.
 */
export async function withAccountFailover<T>(
  accounts: readonly (ClaudeAccount | null)[],
  attempt: (account: ClaudeAccount | null) => Promise<T>,
  onSwitch?: (from: ClaudeAccount | null, to: ClaudeAccount | null) => void,
): Promise<T> {
  if (!accounts.length) {
    throw new Error('withAccountFailover: 계정 축이 비어 있다 — 호출자는 최소 [null] 을 넘겨야 한다');
  }
  let last: unknown;
  for (const [idx, account] of accounts.entries()) {
    if (idx > 0) onSwitch?.(accounts[idx - 1] ?? null, account);
    try {
      return await attempt(account);
    } catch (err) {
      last = err;
      // 계정을 바꿔서 나을 실패가 아니면 축을 헛돌지 않는다 — 호출자의 기존 실패 경로가
      // 이 오류를 받아야 한다(재시도 회계, 러너 물러남, 실행 파일 부재 안내).
      if (!switchesAccount(err)) throw err;
    }
  }
  // 모든 계정이 방아쇠에 걸렸다. 마지막 오류를 던져 호출자의 한도·자격증명 경로가 받게 한다.
  throw last;
}
