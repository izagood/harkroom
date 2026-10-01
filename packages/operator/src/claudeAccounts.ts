// claude 계정 풀의 **파일시스템 연산**. 데몬이 이것을 소유하는 이유는 웹뷰가 소유할 수
// 없기 때문이다.
//
// ## 왜 데몬인가 — 웹뷰에는 로컬을 다룰 표면이 없다
//
// 그것이 **의도된 상태**다: `capabilities/default.json` 에 `shell:allow-execute` 도 fs 권한도
// 없고, `runnerShellScope.test.ts` 가 *"웹뷰에서 프로그램을 실행할 수 있는 표면이 이제 아예
// 없다"* 를 회귀선으로 들고 있다(`#513` 이 `plugin-shell` 의 `Command.create` 를 지웠다).
//
// 그래서 이 기능은 그 문을 열지 않는다. 데몬은 **이미** 로컬 프로세스를 소유하는 경계이고
// (러너를 띄우는 것이 앱이 아니라 데몬이다), 웹뷰는 프로그램 경로도 인자도 넘기지 않고
// `^[a-z0-9-]{1,32}$` **이름만** 넘긴다.
//
// ## 왜 이 파일이 `pools.json` 을 쓰는 것이 프로토콜 규칙을 어기지 않는가
//
// `daemonProtocol.ts` 머리 주석은 *"daemon 이 소유하는 것은 프로세스이지 세션이 아니다"* 라고
// 못박았고, 그 **근거는 단일 writer** 다 — `sessions.json` 의 writer 는 러너이고 데몬이 두 번째
// writer 가 되면 lost update 가 조용히 난다.
//
// `pools.json` 은 그 조건에 걸리지 않는다: **writer 가 데몬 하나뿐이고 러너는 읽기만 한다.**
// 그 불변식이 이 설계의 전제이므로, 러너에 쓰기를 넣는 변경은 여기까지 되돌아와야 한다.
//
// ## 왜 `runStatus` 를 주입받는가
//
// 로그인 상태 판정은 실제 `claude auth status --json` 을 돌려야 한다. 테스트가 그것을 부르면
// 그 머신의 로그인 상태에 달리고 CI 에는 로그인이 없다 — 그러면 "미로그인" 경로만 초록이
// 된다. 구조를 읽고 쓰는 일은 상태와 무관하므로 그 경계를 갈라 둔다.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CLAUDE_POOL_NAME_PATTERN,
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from '@harkroom/shared/claudePools';
import {
  CLAUDE_ATTENTION_FILE,
  clearAccountAttention,
  isAttentionFresh,
  markClaudeAccountGates,
  markClaudeWorkspaceTrusted,
  readAccountAttention,
} from '@harkroom/shared/claudeGates';
import type { ProviderAccountUsage, ProviderUsageSnapshot } from '@harkroom/shared/daemonProtocol';

import { claudeCliUsage, type RunCommand } from './cliUsage.js';
import { fetchClaudeProviderUsage, type ClaudeOAuthToken, type FetchLike } from './providerUsage.js';
import { cliThenApi, createUsageCache } from './usageChain.js';

/**
 * `claude auth status --json` 이 주는 것 중 **UI 가 쓰는 것만**. 비밀값은 이 출력에 없다
 * (실측) — 그래서 그대로 소켓에 실어도 된다.
 *
 * `loggedIn` 외에 전부 옵셔널인 이유: 미로그인이면 정체 필드가 아예 없다(실측).
 */
export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  orgName?: string;
  /**
   * `oauthAccount.organizationUuid`·`accountUuid`. **식별자이지 비밀값이 아니다.** 화면이 "같은
   * 풀에 같은 로그인이 둘"을 알아보는 데 쓴다 — 이메일·팀명은 표시용이라 비교 키로 약하다
   * (재인증 직후 `organizationName` 이 빠진 `.claude.json` 을 실측했다, 2026-09-29).
   */
  orgId?: string;
  accountId?: string;
  subscriptionType?: string;
  authMethod?: string;
}

export interface ClaudeAccountView {
  name: string;
  status: ClaudeAuthStatus;
  /**
   * **사람이 관문을 지나야 한다**(2026-10-01). 러너가 이 계정의 턴을 관문 화면에서 넘긴 시각.
   * 유효할 때만 싣는다(`CLAUDE_ATTENTION_TTL_MS`). 화면은 "승인 필요"와 [터미널 열기]를 보인다.
   */
  attention?: { atMs: number };
}

export interface ClaudePoolView {
  name: string;
  accounts: ClaudeAccountView[];
}

export interface ClaudeAccountsSnapshot {
  root: string;
  /**
   * `flat` = `pools.json` 이 없다(선행 설계의 평평한 구조). 그때 `pools` 는 이름 없는 풀 하나다.
   * `pools` = 파일이 있다. **파일의 존재가 스위치이고 디렉터리 모양을 추측하지 않는다.**
   */
  mode: 'flat' | 'pools';
  defaultPool: string | null;
  agents: Record<string, string>;
  /** 풀별 배정 기준(C ③). 빈 칸은 `DEFAULT_ASSIGN_THRESHOLDS`. */
  assign: NonNullable<ClaudePoolsConfig['assign']>;
  pools: ClaudePoolView[];
  /**
   * 풀 모드인데 뿌리에 남아 있는 **평평한 계정**. 사용자가 풀을 만든 순간 이것들은 계정
   * 목록에서 사라진다 — 조용히 사라지면 "계정이 없어졌다"가 되므로 따로 보고해 UI 가
   * 이전을 안내할 수 있게 한다. `flat` 모드에서는 항상 비어 있다(그때는 그것들이 계정이다).
   */
  strays: string[];
}

/**
 * 로그인 자식 프로세스의 **우리가 쓰는 표면만**. `ChildProcess` 전체를 요구하지 않는 이유는
 * 테스트가 가짜를 끼우기 위해서다 — 실제 `claude auth login` 은 브라우저 OAuth 를 시작하고
 * 사람을 기다리므로 테스트가 띄울 수 없다.
 */
export interface ClaudeLoginChild {
  stdout: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  stdin: { write(s: string): unknown } | null;
  on(ev: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * 로그인 진행 통지. 데몬이 소켓 이벤트로 흘리고 앱이 화면에 그린다.
 *
 * **원시 바이트를 흘리지 않는다.** `claude auth login` 의 출력은 OSC 8 하이퍼링크로 감싸여
 * URL 이 두 번 나온다(실측) — 프론트가 그 파싱을 하면 하이퍼링크 규격을 프론트가 알아야 한다.
 * 파싱은 한 곳에서 한다.
 */
export interface ClaudeLoginEvent {
  loginId: string;
  /** OAuth URL. 한 번만 온다. */
  url?: string;
  /** 끝났다. 성공·실패 모두 온다 — 통지가 없으면 UI 가 영원히 "로그인 중"을 그린다. */
  done?: boolean;
  /** 끝난 뒤 다시 잰 상태. `done` 과 함께 온다. */
  status?: ClaudeAuthStatus;
  /** 실패 사유(사람이 읽는 덧말). `done` 과 함께 온다. */
  error?: string;
}

export interface ClaudeAccountsPort {
  list(): Promise<ClaudeAccountsSnapshot>;
  configure(cfg: ClaudePoolsConfig): Promise<void>;
  removeAccount(pool: string, account: string): Promise<void>;
  removePool(pool: string): Promise<void>;
  move(account: string, toPool: string): Promise<{ loggedIn: boolean }>;
  /**
   * `reauth` = **이미 있는 계정**에 다시 로그인한다(이름·풀·순서·세션은 그대로, 인증만 바뀐다).
   * 디렉터리가 없으면 거절한다 — 새로 만들면 지운 계정이 되살아난다(2026-09-29).
   */
  loginStart(pool: string, account: string, opts?: { reauth?: boolean }): Promise<{ loginId: string }>;
  loginSubmit(loginId: string, code: string): Promise<void>;
  loginCancel(loginId: string): Promise<void>;
  /**
   * 계정별 한도 사용률. CLI(`claude -p /usage`) 먼저, 실패하면 API(`/api/oauth/usage`) — 출처는 같다
   * (`usageChain.ts`). 계정끼리 **병렬로** 묻는다 — 하나가 느려도 나머지를 기다리게 하지 않는다.
   */
  providerUsage(): Promise<ProviderUsageSnapshot>;
  /**
   * 계정 **하나**의 사용률(`CLAUDE_CONFIG_DIR` 로 가리킨다). 사용량 폴러(`claudeUsagePoller.ts`)가
   * 쓴다. `providerUsage()` 와 **같은 캐시**를 지난다 — 화면과 폴러가 같은 계정을 따로 재면
   * `claude` 프로세스가 두 번 뜬다.
   */
  measureUsage(configDir: string): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>>;
  /**
   * 그 계정의 `CLAUDE_CONFIG_DIR` 로 **사람에게** Terminal.app 의 `claude` 를 연다(2026-10-01).
   * 러너가 넘긴 관문(조직 관리 설정 승인 등)을 사람이 직접 고르게 하는 자리다 — 우리는 아무것도
   * 누르지 않는다. 그 세션이 끝나면 스크립트가 관문 표식을 지워 다시 배정 후보가 된다.
   */
  openTerminal(pool: string, account: string): Promise<void>;
  /** 진행 중인 로그인을 전부 회수한다. 데몬 종료 경로가 부른다. */
  shutdownLogins(): Promise<void>;
  onLoginEvent(cb: (e: ClaudeLoginEvent) => void): void;
}

/** 계정 풀 뿌리. 러너의 `claudeAccountsRoot()` 와 **같은 값**이어야 한다. */
export function claudeAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARKROOM_CLAUDE_ACCOUNTS_DIR ?? join(homedir(), '.harkroom-agent', 'claude-accounts');
}

/**
 * 이름을 재고 뿌리 아래 경로를 조립한다. **방어가 두 겹인 것이 의도다**: 문법이 이미
 * `..` 와 `/` 를 막지만, 이 경로로 `rm -rf` 가 돌아간다 — 조립한 결과가 실제로 뿌리 아래인지
 * `resolve` 로 다시 확인한다.
 */
function under(root: string, ...names: string[]): string {
  for (const n of names) {
    if (!CLAUDE_POOL_NAME_PATTERN.test(n)) {
      throw new Error(`이름이 문법에 맞지 않는다: ${JSON.stringify(n)} (${CLAUDE_POOL_NAME_PATTERN})`);
    }
  }
  const target = resolve(root, ...names);
  const base = resolve(root);
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`뿌리 밖의 경로다: ${target}`);
  }
  return target;
}

function poolsConfigPath(root: string): string {
  return join(root, 'pools.json');
}

/** 하위 디렉터리 이름(사전순). 심볼릭 링크를 따라간다 — 러너의 판정과 같은 규율. */
async function subdirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // 없다 = 비었다. 정상 경로다.
  }
  const named = entries.filter((e) => CLAUDE_POOL_NAME_PATTERN.test(e.name)).map((e) => e.name).sort();
  const out: string[] = [];
  for (const name of named) {
    // `Dirent.isDirectory()` 는 심볼릭 링크에 거짓이다 — `stat` 으로 따라간다.
    const st = await stat(join(dir, name)).catch(() => null);
    if (st?.isDirectory()) out.push(name);
  }
  return out;
}

/** 이 디렉터리가 **계정이었던 것**인가. 관측 가능한 표식은 이 두 파일뿐이다. */
async function looksLikeAccount(dir: string): Promise<boolean> {
  for (const f of ['.credentials.json', '.claude.json']) {
    if (await stat(join(dir, f)).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * 이 config 디렉터리의 자격증명이 사는 Keychain 서비스 이름.
 *
 * claude 가 쓰는 규칙(실측): `Claude Code-credentials-<sha256(configDir) 앞 8자>`.
 */
function keychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

/**
 * 이 계정의 자격증명이 Keychain 에 있는가. **값을 읽지 않는다** — 존재만 본다.
 *
 * `-w`(값 출력)를 안 붙이는 것이 요점이다: 존재 판정에 토큰을 읽을 이유가 없고, 읽으면
 * 그 바이트가 이 프로세스의 메모리와 파이프를 지난다.
 */
function nodeHasKeychainCredentials(configDir: string): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((res) => {
    execFile(
      'security',
      ['find-generic-password', '-s', keychainService(configDir), '-a', process.env.USER ?? ''],
      { timeout: 10_000 },
      (err) => res(err === null),
    );
  });
}

/**
 * 이 계정의 Keychain 자격증명을 지운다. **값을 읽지 않는다** — 항목을 없애기만 한다.
 *
 * 계정을 지울 때 디렉터리만 지우면 Keychain 항목이 남는다(서비스 이름이 경로의 해시라서).
 * 그러면 같은 경로에 디렉터리가 **다시 생기는 순간 옛 로그인이 되살아난다** — 2026-09-29
 * 실측: 지운 `work/lime` 을 기동 때 목록을 읽은 러너가 계속 `CLAUDE_CONFIG_DIR` 로 넘겨
 * claude 가 디렉터리를 다시 만들었고, 남은 Keychain 항목 때문에 로그인된 계정으로 보였다.
 *
 * 항목이 없으면(`security` 가 44 로 끝난다) 성공으로 본다 — 지우려던 상태가 이미 그렇다.
 * 서버 쪽 토큰 폐기(`claude auth logout`)는 하지 않는다: 같은 로그인을 다른 계정 디렉터리가
 * 함께 쓸 수 있고, 여기서 할 일은 **이 기계에 남은 흔적**을 치우는 것이다.
 */
function nodeDeleteKeychainCredentials(configDir: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((res) => {
    execFile(
      'security',
      ['delete-generic-password', '-s', keychainService(configDir), '-a', process.env.USER ?? ''],
      { timeout: 10_000 },
      // 실패해도 계정 삭제를 막지 않는다 — Keychain 이 잠겨 있어도 디렉터리는 지워져야 하고,
      // 러너는 없는 디렉터리를 이제 건너뛴다(agent `presentAccounts`).
      () => res(),
    );
  });
}

/**
 * 계정의 로그인 상태·정체를 **디스크에서** 읽는다.
 *
 * ## `claude auth status --json` 을 쓰지 않는 이유 — 2026-09-08 실측
 *
 * 그 명령은 **Keychain 에 있는 자격증명을 못 본다.** 사용자가 앱에서 계정 넷을 등록한 뒤:
 *
 * | 관측 | 결과 |
 * |---|---|
 * | `claude auth status --json` (넷 전부) | `loggedIn: false` |
 * | Keychain `Claude Code-credentials-<sha8>` | 네 항목 모두 존재, 토큰 완전 |
 * | `claude -p` 로 실제 턴 | 넷 다 `OK`, rc=0 |
 *
 * 런타임은 Keychain 을 읽고 `auth status` 는 파일만 읽는다. 앞선 실측(2026-09-07)이 이것을
 * 놓친 이유: 심볼릭 링크 실험은 **파일이 있는** 경우였고 "Keychain 만 있는" 경우를 안 쟀다.
 * 그 결과 설정 화면이 멀쩡한 계정 넷을 전부 "Not signed in" 으로 그렸다.
 *
 * ## 무엇을 읽는가
 *
 * - **정체**: `<configDir>/.claude.json` 의 `oauthAccount`. **비밀값이 아니다.** 미로그인
 *   디렉터리에는 이 키가 **없다**(실측) — 존재 자체가 "이 디렉터리로 로그인한 적이 있다"다.
 * - **자격증명**: 파일 또는 Keychain 항목의 **존재**. 토큰을 읽지 않는다.
 *
 * 부수 효과로 `claude`(Node 앱) 프로세스를 계정마다 하나씩 안 띄운다.
 *
 * ## 한계를 알고 쓴다
 *
 * "자격증명이 있다"는 "토큰이 아직 유효하다"가 **아니다.** refresh 토큰이 만료된 계정도
 * 여기서는 로그인으로 보인다 — 그 사실은 턴을 돌려 봐야 안다. 그래서 러너가 턴 시각에
 * 발견하고 다음 계정으로 넘어간다(`switchesAccount` 가 `oauthsessionexpired` 를 잡는다).
 * 화면이 그 판정을 흉내내려고 토큰을 읽지는 않는다.
 */
export async function accountStatusFromDisk(
  configDir: string,
  hasKeychain: (configDir: string) => Promise<boolean> = nodeHasKeychainCredentials,
): Promise<ClaudeAuthStatus> {
  const oauth = await readOauthAccount(configDir);
  if (!oauth) return { loggedIn: false };

  const hasFile = await stat(join(configDir, '.credentials.json')).then(() => true, () => false);
  // Keychain 조회가 던져도 파일 판정으로 떨어진다 — `security` 가 없거나 권한이 거부된
  // 환경에서 목록 전체가 죽지 않아야 한다.
  const inKeychain = hasFile ? false : await hasKeychain(configDir).catch(() => false);
  if (!hasFile && !inKeychain) return { loggedIn: false };

  const pick = (k: string): string | undefined =>
    (typeof oauth[k] === 'string' ? (oauth[k] as string) : undefined);
  return {
    loggedIn: true,
    ...(pick('emailAddress') !== undefined ? { email: pick('emailAddress')! } : {}),
    ...(pick('organizationName') !== undefined ? { orgName: pick('organizationName')! } : {}),
    ...(pick('organizationUuid') !== undefined ? { orgId: pick('organizationUuid')! } : {}),
    ...(pick('accountUuid') !== undefined ? { accountId: pick('accountUuid')! } : {}),
  };
}

/** `.claude.json` 의 `oauthAccount`. 없거나 깨졌으면 `null` — **던지지 않는다**. */
async function readOauthAccount(configDir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null) {
      const oa = (raw as Record<string, unknown>).oauthAccount;
      if (typeof oa === 'object' && oa !== null) return oa as Record<string, unknown>;
    }
  } catch {
    // 없거나 깨졌다. 목록 하나가 못 읽혀 화면 전체가 실패하면 사용자는 자기 계정이
    // 사라진 줄 안다.
  }
  return null;
}

/**
 * "같은 로그인인가"의 비교 키(`usage.json` 의 `signIn`). uuid 둘(조직·계정)의 sha256 앞 16자다.
 *
 * 비교 키는 desktop `sameSignInAs` 와 같은 둘이다. **해시로 싣는 이유**: 이 값은 파일에 남고
 * 러너가 읽는다 — 비교만 하면 되므로 식별자 원문을 퍼뜨릴 까닭이 없다. 못 읽으면 `null`.
 */
export async function readSignInKey(configDir: string): Promise<string | null> {
  const oauth = await readOauthAccount(configDir);
  const org = oauth?.organizationUuid;
  const acct = oauth?.accountUuid;
  if (typeof org !== 'string' || typeof acct !== 'string' || !org || !acct) return null;
  return createHash('sha256').update(`${org}:${acct}`).digest('hex').slice(0, 16);
}

/**
 * 기본 `runStatus`. 위 `accountStatusFromDisk` 를 그대로 쓴다 — 주입 지점의 이름이
 * `runStatus` 인 것은 앞 판본이 `claude` 를 **돌렸기** 때문이고 이제 돌리지 않는다.
 * 이름을 그대로 둔 이유: 테스트가 이미 그 이름으로 주입하고 있고, 이름 변경은 이 결함
 * 수정의 범위가 아니다.
 */
function nodeRunStatus(configDir: string): Promise<unknown> {
  return accountStatusFromDisk(configDir);
}

function readStatus(raw: unknown): ClaudeAuthStatus {
  if (typeof raw !== 'object' || raw === null) return { loggedIn: false };
  const r = raw as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  return {
    loggedIn: r.loggedIn === true,
    ...(pick('email') !== undefined ? { email: pick('email')! } : {}),
    ...(pick('orgName') !== undefined ? { orgName: pick('orgName')! } : {}),
    ...(pick('orgId') !== undefined ? { orgId: pick('orgId')! } : {}),
    ...(pick('accountId') !== undefined ? { accountId: pick('accountId')! } : {}),
    ...(pick('subscriptionType') !== undefined ? { subscriptionType: pick('subscriptionType')! } : {}),
    ...(pick('authMethod') !== undefined ? { authMethod: pick('authMethod')! } : {}),
  };
}

/** SIGTERM → SIGKILL 유예. 러너 회수와 같은 이유로 먼저 부탁한다. */
const LOGIN_KILL_GRACE_MS = 5_000;

/** 기본 `spawnLogin` — 실제 `claude auth login` 을 그 계정 디렉터리로 띄운다. */
function nodeSpawnLogin(configDir: string): ClaudeLoginChild {
  // **PTY 가 아니라 파이프다.** 실측(claude 2.1.263): 파이프에서도 URL 을 찍고 stdin 에서
  // 코드를 읽는다. PTY 를 쓰면 데몬이 node-pty 를 물게 되고 얻는 것이 없다.
  return spawn('claude', ['auth', 'login', '--claudeai'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as ClaudeLoginChild;
}

/**
 * `pools.json`. **없음(`null`)과 깨짐(빈 설정)을 가른다** — 존재가 모드 스위치다.
 */
async function readPoolsConfig(root: string): Promise<ClaudePoolsConfig | null> {
  let text: string;
  try {
    text = await readFile(poolsConfigPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    return parseClaudePoolsConfig(JSON.parse(text));
  } catch {
    return parseClaudePoolsConfig(undefined);
  }
}

/**
 * `pools.json` 을 원자적으로 쓴다. 유일한 임시 이름을 쓰는 이유는 `sessions.json` 과 같다 —
 * 고정 이름이면 먼저 끝난 rename 이 tmp 를 치워 나중 rename 이 ENOENT 로 죽는다.
 */
async function writePoolsConfig(root: string, cfg: ClaudePoolsConfig): Promise<void> {
  const tmpPath = `${poolsConfigPath(root)}.tmp-${randomUUID()}`;
  // 빈 `assign` 은 쓰지 않는다 — 선택 칸이라 없음과 `{}` 가 같은 뜻이고, 파일을 옛 모양 그대로 둔다.
  const { assign, ...rest } = cfg;
  const out = assign && Object.keys(assign).length ? { ...rest, assign } : rest;
  await writeFile(tmpPath, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, poolsConfigPath(root));
}

/** 뿌리 아래 계정 하나가 실제로 어디 있는가. */
export interface ClaudeAccountDir {
  name: string;
  /** `CLAUDE_CONFIG_DIR` 로 쓰이는 그 경로. */
  dir: string;
}

/**
 * **디스크의 모양 그대로** — 상태를 재지 않는다.
 *
 * `list()` 와 `providerUsage()` 가 이것을 공유한다. 갈라 둔 이유는 `list()` 가 계정마다
 * `claude auth status` 를 돌리는데(느리고 실패할 수 있다) 사용량은 그것이 필요 없기
 * 때문이고, 합쳐 둔 이유는 **열거가 한 벌이어야** 하기 때문이다 — 두 벌이면 목록에는
 * 보이는데 사용량에는 없는 계정이 생긴다.
 */
export interface ClaudeAccountsLayout {
  root: string;
  mode: 'flat' | 'pools';
  defaultPool: string | null;
  agents: Record<string, string>;
  /** 풀별 배정 기준(`pools.json` 의 `assign`). 평평한 구조면 비어 있다. */
  assign: NonNullable<ClaudePoolsConfig['assign']>;
  strays: string[];
  /** 계정이 **없는 풀도 들어 있다** — 빈 풀을 화면에서 지우면 방금 만든 풀이 사라진다. */
  pools: { name: string; accounts: ClaudeAccountDir[] }[];
}

export async function readClaudeAccountsLayout(root: string): Promise<ClaudeAccountsLayout> {
  const dirsOf = async (parent: string): Promise<ClaudeAccountDir[]> =>
    (await subdirs(parent)).map((name) => ({ name, dir: join(parent, name) }));

  const cfg = await readPoolsConfig(root);
  if (cfg === null) {
    // 평평한 구조. 뿌리의 하위 디렉터리가 계정이고, 이름 없는 풀 하나로 보여 준다.
    const accounts = await dirsOf(root);
    return {
      root, mode: 'flat', defaultPool: null, agents: {}, assign: {},
      pools: accounts.length ? [{ name: '', accounts }] : [],
      strays: [],
    };
  }

  const pools: ClaudeAccountsLayout['pools'] = [];
  const strays: string[] = [];
  for (const name of await subdirs(root)) {
    const dir = join(root, name);
    // 풀 모드에서 **계정 모양인 뿌리 하위 디렉터리는 풀이 아니라 잔여물**이다.
    // 그것을 풀로 세면 UI 가 "계정 0개인 이상한 풀"을 그리고, 사용자는 자기 계정이
    // 어디 갔는지 알 수 없다.
    if (await looksLikeAccount(dir)) { strays.push(name); continue; }
    pools.push({ name, accounts: await dirsOf(dir) });
  }
  return {
    root, mode: 'pools', defaultPool: cfg.defaultPool, agents: cfg.agents, assign: cfg.assign ?? {}, pools, strays,
  };
}

/** 셸 단일따옴표 인용. 경로에 `'` 가 들어 있어도 깨지지 않는다. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 사람에게 여는 터미널의 스크립트. **경로는 우리가 조립한 값뿐이다**(`under` 로 잰 계정 디렉터리) —
 * 웹뷰가 넘긴 문자열이 셸에 들어가지 않는다. `claude` 가 끝나면 관문 표식을 지운다: 사람이 그
 * 화면을 지났든 아니든 다음 턴이 다시 재 보고, 아직 막혀 있으면 러너가 표식을 다시 세운다.
 */
export function terminalScript(o: { configDir: string; workDir: string; label: string }): string {
  return [
    '#!/bin/zsh -l',
    `cd ${shQuote(o.workDir)} || exit 1`,
    `export CLAUDE_CONFIG_DIR=${shQuote(o.configDir)}`,
    `echo ${shQuote(`harkroom: ${o.label} 계정의 Claude Code 다. 뜨는 화면을 직접 고르고, 끝나면 /exit 로 나온다.`)}`,
    'claude',
    `rm -f ${shQuote(join(o.configDir, CLAUDE_ATTENTION_FILE))}`,
    `echo ${shQuote('harkroom: 끝났다. 이 창은 닫아도 된다 — 다음 턴부터 이 계정을 다시 쓴다.')}`,
    '',
  ].join('\n');
}

/** macOS: `.command` 파일은 `open -a Terminal` 로 연다 — AppleScript 권한(자동화 승인)이 필요 없다. */
function nodeOpenInTerminal(scriptPath: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    execFile('open', ['-a', 'Terminal', scriptPath], (err) => (err ? rejectP(err) : resolveP()));
  });
}

export function createClaudeAccountsPort(opts: {
  root?: string;
  runStatus?: (configDir: string) => Promise<unknown>;
  spawnLogin?: (configDir: string) => ClaudeLoginChild;
  killGraceMs?: number;
  /** 사용량 창의 기준 시각. 테스트가 고정한다 — 5시간 창은 시계에 달린 판정이다. */
  now?: () => number;
  /** 공급자 API 호출. 테스트가 가짜를 끼운다 — CI 에는 로그인도 네트워크도 없다. */
  fetchImpl?: FetchLike;
  readToken?: (configDir: string) => Promise<ClaudeOAuthToken | null>;
  /** 공식 경로(`claude -p /usage`)의 실행기. 테스트가 가짜를 끼운다. */
  runCli?: RunCommand;
  usageCacheMs?: number;
  /** Keychain 항목 삭제. 테스트가 가짜를 끼운다 — 진짜 Keychain 을 건드리지 않게. */
  deleteKeychain?: (configDir: string) => Promise<void>;
  /**
   * 로그인이 **성공으로** 끝났다(`CLAUDE_CONFIG_DIR`). 사용량 폴러가 그 계정을 곧바로 다시 재게
   * 한다 — 다시 로그인한 계정의 `usage.json` 값은 옛 로그인의 것이라, 러너가 그것으로 점수를 매긴다.
   */
  onSignedIn?: (configDir: string) => void;
  /** `.command` 파일을 Terminal.app 으로 연다. 테스트가 가짜를 끼운다 — 진짜 창을 띄우지 않게. */
  openInTerminal?: (scriptPath: string) => Promise<void>;
} = {}): ClaudeAccountsPort {
  const root = opts.root ?? claudeAccountsRoot();
  const runStatus = opts.runStatus ?? nodeRunStatus;
  const spawnLogin = opts.spawnLogin ?? nodeSpawnLogin;
  const killGraceMs = opts.killGraceMs ?? LOGIN_KILL_GRACE_MS;
  const now = opts.now ?? ((): number => Date.now());
  const deleteKeychain = opts.deleteKeychain ?? nodeDeleteKeychainCredentials;
  const usageCache = createUsageCache(opts.usageCacheMs, now);

  /** 진행 중인 로그인. 키는 `loginId`. */
  const logins = new Map<string, {
    child: ClaudeLoginChild;
    configDir: string;
    /** `<pool>/<account>` — 같은 계정에 둘이 붙는 것을 막는 키다. */
    slot: string;
    /** 이 로그인이 디렉터리를 **새로 만들었는가**. 실패로 끝나면 그때만 치운다. */
    created: boolean;
    settled: boolean;
    urlSent: boolean;
    buffer: string;
    killTimer: ReturnType<typeof setTimeout> | null;
  }>();
  const loginListeners: ((e: ClaudeLoginEvent) => void)[] = [];
  const emit = (e: ClaudeLoginEvent): void => {
    // 관찰 하나가 로그인을 죽이지 않는다 — 듣는 쪽이 던져도 삼킨다.
    for (const cb of loginListeners) { try { cb(e); } catch { /* 관찰은 부작용이 아니다 */ } }
  };

  const measureUsage = (dir: string, at: number, stale = false): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> =>
    usageCache(dir, () => cliThenApi(
      () => claudeCliUsage({ configDir: dir, now: at, ...(opts.runCli ? { run: opts.runCli } : {}) }),
      () => fetchClaudeProviderUsage({
        configDir: dir, now: at,
        fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
        ...(opts.readToken ? { readToken: opts.readToken } : {}),
      }),
    ), { stale });

  return {
    async list(): Promise<ClaudeAccountsSnapshot> {
      const layout = await readClaudeAccountsLayout(root);
      const pools: ClaudePoolView[] = [];
      for (const p of layout.pools) {
        const accounts: ClaudeAccountView[] = [];
        for (const a of p.accounts) {
          const attention = await readAccountAttention(a.dir).catch(() => null);
          accounts.push({
            name: a.name,
            status: readStatus(await runStatus(a.dir)),
            ...(attention && isAttentionFresh(attention, now()) ? { attention: { atMs: attention.atMs } } : {}),
          });
        }
        pools.push({ name: p.name, accounts });
      }
      return {
        root: layout.root,
        mode: layout.mode,
        defaultPool: layout.defaultPool,
        agents: layout.agents,
        assign: layout.assign,
        pools,
        strays: layout.strays,
      };
    },

    async providerUsage(): Promise<ProviderUsageSnapshot> {
      const layout = await readClaudeAccountsLayout(root);
      const at = now();
      const targets = layout.pools.flatMap((p) => p.accounts.map((a) => ({ pool: p.name, ...a })));
      const accounts = await Promise.all(targets.map(async (t) => ({
        account: t.name,
        pool: t.pool,
        // 화면 경로 — 지난 값을 곧바로 돌려주고 뒤에서 다시 잰다(`createUsageCache` 의 `stale`).
        ...(await measureUsage(t.dir, at, true)),
      })));
      return { measuredAtMs: at, accounts };
    },

    measureUsage(configDir: string) {
      return measureUsage(configDir, now());
    },

    async configure(cfg: ClaudePoolsConfig): Promise<void> {
      // **정규화에서 이름이 떨어져 나가면 던진다.** 조용히 버리면 UI 가 쓴 것과 디스크가
      // 갈리고, 사용자는 "설정했는데 안 먹었다"를 보게 된다(spec §6-2 — 웹뷰를 신뢰하지 않는다).
      const norm = parseClaudePoolsConfig(cfg);
      // 배정 기준(C ③)을 **모르는 호출자**(옛 UI)가 순서만 바꿔 쓸 때 기준이 지워지면 안 된다 —
      // 칸이 없으면 디스크에 있던 것을 그대로 둔다. 비우려면 `assign: {}` 를 보낸다.
      if (cfg.assign === undefined) norm.assign = (await readPoolsConfig(root))?.assign ?? {};
      if (norm.defaultPool !== (cfg.defaultPool ?? null)) {
        throw new Error(`defaultPool 이 문법에 맞지 않는다: ${JSON.stringify(cfg.defaultPool)}`);
      }
      if (Object.keys(norm.order).length !== Object.keys(cfg.order ?? {}).length) {
        throw new Error('order 에 문법에 맞지 않는 풀 이름이 있다');
      }
      for (const [pool, list] of Object.entries(cfg.order ?? {})) {
        if ((norm.order[pool] ?? []).length !== list.length) {
          throw new Error(`order[${pool}] 에 문법에 맞지 않는 계정 이름이 있다`);
        }
      }
      if (Object.keys(norm.agents).length !== Object.keys(cfg.agents ?? {}).length) {
        throw new Error('agents 에 문법에 맞지 않는 풀 이름이 있다');
      }

      await mkdir(root, { recursive: true, mode: 0o700 });
      // **설정에 이름이 나타나면 그 풀이 생긴다** — 별도 createPool 을 두지 않는다.
      for (const name of new Set([
        ...(norm.defaultPool ? [norm.defaultPool] : []),
        ...Object.keys(norm.order),
        ...Object.values(norm.agents),
      ])) {
        await mkdir(under(root, name), { recursive: true, mode: 0o700 });
      }

      await writePoolsConfig(root, norm);
    },

    async openTerminal(pool: string, account: string): Promise<void> {
      const dir = under(root, pool, account);
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`계정이 없다: ${pool}/${account}`);
      }
      // 작업 폴더는 harkroom 이 만든 빈 폴더다. 뿌리의 점 디렉터리라 풀·계정 문법에 안 걸린다
      // (`[a-z0-9-]`). 그 계정이 이 폴더를 이미 신뢰했다고 적어 둔다 — 폴더 신뢰 화면이 먼저 뜨면
      // 사람이 고쳐야 할 관문이 그 뒤에 가린다. 첫 실행 화면도 같은 이유로 미리 지난다.
      const workDir = join(root, '.terminal');
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await markClaudeAccountGates(dir).catch(() => undefined);
      await markClaudeWorkspaceTrusted(dir, workDir).catch(() => undefined);
      const script = join(workDir, `${pool}-${account}.command`);
      await writeFile(script, terminalScript({ configDir: dir, workDir, label: `${pool}/${account}` }), { mode: 0o700 });
      await (opts.openInTerminal ?? nodeOpenInTerminal)(script);
    },

    async removeAccount(pool: string, account: string): Promise<void> {
      const dir = under(root, pool, account);
      // **없는 것을 지우려 하면 거절한다.** 조용히 성공하면 UI 가 "지웠다"를 그리는데
      // 실제로는 다른 것이 남아 있을 수 있다.
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`계정이 없다: ${pool}/${account}`);
      }
      await rm(dir, { recursive: true, force: true });
      // 사용량 캐시도 그 디렉터리의 값이다 — 같은 이름으로 다시 붙인 계정에 옛 로그인의 % 가 나가지 않게 버린다.
      usageCache.forget(dir);
      // 디렉터리만 지우면 두 흔적이 남아 지운 계정이 되살아난다(2026-09-29):
      // Keychain 항목(같은 경로에 디렉터리가 다시 생기면 로그인된 채로 보인다)과
      // `order` 의 이름(같은 이름을 다시 만들면 옛 순서 자리로 돌아간다).
      await deleteKeychain(dir);
      const cfg = await readPoolsConfig(root);
      const list = cfg?.order[pool];
      if (cfg && list?.includes(account)) {
        await writePoolsConfig(root, { ...cfg, order: { ...cfg.order, [pool]: list.filter((n) => n !== account) } });
      }
    },

    async removePool(pool: string): Promise<void> {
      const dir = under(root, pool);
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`풀이 없다: ${pool}`);
      }
      await rm(dir, { recursive: true, force: true });
      usageCache.forgetUnder(dir);
    },

    async move(account: string, toPool: string): Promise<{ loggedIn: boolean }> {
      const from = under(root, account);
      const poolDir = under(root, toPool);
      const to = under(root, toPool, account);
      if (!(await stat(from).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`옮길 계정이 없다: ${account}`);
      }
      if (!(await stat(poolDir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`대상 풀이 없다: ${toPool}`);
      }
      // **덮어쓰지 않는다.** `rename` 은 대상이 빈 디렉터리면 성공할 수 있어, 그 판정을
      // 우리가 먼저 한다 — 자격증명이 든 디렉터리를 조용히 잃는 경로를 만들지 않는다.
      if (await stat(to).then(() => true, () => false)) {
        throw new Error(`대상에 같은 이름이 이미 있다: ${toPool}/${account}`);
      }
      await rename(from, to);
      // **옮긴 뒤 다시 잰다.** 실측으로는 자격증명 파일이 함께 움직여 로그인이 유지되지만,
      // 갓 로그인한 계정이 파일을 남기는지 Keychain 에만 남기는지는 로그인을 완주해야 알 수
      // 있고 그것은 사람만 할 수 있다 — 그래서 "성공했다"고 말하지 않고 사실을 돌려준다.
      return { loggedIn: readStatus(await runStatus(to)).loggedIn };
    },

    async loginStart(pool: string, account: string, startOpts: { reauth?: boolean } = {}): Promise<{ loginId: string }> {
      const configDir = under(root, pool, account);
      const slot = `${pool}/${account}`;
      // **다시 로그인은 있는 계정에만.** 화면이 낡은 목록을 들고 있다가 지운 계정에 누르면
      // 아래 mkdir 이 그 계정을 되살린다 — 남은 Keychain 항목과 만나면 로그인된 채로(2026-09-29).
      if (startOpts.reauth && !(await stat(configDir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`다시 로그인할 계정이 없다: ${slot}`);
      }
      // **같은 계정에 둘이 붙는 것을 막는다.** 둘이 같은 디렉터리를 밟으면 어느 쪽 자격증명이
      // 남는지 알 수 없다.
      for (const live of logins.values()) {
        if (live.slot === slot && !live.settled) {
          throw new Error(`이 계정에 로그인이 이미 진행 중이다: ${slot}`);
        }
      }
      // 디렉터리를 **먼저** 만든다 — 없으면 claude 가 어디에 로그인해야 할지 모른다.
      // 이미 있었는지를 먼저 잰다: 이름을 화면이 자동으로 짓게 된 뒤로(`acct-<hex>`) 취소한
      // 추가마다 빈 계정이 하나씩 남는다. 치우는 것은 **이 로그인이 만든 것**뿐이다 — 기존
      // 계정의 재로그인이 실패했다고 그 디렉터리(세션·설정)를 지우면 안 된다.
      const created = !(await stat(configDir).then(() => true, () => false));
      await mkdir(configDir, { recursive: true, mode: 0o700 });

      const loginId = randomUUID();
      const child = spawnLogin(configDir);
      const state = {
        child, configDir, slot, created,
        settled: false, urlSent: false, buffer: '',
        killTimer: null as ReturnType<typeof setTimeout> | null,
      };
      logins.set(loginId, state);

      // exit 리스너를 **다른 준비보다 먼저** 건다 — 그 사이에 무언가 던지면 이미 fork 된
      // 자식이 아무도 안 지켜보는 채로 남는다(`pty.ts` 의 같은 규율).
      child.on('exit', (code) => {
        if (state.settled) return;
        state.settled = true;
        if (state.killTimer) clearTimeout(state.killTimer);
        // **끝난 뒤 상태를 다시 잰다.** 종료 코드만으로는 로그인 성공을 알 수 없다 —
        // 사람이 브라우저를 닫아도 프로세스는 0 으로 끝날 수 있다.
        void (async () => {
          const status = readStatus(await runStatus(configDir));
          if (!status.loggedIn && state.created) {
            await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
          }
          if (status.loggedIn) {
            // 다시 로그인했다 = 관문 표식은 옛 로그인의 사정이다. 아직 막혀 있으면 러너가 다시 세운다.
            await clearAccountAttention(configDir).catch(() => undefined);
            // 첫 실행 테마 선택·auto mode 안내 창을 미리 지나 둔다(`@harkroom/shared/claudeGates`).
            // 러너도 턴마다 같은 것을 적지만, 그 전에 사람이 이 계정을 터미널로 열 수 있다 —
            // 그때 테마 화면부터 만나지 않게 여기서도 적는다. 실패해도 로그인은 성공이다.
            await markClaudeAccountGates(configDir).catch((err: unknown) => {
              console.warn(`[claudeAccounts] 계정 관문 기록 실패(로그인은 성공): ${err instanceof Error ? err.message : String(err)}`);
            });
            // 같은 디렉터리의 사용량 캐시는 옛 로그인의 값이다(다시 로그인했다면). 버리고 알린다.
            usageCache.forget(configDir);
            try { opts.onSignedIn?.(configDir); } catch { /* 관찰은 로그인을 실패시키지 않는다 */ }
          }
          emit({
            loginId, done: true, status,
            ...(status.loggedIn ? {} : {
              error: `로그인이 끝나지 않았다 (종료 코드 ${code ?? '없음'}) — 다시 시도해라`,
            }),
          });
          logins.delete(loginId);
        })();
      });

      state.child.stdout?.on('data', (chunk: Buffer) => {
        if (state.urlSent) return;
        state.buffer += chunk.toString('utf8');
        // **URL 이 끝났다는 증거가 있을 때만 낸다.** 청크는 URL 중간에서 잘릴 수 있고
        // (테스트가 그것을 잰다), 그때 낸 URL 은 조용히 잘려 사람이 클릭해도 안 열린다.
        //
        // 끝의 증거는 **터미네이터**다: 공백, BEL(`\u0007`), ESC(`\u001b`) 중 하나. OSC 8 이
        // `ESC ] 8 ; ; <uri> BEL` 이므로 실제 출력에는 BEL 이 온다. 터미네이터가 아직 없으면
        // 더 기다린다 — 버퍼를 비우지 않는다.
        const m = /https:\/\/([^\s\u0007\u001b]+)[\s\u0007\u001b]/.exec(state.buffer);
        if (!m) return;
        state.urlSent = true;
        state.buffer = ''; // 더 모을 이유가 없다
        emit({ loginId, url: `https://${m[1]}` });
      });

      return { loginId };
    },

    async loginSubmit(loginId: string, code: string): Promise<void> {
      const state = logins.get(loginId);
      // **조용히 무시하지 않는다.** 무시하면 UI 가 "코드를 보냈다"를 그리고 사람은 영원히
      // 기다린다.
      if (!state || state.settled) throw new Error(`진행 중인 로그인이 아니다: ${loginId}`);
      // **첫 줄만 보낸다.** 붙여 넣기에 개행이 섞이면 그 뒤가 다음 프롬프트의 답으로 들어간다.
      const line = code.split(/\r?\n/)[0] ?? '';
      state.child.stdin?.write(`${line}\n`);
    },

    async loginCancel(loginId: string): Promise<void> {
      const state = logins.get(loginId);
      // **이미 끝난 것을 취소해도 던지지 않는다** — 사람이 브라우저를 닫는 것과 취소를 누르는
      // 것이 경합하는 정상 상황이다.
      if (!state || state.settled) return;
      // SIGTERM 이 1차다. 유예 안에 안 죽으면 SIGKILL — 러너 회수와 같은 규율이다.
      try { state.child.kill('SIGTERM'); } catch { /* 이미 죽었으면 회수할 것도 없다 */ }
      state.killTimer = setTimeout(() => {
        if (state.settled) return;
        try { state.child.kill('SIGKILL'); } catch { /* 같은 이유 */ }
      }, killGraceMs);
      state.killTimer.unref?.();
    },

    async shutdownLogins(): Promise<void> {
      // **러너와 달리 살려 두지 않는다.** 사람이 브라우저에서 완료해도 코드를 받을 프로세스가
      // 없으므로, 남겨 두면 영원히 기다리는 고아가 된다.
      for (const [, state] of logins) {
        if (state.settled) continue;
        try { state.child.kill('SIGTERM'); } catch { /* 이미 죽었다 */ }
        try { state.child.kill('SIGKILL'); } catch { /* 확실히 끝낸다 */ }
      }
      logins.clear();
    },

    onLoginEvent(cb: (e: ClaudeLoginEvent) => void): void {
      loginListeners.push(cb);
    },
  };
}
