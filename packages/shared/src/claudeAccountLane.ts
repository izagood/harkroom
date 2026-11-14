// claude 계정 풀의 **해석** — 계정 뿌리, `pools.json`, 에이전트의 풀 순서(강제 → 배정 → 기본 풀 → 암묵 풀).
//
// 러너(`packages/agent/src/claudeAccounts.ts`)에서 옮겨 왔다(B4-5e). 러너가 어느 계정으로 도는지와, 오퍼레이터가
// 「이 에이전트를 Rust 러너로 돌려도 되는가」(`packages/operator/src/runnerPick.ts`)를 **같은 함수**로 판정하기 위해서다 —
// 판정을 베껴 두면 한쪽만 바뀌는 날 에이전트가 다른 계정·과금으로 조용히 돈다. 동작은 옮기기 전과 같다.
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { agentPoolChain, orderAccounts, parseClaudePoolsConfig, type ClaudePoolsConfig } from './claudePools.js';
import { claudePoolsFilePath } from './operatorRoots.js';

/**
 * 계정 이름 문법. `config.ts::INSTANCE_PATTERN` 과 **같은 값**이고 같은 이유다 — 이 이름이
 * 경로 세그먼트가 되므로 `..` 나 `/` 가 들어올 여지를 문법에서 끊는다.
 */
export const CLAUDE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ClaudeAccount {
  name: string;
  /** 이 계정의 `CLAUDE_CONFIG_DIR`. 자격증명·세션·설정이 모두 이 아래 있다. */
  configDir: string;
  /**
   * 이 계정이 든 풀(2026-10-15 풀 n개). 생략·`null` 은 뿌리(암묵 풀)다. 축이 풀 여러 개에 걸치면
   * 턴이 "어느 풀의 계정"인지 이 값으로 안다 — 같은 이름이 다른 풀에 있을 수 있다.
   */
  pool?: string | null;
}

/** 에이전트 풀 순서의 한 칸 — 디스크에 있는 풀과 그 안의 계정(페일오버 순서). */
export interface ClaudePoolLane {
  pool: string;
  accounts: ClaudeAccount[];
}

/** 계정 풀의 뿌리. `HARKROOM_CLAUDE_ACCOUNTS_DIR` 로 옮길 수 있다(테스트와 다른 볼륨용). */
export function claudeAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARKROOM_CLAUDE_ACCOUNTS_DIR ?? join(homedir(), '.harkroom-agent', 'claude-accounts');
}

/**
 * 계정 풀을 읽는다. **빈 배열은 정상이다** — 풀을 안 만든 러너는 `CLAUDE_CONFIG_DIR` 주입
 * 없이 시스템 기본(`~/.claude`)을 쓴다. 하위 호환이 그 한 줄에 걸려 있다.
 *
 * `order` 는 `HARKROOM_CLAUDE_ACCOUNTS`(쉼표 구분)다. 순서와 부분집합을 동시에 정한다.
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
      `HARKROOM_CLAUDE_ACCOUNTS 에 없는 계정이 있다: ${missing.join(', ')}. ` +
      `${root} 아래에 있는 계정은 ${found.length ? found.join(', ') : '(없음)'} 이다.`,
    );
  }
  return order.map((name) => ({ name, configDir: join(root, name) }));
}

/**
 * `pools.json` 의 경로. 뿌리 바로 아래다 — 풀 이름 문법(`[a-z0-9-]`)이 `.` 를 안 받으므로
 * 풀 디렉터리와 이름이 겹칠 수 없다.
 */
function poolsConfigPath(root: string): string {
  // 커뮤니티마다 오퍼레이터 모드면 커뮤니티 뿌리 아래다 — 오퍼레이터와 같은 함수(`@harkroom/shared/operatorRoots`).
  return claudePoolsFilePath(root, process.env);
}

/**
 * `pools.json` 을 읽는다. **없으면 `null`, 깨졌으면 빈 설정**이다.
 *
 * **이 둘을 가르는 것이 요점이다.** 파일의 **존재**가 풀 모드의 스위치이므로(spec §4-3),
 * 깨진 파일을 "없음"으로 읽으면 풀 모드였던 러너가 조용히 암묵 풀 모드로 되돌아가
 * **계정을 풀로 읽는다** — 그러면 계정이 하나도 없는 것처럼 보이거나, 더 나쁘게는 계정
 * 디렉터리 안의 무언가를 계정으로 착각한다.
 */
export async function readPoolsConfig(root: string): Promise<ClaudePoolsConfig | null> {
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
 * `order`(= `HARKROOM_CLAUDE_ACCOUNTS`)가 있으면 그것에 맡긴다 — 그 경로는 없는 이름에 던지고
 * (사람이 타이핑한 의도다) 그 동작을 유지한다. 없으면 `pools.json` 의 순서를 쓴다.
 */
async function accountsIn(
  root: string, pool: string, cfg: ClaudePoolsConfig, order: string | undefined,
): Promise<ClaudeAccount[]> {
  const dir = join(root, pool);
  if (order && order.trim()) return (await loadClaudeAccounts({ root: dir, order })).map((a) => ({ ...a, pool }));
  const found = (await loadClaudeAccounts({ root: dir })).map((a) => a.name);
  return orderAccounts(cfg, pool, found).map((name) => ({ name, configDir: join(dir, name), pool }));
}

/**
 * 이 러너가 쓸 계정 목록(페일오버 순서)과 그 풀 이름.
 *
 * 해석 순서(spec §5): 강제(env) → 에이전트 배정 → 기본 풀 → 암묵 풀 → 없음.
 *
 * **에이전트 배정은 풀 목록이다**(2026-10-15 풀 n개). 디스크에 있는 풀만 순서대로 `chain` 에
 * 담는다 — 새 스레드가 어느 풀로 갈지는 턴마다 `accountAssign.ts` 가 `chain` 에서 고른다.
 * `pool`·`accounts` 는 그 첫 칸이다(기동 로그·인터랙티브 턴·폴 신고값이 쓰는 대표값).
 * 목록의 풀이 하나도 디스크에 없으면 기본 풀로 떨어진다 — 전에 풀 하나가 없을 때와 같다.
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
  /** `HARKROOM_CLAUDE_POOL`. */
  forcedPool?: string | undefined;
  /** `HARKROOM_CLAUDE_ACCOUNTS`. */
  order?: string | undefined;
}): Promise<{ pool: string | null; accounts: ClaudeAccount[]; chain?: ClaudePoolLane[] }> {
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
        `HARKROOM_CLAUDE_POOL 이 없는 풀을 가리킨다: ${opts.forcedPool}. ` +
        `${root} 아래에 있는 풀은 ${pools.length ? pools.join(', ') : '(없음)'} 이다.`,
      );
    }
    return { pool: opts.forcedPool, accounts: await accountsIn(root, opts.forcedPool, cfg, opts.order) };
  }

  const chain: ClaudePoolLane[] = [];
  for (const candidate of agentPoolChain(cfg, opts.agentId)) {
    if (!pools.includes(candidate)) {
      console.warn(`[claudeAccounts] 에이전트 배정이 없는 풀을 가리킨다 — 건너뛴다: ${candidate}`);
      continue;
    }
    chain.push({ pool: candidate, accounts: await accountsIn(root, candidate, cfg, opts.order) });
  }
  if (chain.length) {
    // 대표값은 계정이 있는 첫 풀이다 — 빈 풀을 대표로 두면 축이 `[null]`(시스템 기본 로그인)이 된다.
    const head = chain.find((c) => c.accounts.length) ?? chain[0]!;
    return { pool: head.pool, accounts: head.accounts, chain };
  }

  if (cfg.defaultPool) {
    if (pools.includes(cfg.defaultPool)) {
      const accounts = await accountsIn(root, cfg.defaultPool, cfg, opts.order);
      return { pool: cfg.defaultPool, accounts, chain: [{ pool: cfg.defaultPool, accounts }] };
    }
    console.warn(`[claudeAccounts] 기본 풀이 없는 풀을 가리킨다 — 무시한다: ${cfg.defaultPool}`);
  }
  return { pool: null, accounts: [] };
}


/**
 * 이 에이전트의 러너가 **계정 풀로 도는가**(B4-5e) — 오퍼레이터의 러너 고르기(`runnerPick.ts`)가 쓴다.
 *
 * 판정은 러너가 실제로 계정을 고르는 함수(`loadClaudeAccountLane`) 그대로다: 강제 풀(`claudePool` → `HARKROOM_CLAUDE_POOL`)
 * → `pools.json` 의 에이전트 배정 → 기본 풀 → 암묵 풀(뿌리의 계정). 그 결과에 계정이 하나라도 있으면 `pool` 이다.
 *
 * **닫힌 쪽으로 실패한다** — 아래는 모두 `unreadable` 이고, 부르는 쪽은 그것도 「풀로 돈다」로 다룬다:
 * - `pools.json` 이 있는데 읽거나 해석하지 못한다(러너는 깨진 파일을 빈 설정으로 읽어 계정 0 으로 보일 수 있다).
 * - 계정 뿌리가 있는데 읽지 못한다(러너는 그것을 「계정 없음」으로 읽는다).
 * - 해석이 던진다(없는 강제 풀 등 — 러너도 그때 뜨지 않는다).
 */
export async function claudeAccountUse(opts: {
  agentId: string;
  /** operator.json 의 `claudePool`(러너에게는 `HARKROOM_CLAUDE_POOL` 로 간다). */
  forcedPool?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<'none' | 'pool' | 'unreadable'> {
  const env = opts.env ?? process.env;
  const root = claudeAccountsRoot(env);
  try {
    await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'unreadable';
  }
  let path: string;
  try {
    path = claudePoolsFilePath(root, env);
  } catch {
    return 'unreadable';
  }
  try {
    parseClaudePoolsConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 'unreadable';
  }
  try {
    const lane = await loadClaudeAccountLane({ root, agentId: opts.agentId, forcedPool: opts.forcedPool, order: env.HARKROOM_CLAUDE_ACCOUNTS });
    const any = lane.accounts.length > 0 || (lane.chain ?? []).some((c) => c.accounts.length > 0);
    return any ? 'pool' : 'none';
  } catch {
    return 'unreadable';
  }
}
