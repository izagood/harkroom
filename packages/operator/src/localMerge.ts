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
import { GH_LOGIN_RE, MERGE_SCOPE_RE, type OperatorGhAccount, type OperatorMergeSetPayload, type OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { readConfig, writeConfig, type OperatorConfig } from './config.js';
import { defaultExec, ghEnv, type Exec } from './turnMerge.js';

export interface LocalMergePort {
  get(): Promise<OperatorMergeState>;
  /**
   * `ghUser: null` 은 지우기다. 목록에 없는 이름이면 던진다(소켓 쪽이 사람 말로 올린다). `changes` 는 바뀐 것만
   * (`scope` 가 null 이면 옛 기기 기본값) — 소켓 쪽이 로그에 남긴다(security C8).
   */
  set(p: OperatorMergeSetPayload): Promise<{ state: OperatorMergeState; changes: { scope: string | null; from: string | null; to: string | null }[] }>;
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

  const state = (merge: Merge | undefined, a: Accounts): OperatorMergeState => ({
    ghUser: legacyOf(merge), byScope: byScopeOf(merge), host,
    ...(a.ok ? { accounts: a.accounts } : { accounts: null, accountsError: a.error }),
  });

  return {
    async get() {
      const [config, a] = await Promise.all([readConfig(deps.configPath), accounts()]);
      return state(config.merge, a);
    },
    async set(p) {
      const config = await readConfig(deps.configPath);
      const before = config.merge;
      const changes: { scope: string | null; from: string | null; to: string | null }[] = [];
      let a: Accounts | null = null;
      const loggedIn = async (login: string): Promise<void> => {
        a ??= await accounts();
        if (!a.ok) throw new Error(a.error);
        if (!a.accounts.some((x) => x.login === login)) throw new Error(`${login} is not logged in to gh on this machine`);
      };
      let next: Merge = { ...before };
      if ('migrate' in p) {
        // 한 번만: byScope 가 이미 있으면 옮긴 것이다 — 옛 값이 남아 있어도 다시 복사하지 않는다.
        if (!byScopeOf(before)) {
          const legacy = legacyOf(before);
          const byScope: Record<string, string> = {};
          if (legacy) for (const sc of p.migrate) { byScope[sc] = legacy; changes.push({ scope: sc, from: null, to: legacy }); }
          next = { ...before, byScope };
          delete next.ghUser;
          if (legacy) changes.push({ scope: null, from: legacy, to: null });
        }
      } else if ('scope' in p) {
        if (p.ghUser !== null) await loggedIn(p.ghUser);
        // 줄을 고르는 것 자체가 옮김이다 — byScope 가 생기면 옛 기본값은 더 읽지 않는다(다른 줄로 말없이 떨어지지 않게).
        const byScope = { ...(byScopeOf(before) ?? {}) };
        const from = byScope[p.scope] ?? null;
        if (p.ghUser === null) delete byScope[p.scope]; else byScope[p.scope] = p.ghUser;
        next = { ...before, byScope };
        if (from !== p.ghUser) changes.push({ scope: p.scope, from, to: p.ghUser });
      } else {
        if (p.ghUser !== null) await loggedIn(p.ghUser);
        const from = legacyOf(before);
        next = { ...before };
        if (p.ghUser === null) delete next.ghUser; else next.ghUser = p.ghUser;
        if (from !== p.ghUser) changes.push({ scope: null, from, to: p.ghUser });
      }
      if (!Object.keys(next).length) delete config.merge; else config.merge = next;
      if (JSON.stringify(before ?? {}) !== JSON.stringify(next)) await writeConfig(deps.configPath, config);
      return { state: state(config.merge, a ?? await accounts()), changes };
    },
  };
}

type Merge = NonNullable<OperatorConfig['merge']>;

/** 옛 기기 기본값 — 모양이 아니면 없는 것으로 본다. */
function legacyOf(merge: Merge | undefined): string | null {
  const v = merge?.ghUser;
  return typeof v === 'string' && GH_LOGIN_RE.test(v) ? v : null;
}

/** 줄별 계정 — 손으로 적은 파일일 수 있으니 모양이 아닌 항목은 버린다. 칸이 없으면 null(아직 옮기기 전). */
export function byScopeOf(merge: Merge | undefined): Record<string, string> | null {
  const v = merge?.byScope as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, login] of Object.entries(v as Record<string, unknown>)) {
    const sc = k.toLowerCase();
    if (MERGE_SCOPE_RE.test(sc) && typeof login === 'string' && GH_LOGIN_RE.test(login)) out[sc] = login;
  }
  return out;
}

/**
 * 이 저장소의 머지에 쓸 gh 계정(스레드 e085b6a7). 찾는 순서는 정확한 `owner/name` → `owner/*` 다 — 사람이 일부러 따로
 * 고른 좁은 줄이 이긴다. `byScope` 가 있으면 **옛 기본값으로 떨어지지 않는다**(맞지 않는 계정이 말없이 쓰인 것이 이번 일의
 * 원인이다). `byScope` 가 아직 없을 때(앱이 옮기기 전)만 옛 `ghUser` 를 쓴다 — 갱신 직후 머지가 끊기지 않게.
 */
export function pickMergeGhUser(merge: Merge | undefined, repo: string): { login: string; scope: string } | null {
  const byScope = byScopeOf(merge);
  if (!byScope) {
    const legacy = legacyOf(merge);
    return legacy ? { login: legacy, scope: '(device default)' } : null;
  }
  const r = repo.toLowerCase();
  const org = `${r.split('/')[0]}/*`;
  if (byScope[r]) return { login: byScope[r], scope: r };
  if (byScope[org]) return { login: byScope[org], scope: org };
  return null;
}
