/**
 * 머지 래퍼의 gh 계정 — 앱이 소켓으로 읽고 고른다(스레드 febe9ff8 P2, security C7·C8).
 *
 * 값은 지금처럼 `operator.json` 의 `merge.ghUser` 에 둔다. writer 는 오퍼레이터 하나이고(`config.ts` 머리 주석),
 * 래퍼(`turnMerge.ts`)는 머지할 때마다 그 칸을 다시 읽으므로 고르면 다음 머지부터 쓰인다.
 *
 * **자동으로 정하지 않는다.** 처음 값은 비어 있고(`no_gh_user`), 사람이 목록에서 고른다. 활성 계정은 이 머신에서
 * 회사 계정이라 그것으로 넘어가지 않게 일부러 fail-closed 로 둔 칸이다(security P1).
 *
 * **목록에 있는 이름만 받는다**(C7). set 할 때 `gh auth status` 를 다시 물어 그 순간 로그인된 이름인지 본다 — 웹뷰가
 * 아무 문자열이나 적어 넣는 자리가 되지 않게. gh 에는 인자 배열로만 넘기고 셸 문자열을 만들지 않는다.
 * `--show-token` 은 쓰지 않는다: 이 경로는 토큰을 읽을 일이 없다.
 */
import { hostname } from 'node:os';
import { GH_LOGIN_RE, type OperatorGhAccount, type OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { readConfig, writeConfig } from './config.js';
import { defaultExec, ghEnv, type Exec } from './turnMerge.js';

export interface LocalMergePort {
  get(): Promise<OperatorMergeState>;
  /** `null` 은 지우기다. 목록에 없는 이름이면 던진다(소켓 쪽이 사람 말로 올린다). */
  set(ghUser: string | null): Promise<{ state: OperatorMergeState; previous: string | null }>;
}

type Accounts = { ok: true; accounts: OperatorGhAccount[] } | { ok: false; error: string };

/** `gh auth status --json hosts` 의 github.com 항목에서 이름·활성 여부만 뽑는다. 토큰 칸은 애초에 읽지 않는다. */
export function parseGhAccounts(stdout: string): OperatorGhAccount[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (typeof hosts !== 'object' || hosts === null) return null;
  // `gh auth token -u` 는 github.com 을 본다(래퍼가 --hostname 을 주지 않는다) — 다른 호스트의 계정은 고를 수 없다.
  const list = (hosts as Record<string, unknown>)['github.com'];
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const out: OperatorGhAccount[] = [];
  for (const a of list as { login?: unknown; active?: unknown }[]) {
    if (typeof a?.login !== 'string' || !GH_LOGIN_RE.test(a.login)) continue;
    if (out.some((x) => x.login === a.login)) continue;
    out.push({ login: a.login, active: a.active === true });
  }
  return out;
}

export function createLocalMergePort(deps: {
  configPath: string;
  ghPath: string;
  home: string;
  exec?: Exec;
  host?: string;
}): LocalMergePort {
  const exec = deps.exec ?? defaultExec;
  const host = deps.host ?? hostname();

  const accounts = async (): Promise<Accounts> => {
    // 토큰 없는 env(`ghEnv(home, null)`) — 상속한 GH_TOKEN 이 목록에 끼어들면 고를 수 없는 가짜 항목이 생긴다.
    const r = await exec(deps.ghPath, ['auth', 'status', '--json', 'hosts'], ghEnv(deps.home, null));
    // 로그인 하나가 만료돼도 gh 는 0 이 아닌 코드로 끝나며 JSON 은 낸다 — 코드보다 JSON 을 믿는다.
    const list = parseGhAccounts(r.stdout);
    if (list) return { ok: true, accounts: list };
    const why = r.stderr.trim().slice(0, 200) || `exit ${r.code}`;
    return { ok: false, error: `gh auth status failed: ${why}` };
  };

  const current = async (): Promise<string | null> => {
    const v = (await readConfig(deps.configPath)).merge?.ghUser;
    return typeof v === 'string' && v ? v : null;
  };

  const state = (ghUser: string | null, a: Accounts): OperatorMergeState => ({
    ghUser, host, ...(a.ok ? { accounts: a.accounts } : { accounts: null, accountsError: a.error }),
  });

  return {
    async get() {
      return state(await current(), await accounts());
    },
    async set(ghUser) {
      const a = await accounts();
      if (ghUser !== null) {
        if (!a.ok) throw new Error(a.error);
        if (!a.accounts.some((x) => x.login === ghUser)) throw new Error(`${ghUser} is not logged in to gh on this machine`);
      }
      const config = await readConfig(deps.configPath);
      const previous = typeof config.merge?.ghUser === 'string' && config.merge.ghUser ? config.merge.ghUser : null;
      if (ghUser === null) {
        if (config.merge) {
          delete config.merge.ghUser;
          if (!Object.keys(config.merge).length) delete config.merge;
        }
      } else {
        config.merge = { ...config.merge, ghUser };
      }
      if (previous !== ghUser) await writeConfig(deps.configPath, config);
      return { state: state(ghUser, a), previous };
    },
  };
}
