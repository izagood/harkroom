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
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  orderAccounts,
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from '@murmur/shared/claudePools';

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
  //
  // **`Dirent.isDirectory()` 로 재지 않는다 — 심볼릭 링크에 대해 거짓이다**(실물 검증에서
  // 드러났다: `isDirectory=false, isSymbolicLink=true`). 디렉터리를 가리키는 링크를 계정으로
  // 쓰는 것은 정당한 구성이다 — 이미 로그인된 config 디렉터리를 이름 붙여 풀에 넣는 방법이고,
  // `codexHome.ts` 도 auth.json 을 링크로 재사용한다. 그래서 `stat`(링크를 따라간다)으로
  // 다시 잰다. 끊어진 링크는 `stat` 이 던져 자동으로 걸러진다 — 가리키는 곳이 없으면 claude 가
  // 그 경로에 새 설정을 만들어 미로그인으로 뜨고, 계정 축이 한 칸 헛돈다.
  const named = entries
    .filter((e) => CLAUDE_ACCOUNT_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();
  const found: string[] = [];
  for (const name of named) {
    const st = await stat(join(root, name)).catch(() => null);
    if (st?.isDirectory()) found.push(name);
  }

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

/**
 * `pools.json` 의 경로. 뿌리 바로 아래다 — 풀 이름 문법(`[a-z0-9-]`)이 `.` 를 안 받으므로
 * 풀 디렉터리와 이름이 겹칠 수 없다.
 */
function poolsConfigPath(root: string): string {
  return join(root, 'pools.json');
}

/**
 * `pools.json` 을 읽는다. **없으면 `null`, 깨졌으면 빈 설정**이다.
 *
 * **이 둘을 가르는 것이 요점이다.** 파일의 **존재**가 풀 모드의 스위치이므로(spec §4-3),
 * 깨진 파일을 "없음"으로 읽으면 풀 모드였던 러너가 조용히 암묵 풀 모드로 되돌아가
 * **계정을 풀로 읽는다** — 그러면 계정이 하나도 없는 것처럼 보이거나, 더 나쁘게는 계정
 * 디렉터리 안의 무언가를 계정으로 착각한다.
 */
async function readPoolsConfig(root: string): Promise<ClaudePoolsConfig | null> {
  let text: string;
  try {
    text = await readFile(poolsConfigPath(root), 'utf8');
  } catch {
    return null; // 파일이 없다 = 암묵 풀 모드(선행 설계의 평평한 구조)
  }
  try {
    return parseClaudePoolsConfig(JSON.parse(text));
  } catch {
    // 파싱 실패. **파일은 있으므로 풀 모드는 유지한다**(위 주석). 던지지 않는 이유는
    // 이 파일을 UI 가 쓰고 사람이 손댈 수 있기 때문이다 — 던지면 러너가 안 뜨고
    // 그때 사용자는 앱에서 고칠 방법이 없다.
    console.warn(`[claudeAccounts] pools.json 을 읽을 수 없다 — 빈 설정으로 본다: ${poolsConfigPath(root)}`);
    return parseClaudePoolsConfig(undefined);
  }
}

/** 뿌리 아래 풀 이름. 판정 규율은 `loadClaudeAccounts` 와 같다(`stat` 으로 링크를 따라간다). */
async function listPoolNames(root: string): Promise<string[]> {
  return (await loadClaudeAccounts({ root })).map((p) => p.name);
}

/**
 * 한 풀 안의 계정을 페일오버 순서로.
 *
 * `order`(= `MURMUR_CLAUDE_ACCOUNTS`)가 있으면 그것에 맡긴다 — 그 경로는 없는 이름에 던지고
 * (사람이 타이핑한 의도다) 그 동작을 유지한다. 없으면 `pools.json` 의 순서를 쓴다.
 */
async function accountsIn(
  root: string, pool: string, cfg: ClaudePoolsConfig, order: string | undefined,
): Promise<ClaudeAccount[]> {
  const dir = join(root, pool);
  if (order && order.trim()) return loadClaudeAccounts({ root: dir, order });
  const found = (await loadClaudeAccounts({ root: dir })).map((a) => a.name);
  return orderAccounts(cfg, pool, found).map((name) => ({ name, configDir: join(dir, name) }));
}

/**
 * 이 러너가 쓸 계정 목록(페일오버 순서)과 그 풀 이름.
 *
 * 해석 순서(spec §5): 강제(env) → 에이전트 배정 → 기본 풀 → 암묵 풀 → 없음.
 *
 * **관용성이 갈린다**(spec §5-1):
 * - `forcedPool`(env)이 없는 풀을 가리키면 **던진다.** 사람이 방금 타이핑한 의도라, 조용히
 *   무시하면 풀 B 라고 믿고 띄운 러너가 A 로 돈다(`config.ts::validateInstance` 판례).
 * - `pools.json` 이 가리키면 **경고하고 다음 단계로 떨어진다.** UI 가 쓴 뒤 사람이 파인더에서
 *   디렉터리를 지울 수 있고, 그때 러너가 뜨지 않으면 사용자는 앱에서 고칠 방법이 없다.
 *
 * `resolvePoolName`(shared)을 쓰지 않는 이유: 그 함수는 이름 하나를 고르고, 여기는 **없는 풀을
 * 건너뛰어야** 한다. 건너뛰기를 그 반환값으로 표현할 수 없다.
 */
export async function loadClaudeAccountLane(opts: {
  root?: string;
  /** 에이전트 계정 id(UUID). handle 이 아닌 이유는 `stateDir.ts` 판단과 같다. */
  agentId: string;
  /** `MURMUR_CLAUDE_POOL`. */
  forcedPool?: string | undefined;
  /** `MURMUR_CLAUDE_ACCOUNTS`. */
  order?: string | undefined;
}): Promise<{ pool: string | null; accounts: ClaudeAccount[] }> {
  const root = opts.root ?? claudeAccountsRoot();
  const cfg = await readPoolsConfig(root);

  // 파일이 없다 = 암묵 풀. 뿌리의 하위 디렉터리가 계정이다(선행 설계 그대로).
  if (cfg === null) {
    return { pool: null, accounts: await loadClaudeAccounts({ root, order: opts.order }) };
  }

  const pools = await listPoolNames(root);

  if (opts.forcedPool) {
    if (!pools.includes(opts.forcedPool)) {
      throw new Error(
        `MURMUR_CLAUDE_POOL 이 없는 풀을 가리킨다: ${opts.forcedPool}. ` +
        `${root} 아래에 있는 풀은 ${pools.length ? pools.join(', ') : '(없음)'} 이다.`,
      );
    }
    return { pool: opts.forcedPool, accounts: await accountsIn(root, opts.forcedPool, cfg, opts.order) };
  }

  for (const [label, candidate] of [
    ['에이전트 배정', cfg.agents[opts.agentId]],
    ['기본 풀', cfg.defaultPool],
  ] as const) {
    if (!candidate) continue;
    if (!pools.includes(candidate)) {
      console.warn(`[claudeAccounts] ${label}이 없는 풀을 가리킨다 — 무시한다: ${candidate}`);
      continue;
    }
    return { pool: candidate, accounts: await accountsIn(root, candidate, cfg, opts.order) };
  }
  return { pool: null, accounts: [] };
}
