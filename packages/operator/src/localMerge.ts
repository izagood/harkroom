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
import { GH_LOGIN_RE, MERGE_SCOPE_RE, type OperatorGhAccount, type OperatorMergeCheckResult, type OperatorMergeReach, type OperatorMergeSetPayload, type OperatorMergeState } from '@harkroom/shared/daemonProtocol';
import { readConfig, writeConfig, type OperatorConfig } from './config.js';
import { defaultExec, ghEnv, type Exec } from './turnMerge.js';

export interface LocalMergePort {
  get(): Promise<OperatorMergeState>;
  /**
   * `ghUser: null` 은 지우기다. 목록에 없는 이름이면 던진다(소켓 쪽이 사람 말로 올린다). `changes` 는 바뀐 것만
   * (`scope` 가 null 이면 옛 기기 기본값) — 소켓 쪽이 로그에 남긴다(security C8).
   */
  set(p: OperatorMergeSetPayload): Promise<{ state: OperatorMergeState; changes: { scope: string | null; from: string | null; to: string | null }[] }>;
  /** 범위마다 지금 로그인된 계정이 닿는지(시안 상태 A·B·E). 10분 캐시 — 토큰은 이 안에서만 쓰고 답에 싣지 않는다. */
  check(scopes: string[]): Promise<OperatorMergeCheckResult>;
}

/** 닿음 확인 캐시 수명(시안 §6) — 화면을 열 때마다 GitHub 을 두드리지 않게. */
export const REACH_TTL_MS = 10 * 60_000;

/**
 * 한 계정이 한 범위에 닿는가. 머지에는 쓰기 권한이 필요하다.
 * - `owner/name`: `GET repos/owner/name` 의 `permissions` 에 push·maintain·admin 중 하나가 있으면 ok. 404 는 no(비공개 저장소를
 *   못 보는 것도 404 다). 200 인데 쓰기 권한이 없으면 no.
 * - `owner/*`: owner 가 그 계정 자신이면 ok. 아니면 `GET user/memberships/orgs/owner` 가 active 면 ok, 404 면 no. 조직 회원이라고
 *   모든 저장소에 쓰기가 있는 것은 아니다 — 조직 줄의 ✓ 는 「그 조직에 들어가 있다」까지만 말한다.
 * - 403(토큰에 read:org 없음 등)·그 밖의 실패는 unknown — 경고색을 쓰지 않는 「확인 못 함」이다.
 */
export function reachFromGh(scope: string, login: string, r: { code: number; stdout: string; stderr: string }): OperatorMergeReach {
  const [owner, name] = scope.split('/');
  if (name === '*' && owner === login.toLowerCase()) return 'ok';
  if (r.code !== 0) return /HTTP 404|Not Found/i.test(r.stderr) ? 'no' : 'unknown';
  let body: unknown;
  try { body = JSON.parse(r.stdout); } catch { return 'unknown'; }
  if (name === '*') return (body as { state?: unknown } | null)?.state === 'active' ? 'ok' : 'no';
  const perms = (body as { permissions?: Record<string, unknown> } | null)?.permissions;
  if (!perms || typeof perms !== 'object') return 'unknown';
  return perms.push === true || perms.maintain === true || perms.admin === true ? 'ok' : 'no';
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
  now?: () => number;
}): LocalMergePort {
  const exec = deps.exec ?? defaultExec;
  const host = deps.host ?? hostname();
  const now = deps.now ?? Date.now;
  // 키는 `scope\nlogin`. 토큰은 담지 않는다 — 잴 때마다 `gh auth token -u` 로 다시 꺼낸다.
  const reachCache = new Map<string, { status: OperatorMergeReach; at: number }>();

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

  const reachOf = async (scope: string, login: string): Promise<{ status: OperatorMergeReach; at: number }> => {
    const key = `${scope}\n${login}`;
    const hit = reachCache.get(key);
    if (hit && now() - hit.at < REACH_TTL_MS) return hit;
    const [owner, name] = scope.split('/');
    let status: OperatorMergeReach;
    if (name === '*' && owner === login.toLowerCase()) status = 'ok';
    else {
      const tok = await exec(deps.ghPath, ['auth', 'token', '-u', login], ghEnv(deps.home, null));
      const token = tok.stdout.trim();
      if (tok.code !== 0 || !token) status = 'unknown';
      else {
        // 경로는 MERGE_SCOPE_RE 를 지난 범위로만 짓는다 — 웹뷰가 다른 API 를 고를 자리가 없다.
        const path = name === '*' ? `user/memberships/orgs/${owner}` : `repos/${owner}/${name}`;
        status = reachFromGh(scope, login, await exec(deps.ghPath, ['api', path], ghEnv(deps.home, token)));
      }
    }
    const v = { status, at: now() };
    reachCache.set(key, v);
    return v;
  };

  return {
    async check(scopes) {
      const a = await accounts();
      const reach: OperatorMergeCheckResult['reach'] = {};
      if (!a.ok) return { reach };
      // 범위 × 계정이 몇 개 안 된다(줄 몇 개 × 로그인 두셋). 한꺼번에 돌리되 같은 계정의 토큰은 캐시가 받친다.
      await Promise.all(scopes.flatMap((scope) => a.accounts.map(async ({ login }) => {
        const r = await reachOf(scope, login);
        (reach[scope] ??= {})[login] = { status: r.status, checkedAt: new Date(r.at).toISOString() };
      })));
      return { reach };
    },
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
