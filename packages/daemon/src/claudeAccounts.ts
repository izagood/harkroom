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
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  CLAUDE_POOL_NAME_PATTERN,
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from '@murmur/shared/claudePools';

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
  subscriptionType?: string;
  authMethod?: string;
}

export interface ClaudeAccountView {
  name: string;
  status: ClaudeAuthStatus;
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
  loginStart(pool: string, account: string): Promise<{ loginId: string }>;
  loginSubmit(loginId: string, code: string): Promise<void>;
  loginCancel(loginId: string): Promise<void>;
  /** 진행 중인 로그인을 전부 회수한다. 데몬 종료 경로가 부른다. */
  shutdownLogins(): Promise<void>;
  onLoginEvent(cb: (e: ClaudeLoginEvent) => void): void;
}

/** 계정 풀 뿌리. 러너의 `claudeAccountsRoot()` 와 **같은 값**이어야 한다. */
export function claudeAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MURMUR_CLAUDE_ACCOUNTS_DIR ?? join(homedir(), '.murmur-agent', 'claude-accounts');
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

/** 기본 `runStatus` — 실제 `claude` 를 부른다. */
function nodeRunStatus(configDir: string): Promise<unknown> {
  return new Promise((res) => {
    execFile(
      'claude',
      ['auth', 'status', '--json'],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: 15_000 },
      (_err, stdout) => {
        // **종료 코드 1 을 정상으로 받는다** — 미로그인이 1 이다(실측). 그 코드로 실패를
        // 판정하면 미로그인 계정이 "조회 실패"가 되어 UI 가 할 일을 못 가리킨다.
        try {
          res(JSON.parse(String(stdout)));
        } catch {
          res({ loggedIn: false });
        }
      },
    );
  });
}

function readStatus(raw: unknown): ClaudeAuthStatus {
  if (typeof raw !== 'object' || raw === null) return { loggedIn: false };
  const r = raw as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
  return {
    loggedIn: r.loggedIn === true,
    ...(pick('email') !== undefined ? { email: pick('email')! } : {}),
    ...(pick('orgName') !== undefined ? { orgName: pick('orgName')! } : {}),
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

export function createClaudeAccountsPort(opts: {
  root?: string;
  runStatus?: (configDir: string) => Promise<unknown>;
  spawnLogin?: (configDir: string) => ClaudeLoginChild;
  killGraceMs?: number;
} = {}): ClaudeAccountsPort {
  const root = opts.root ?? claudeAccountsRoot();
  const runStatus = opts.runStatus ?? nodeRunStatus;
  const spawnLogin = opts.spawnLogin ?? nodeSpawnLogin;
  const killGraceMs = opts.killGraceMs ?? LOGIN_KILL_GRACE_MS;

  /** 진행 중인 로그인. 키는 `loginId`. */
  const logins = new Map<string, {
    child: ClaudeLoginChild;
    configDir: string;
    /** `<pool>/<account>` — 같은 계정에 둘이 붙는 것을 막는 키다. */
    slot: string;
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

  /** `pools.json`. **없음(`null`)과 깨짐(빈 설정)을 가른다** — 존재가 모드 스위치다. */
  async function readConfig(): Promise<ClaudePoolsConfig | null> {
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

  async function accountsOf(dir: string): Promise<ClaudeAccountView[]> {
    const names = await subdirs(dir);
    const out: ClaudeAccountView[] = [];
    for (const name of names) {
      out.push({ name, status: readStatus(await runStatus(join(dir, name))) });
    }
    return out;
  }

  return {
    async list(): Promise<ClaudeAccountsSnapshot> {
      const cfg = await readConfig();

      if (cfg === null) {
        // 평평한 구조. 뿌리의 하위 디렉터리가 계정이고, 이름 없는 풀 하나로 보여 준다.
        const accounts = await accountsOf(root);
        return {
          root, mode: 'flat', defaultPool: null, agents: {},
          pools: accounts.length ? [{ name: '', accounts }] : [],
          strays: [],
        };
      }

      const poolNames = await subdirs(root);
      const pools: ClaudePoolView[] = [];
      const strays: string[] = [];
      for (const name of poolNames) {
        const dir = join(root, name);
        // 풀 모드에서 **계정 모양인 뿌리 하위 디렉터리는 풀이 아니라 잔여물**이다.
        // 그것을 풀로 세면 UI 가 "계정 0개인 이상한 풀"을 그리고, 사용자는 자기 계정이
        // 어디 갔는지 알 수 없다.
        if (await looksLikeAccount(dir)) { strays.push(name); continue; }
        pools.push({ name, accounts: await accountsOf(dir) });
      }
      return { root, mode: 'pools', defaultPool: cfg.defaultPool, agents: cfg.agents, pools, strays };
    },

    async configure(cfg: ClaudePoolsConfig): Promise<void> {
      // **정규화에서 이름이 떨어져 나가면 던진다.** 조용히 버리면 UI 가 쓴 것과 디스크가
      // 갈리고, 사용자는 "설정했는데 안 먹었다"를 보게 된다(spec §6-2 — 웹뷰를 신뢰하지 않는다).
      const norm = parseClaudePoolsConfig(cfg);
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

      // 원자적으로 쓴다. 유일한 임시 이름을 쓰는 이유는 `sessions.json` 과 같다 — 고정
      // 이름이면 먼저 끝난 rename 이 tmp 를 치워 나중 rename 이 ENOENT 로 죽는다.
      const tmpPath = `${poolsConfigPath(root)}.tmp-${randomUUID()}`;
      await writeFile(tmpPath, `${JSON.stringify(norm, null, 2)}\n`, { mode: 0o600 });
      await rename(tmpPath, poolsConfigPath(root));
    },

    async removeAccount(pool: string, account: string): Promise<void> {
      const dir = under(root, pool, account);
      // **없는 것을 지우려 하면 거절한다.** 조용히 성공하면 UI 가 "지웠다"를 그리는데
      // 실제로는 다른 것이 남아 있을 수 있다.
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`계정이 없다: ${pool}/${account}`);
      }
      await rm(dir, { recursive: true, force: true });
    },

    async removePool(pool: string): Promise<void> {
      const dir = under(root, pool);
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`풀이 없다: ${pool}`);
      }
      await rm(dir, { recursive: true, force: true });
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

    async loginStart(pool: string, account: string): Promise<{ loginId: string }> {
      const configDir = under(root, pool, account);
      const slot = `${pool}/${account}`;
      // **같은 계정에 둘이 붙는 것을 막는다.** 둘이 같은 디렉터리를 밟으면 어느 쪽 자격증명이
      // 남는지 알 수 없다.
      for (const live of logins.values()) {
        if (live.slot === slot && !live.settled) {
          throw new Error(`이 계정에 로그인이 이미 진행 중이다: ${slot}`);
        }
      }
      // 디렉터리를 **먼저** 만든다 — 없으면 claude 가 어디에 로그인해야 할지 모른다.
      await mkdir(configDir, { recursive: true, mode: 0o700 });

      const loginId = randomUUID();
      const child = spawnLogin(configDir);
      const state = {
        child, configDir, slot,
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
