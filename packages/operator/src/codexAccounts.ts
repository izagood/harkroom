// codex 계정들의 **파일시스템 연산**. `claudeAccounts.ts` 와 같은 이유로 데몬이 소유한다 —
// 웹뷰에는 로컬 파일을 읽거나 프로그램을 띄울 표면이 의도적으로 없고, 웹뷰는 이름만 넘긴다.
//
// ## 모양 (`@harkroom/shared/codexAccounts` 머리 주석)
//
// `<root>/<이름>/` 하나가 계정 하나 = 그 계정의 `CODEX_HOME` 이다. `codex login` 을 그
// `CODEX_HOME` 으로 돌리면 `auth.json` 이 거기 생긴다. 풀은 없고 `active.json` 이 **지금 쓸
// 계정 하나**를 가리킨다. writer 는 이 파일 하나이고 러너는 읽기만 한다(`pools.json` 과 같은
// 단일 writer 규칙).
//
// ## 비밀값을 싣지 않는다
//
// 정체(이메일·플랜)는 `auth.json` 의 `id_token`(JWT) **페이로드**에서 읽는다 — 서명 검증을 하지
// 않는 이유는 이 값을 판정에 쓰지 않고 화면에 이름표로만 쓰기 때문이다. 토큰 자체
// (`access_token`·`refresh_token`·`id_token`·`OPENAI_API_KEY`)는 **이 파일 밖으로 나가지 않는다.**
// 이메일은 사람의 로컬 사실이다 — 로그에 적지 않는다(계정 이름만 적는다).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CODEX_ACCOUNT_NAME_PATTERN,
  CODEX_ACTIVE_FILE,
  parseCodexActive,
} from '@harkroom/shared/codexAccounts';
import type {
  CodexAccountView,
  CodexAccountsSnapshot,
  CodexAuthStatus,
  CodexLoginEvent,
  ProviderUsageSnapshot,
} from '@harkroom/shared/daemonProtocol';

import { fetchCodexProviderUsage, type CodexToken, type FetchLike } from './providerUsage.js';

/** 로그인 자식의 우리가 쓰는 표면만(`ClaudeLoginChild` 와 같은 이유 — 테스트가 가짜를 끼운다). */
export interface CodexLoginChild {
  stdout: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  stderr: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  on(ev: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface CodexAccountsPort {
  list(): Promise<CodexAccountsSnapshot>;
  loginStart(account: string): Promise<{ loginId: string }>;
  loginCancel(loginId: string): Promise<void>;
  removeAccount(account: string): Promise<void>;
  /** `null` 이면 시스템 기본 로그인으로 돌아간다. */
  activate(account: string | null): Promise<void>;
  shutdownLogins(): Promise<void>;
  onLoginEvent(cb: (e: CodexLoginEvent) => void): void;
  /** 공급자 API 사용률(비공식 — `providerUsage.ts`). 시스템 기본 로그인은 `account: ''` 로 싣는다. */
  providerUsage(): Promise<ProviderUsageSnapshot>;
}

/** 러너의 `codexAccountsRoot()`(`agent/src/codexHome.ts`)와 **같은 값**이어야 한다. */
export function codexAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HARKROOM_CODEX_ACCOUNTS_DIR ?? join(homedir(), '.harkroom-agent', 'codex-accounts'));
}

/** 시스템 기본 codex 홈. 러너의 `sourceCodexHome()` 과 같은 규칙. */
export function systemCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CODEX_HOME ?? join(homedir(), '.codex'));
}

/** 이름을 재고 뿌리 아래 경로를 조립한다 — `rm -rf` 가 돌 경로라 두 겹으로 막는다. */
function under(root: string, name: string): string {
  if (!CODEX_ACCOUNT_NAME_PATTERN.test(name)) {
    throw new Error(`이름이 문법에 맞지 않는다: ${JSON.stringify(name)} (${CODEX_ACCOUNT_NAME_PATTERN})`);
  }
  const target = resolve(root, name);
  if (!target.startsWith(`${resolve(root)}/`)) throw new Error(`뿌리 밖의 경로다: ${target}`);
  return target;
}

function jwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const raw = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 이 `CODEX_HOME` 의 로그인 상태를 **디스크에서** 읽는다. 던지지 않는다 — 목록 하나가 못
 * 읽혀 화면 전체가 실패하면 사람은 자기 계정이 사라진 줄 안다.
 *
 * "파일이 있다"는 "토큰이 아직 유효하다"가 아니다(claude 쪽과 같은 한계). 유효성은 턴을 돌려
 * 봐야 알고, 화면이 그것을 흉내내려고 네트워크를 타지 않는다.
 */
export async function codexStatusFromDisk(codexHome: string): Promise<CodexAuthStatus> {
  const authPath = join(codexHome, 'auth.json');
  let raw: Record<string, unknown>;
  let mtimeMs: number | undefined;
  try {
    raw = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
    mtimeMs = (await stat(authPath)).mtimeMs;
  } catch {
    return { loggedIn: false };
  }
  if (typeof raw !== 'object' || raw === null) return { loggedIn: false };
  const tokens = typeof raw.tokens === 'object' && raw.tokens !== null
    ? (raw.tokens as Record<string, unknown>) : null;
  const apiKey = typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.length > 0;
  if (!tokens && !apiKey) return { loggedIn: false };

  const claims = jwtPayload(tokens?.id_token);
  const auth = claims && typeof claims['https://api.openai.com/auth'] === 'object'
    ? (claims['https://api.openai.com/auth'] as Record<string, unknown>) : null;
  const email = typeof claims?.email === 'string' ? claims.email : undefined;
  const plan = typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
  const authMode: CodexAuthStatus['authMode'] = tokens ? 'chatgpt' : 'apikey';
  return {
    loggedIn: true,
    authMode,
    ...(email !== undefined ? { email } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(mtimeMs !== undefined ? { signedInAtMs: Math.round(mtimeMs) } : {}),
  };
}

const LOGIN_KILL_GRACE_MS = 5_000;

/**
 * 기본 `spawnLogin` — `codex login` 을 그 계정의 `CODEX_HOME` 으로 띄운다.
 *
 * codex 0.154 실측: `codex login` 은 로컬 콜백 서버를 띄우고 브라우저를 열며, 인증 URL 을
 * 출력에 찍는다. 코드를 붙여 넣는 단계가 **없다**(브라우저가 localhost 로 돌아온다) — 그래서
 * claude 와 달리 `loginSubmit` 이 없다. 콜백 포트가 하나라 **동시에 하나만** 진행할 수 있다.
 */
function nodeSpawnLogin(codexHome: string): CodexLoginChild {
  return spawn('codex', ['login'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as unknown as CodexLoginChild;
}

async function subdirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.map((e) => e.name).filter((n) => CODEX_ACCOUNT_NAME_PATTERN.test(n)).sort()) {
    const st = await stat(join(dir, name)).catch(() => null);
    if (st?.isDirectory()) out.push(name);
  }
  return out;
}

export function createCodexAccountsPort(opts: {
  root?: string;
  systemHome?: string;
  status?: (codexHome: string) => Promise<CodexAuthStatus>;
  spawnLogin?: (codexHome: string) => CodexLoginChild;
  killGraceMs?: number;
  now?: () => number;
  fetchImpl?: FetchLike;
  readToken?: (codexHome: string) => Promise<CodexToken | null>;
} = {}): CodexAccountsPort {
  const root = opts.root ?? codexAccountsRoot();
  const systemHome = opts.systemHome ?? systemCodexHome();
  const status = opts.status ?? codexStatusFromDisk;
  const spawnLogin = opts.spawnLogin ?? nodeSpawnLogin;
  const killGraceMs = opts.killGraceMs ?? LOGIN_KILL_GRACE_MS;

  const logins = new Map<string, {
    child: CodexLoginChild;
    account: string;
    settled: boolean;
    urlSent: boolean;
    buffer: string;
    killTimer: ReturnType<typeof setTimeout> | null;
  }>();
  const listeners: ((e: CodexLoginEvent) => void)[] = [];
  const emit = (e: CodexLoginEvent): void => {
    for (const cb of listeners) { try { cb(e); } catch { /* 관찰은 부작용이 아니다 */ } }
  };

  const readActive = async (): Promise<string | null> => {
    try {
      return parseCodexActive(JSON.parse(await readFile(join(root, CODEX_ACTIVE_FILE), 'utf8'))).active;
    } catch {
      return null;
    }
  };
  const writeActive = async (active: string | null): Promise<void> => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const path = join(root, CODEX_ACTIVE_FILE);
    const tmp = `${path}.tmp-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify({ active }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
  };

  return {
    async list(): Promise<CodexAccountsSnapshot> {
      const names = await subdirs(root);
      const accounts: CodexAccountView[] = [];
      for (const name of names) accounts.push({ name, status: await status(join(root, name)) });
      const active = await readActive();
      return {
        root,
        // 가리킨 계정이 사라졌으면 `null` 로 보여 준다 — 러너도 그때 시스템으로 떨어진다
        // (`codexAuthSource`). 화면과 러너가 같은 판정을 해야 "활성" 배지가 거짓말을 안 한다.
        active: active !== null && accounts.some((a) => a.name === active && a.status.loggedIn) ? active : null,
        system: await status(systemHome),
        accounts,
      };
    },

    async loginStart(account: string): Promise<{ loginId: string }> {
      const codexHome = under(root, account);
      for (const live of logins.values()) {
        // 콜백 포트가 하나다 — 계정이 달라도 둘을 동시에 띄우면 뒤의 것이 포트를 못 잡는다.
        if (!live.settled) throw new Error(`codex 로그인이 이미 진행 중이다: ${live.account}`);
      }
      await mkdir(codexHome, { recursive: true, mode: 0o700 });

      const loginId = randomUUID();
      const child = spawnLogin(codexHome);
      const state = {
        child, account, settled: false, urlSent: false, buffer: '',
        killTimer: null as ReturnType<typeof setTimeout> | null,
      };
      logins.set(loginId, state);

      child.on('exit', (code) => {
        if (state.settled) return;
        state.settled = true;
        if (state.killTimer) clearTimeout(state.killTimer);
        void (async () => {
          const s = await status(codexHome);
          emit({
            loginId, done: true, status: s,
            ...(s.loggedIn ? {} : { error: `로그인이 끝나지 않았다 (종료 코드 ${code ?? '없음'}) — 다시 시도해라` }),
          });
          logins.delete(loginId);
        })();
      });

      const onData = (chunk: Buffer): void => {
        if (state.urlSent) return;
        state.buffer += chunk.toString('utf8');
        // URL 끝의 증거(공백·BEL·ESC)가 올 때까지 기다린다 — 청크가 URL 중간에서 잘릴 수 있다.
        const m = /(https:\/\/auth\.openai\.com\/[^\s\u0007\u001b]+)[\s\u0007\u001b]/.exec(state.buffer);
        if (!m) return;
        state.urlSent = true;
        state.buffer = '';
        emit({ loginId, url: m[1]! });
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      return { loginId };
    },

    async loginCancel(loginId: string): Promise<void> {
      const state = logins.get(loginId);
      if (!state || state.settled) return;
      try { state.child.kill('SIGTERM'); } catch { /* 이미 죽었다 */ }
      state.killTimer = setTimeout(() => {
        if (state.settled) return;
        try { state.child.kill('SIGKILL'); } catch { /* 같은 이유 */ }
      }, killGraceMs);
      state.killTimer.unref?.();
    },

    async removeAccount(account: string): Promise<void> {
      const dir = under(root, account);
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`계정이 없다: ${account}`);
      }
      // 활성 계정을 지우면 **먼저** 시스템 기본으로 돌린다. 순서가 반대면 그 사이에 뜬 턴이
      // 사라진 계정을 가리킨다.
      if ((await readActive()) === account) await writeActive(null);
      await rm(dir, { recursive: true, force: true });
    },

    async activate(account: string | null): Promise<void> {
      if (account !== null) {
        const s = await status(under(root, account));
        // 로그인이 없는 계정을 활성으로 만들지 않는다 — 러너는 그때 시스템으로 떨어지므로
        // 화면의 "활성" 이 거짓이 된다.
        if (!s.loggedIn) throw new Error(`로그인되지 않은 계정이다: ${account}`);
      }
      await writeActive(account);
    },

    async shutdownLogins(): Promise<void> {
      for (const [, state] of logins) {
        if (state.settled) continue;
        try { state.child.kill('SIGTERM'); } catch { /* 이미 죽었다 */ }
        try { state.child.kill('SIGKILL'); } catch { /* 확실히 끝낸다 */ }
      }
      logins.clear();
    },

    onLoginEvent(cb: (e: CodexLoginEvent) => void): void {
      listeners.push(cb);
    },

    async providerUsage(): Promise<ProviderUsageSnapshot> {
      const at = (opts.now ?? Date.now)();
      const homes = [{ account: '', home: systemHome }, ...(await subdirs(root)).map((n) => ({ account: n, home: join(root, n) }))];
      const accounts = await Promise.all(homes.map(async (h) => ({
        account: h.account,
        ...(await fetchCodexProviderUsage({
          codexHome: h.home, now: at,
          fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
          ...(opts.readToken ? { readToken: opts.readToken } : {}),
        })),
      })));
      return { measuredAtMs: at, accounts };
    },
  };
}
