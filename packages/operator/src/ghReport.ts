/**
 * gh 계정 보고(D1) — 이 머신의 gh 이름과 저장소별 계정 줄을 서버에 알린다. 다른 기기의 승인 화면이 「이 에이전트는 어느 계정으로
 * 머지하나」를 볼 수 있게. **토큰·이메일은 싣지 않는다** — 모양(`GhReport`)에 그런 칸이 없다.
 *
 * 경계(security #1203 F1): 재료(`operator.json` 의 `merge`·gh 로그인)는 머신 전역이다. 그래서
 * - 줄(byScope)은 **이 커뮤니티에서 머지로 쓴 저장소**(`/agent/merge-checks` 를 이 커뮤니티로 보낸 저장소)에 맞는 줄만 싣는다.
 *   다른 커뮤니티의 저장소 이름이 이 서버로 가지 않는다. 오퍼레이터가 다시 뜨면 기록은 비고, 다음 머지 때 다시 찬다.
 * - 로그인 목록·옛 기본값은 머신 값이라 거를 길이 없다 — 이 커뮤니티에 에이전트가 붙어 있을 때만 싣는다(`community.ts`).
 * - 닿음은 이미 아는 것만(이 커뮤니티의 머지가 그 계정으로 머지·큐에 넣었으면 true, 접근 거절이면 false). 따로 재지 않는다.
 */
import type { GhReach, GhReport } from '@harkroom/shared/operatorProtocol';
import { GH_LOGIN_RE } from '@harkroom/shared/daemonProtocol';
import type { OperatorConfig } from './config.js';
import { byScopeOf, legacyOf } from './localMerge.js';

type Merge = NonNullable<OperatorConfig['merge']>;

export interface GhLedger {
  /** 이 커뮤니티(baseUrl)가 이 저장소로 머지를 물었다. */
  noteRepo(baseUrl: string, repo: string): void;
  /** 이 커뮤니티의 머지가 이 계정으로 이 저장소에 닿았다/못 닿았다. */
  noteReach(baseUrl: string, repo: string, login: string, reachable: boolean): void;
  repos(baseUrl: string): Set<string>;
  reach(baseUrl: string): Map<string, boolean>;
}

const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/;
const MAX_REPOS = 64;

export function createGhLedger(): GhLedger {
  const repos = new Map<string, Set<string>>();
  const reach = new Map<string, Map<string, boolean>>();
  return {
    noteRepo(baseUrl, repo) {
      const r = repo.toLowerCase();
      if (!REPO_RE.test(r)) return;
      const set = repos.get(baseUrl) ?? new Set<string>();
      if (set.size >= MAX_REPOS && !set.has(r)) return;
      set.add(r);
      repos.set(baseUrl, set);
    },
    noteReach(baseUrl, repo, login, reachable) {
      const r = repo.toLowerCase();
      if (!REPO_RE.test(r) || !GH_LOGIN_RE.test(login)) return;
      const m = reach.get(baseUrl) ?? new Map<string, boolean>();
      if (m.size >= MAX_REPOS * 4 && !m.has(`${r}\n${login}`)) return;
      m.set(`${r}\n${login}`, reachable);
      reach.set(baseUrl, m);
    },
    repos: (baseUrl) => new Set(repos.get(baseUrl) ?? []),
    reach: (baseUrl) => new Map(reach.get(baseUrl) ?? []),
  };
}

/**
 * 한 커뮤니티에 보낼 보고. `repos` 는 이 커뮤니티가 머지로 물은 저장소 — 그 저장소에 맞는 줄(정확한 `owner/name`, 또는
 * `owner/*`)만 남긴다. `logins` 는 `gh auth status` 의 이름뿐(토큰 칸은 애초에 읽지 않는다, `parseGhAccounts`).
 */
export function buildGhReport(a: {
  merge: Merge | undefined; logins: string[]; repos: Set<string>; reach: Map<string, boolean>;
}): GhReport {
  const all = byScopeOf(a.merge) ?? {};
  const byScope: Record<string, string> = {};
  for (const [scope, login] of Object.entries(all)) {
    const [owner, name] = scope.split('/');
    const relevant = name === '*' ? [...a.repos].some((r) => r.split('/')[0] === owner) : a.repos.has(scope);
    if (relevant) byScope[scope] = login;
  }
  const reach: GhReport['reach'] = [];
  for (const [key, ok] of a.reach) {
    const [repo, login] = key.split('\n') as [string, string];
    if (!a.repos.has(repo)) continue;
    reach.push({ scope: repo, login, reachable: ok as GhReach });
  }
  reach.sort((x, y) => (x.scope + x.login).localeCompare(y.scope + y.login));
  return {
    logins: [...new Set(a.logins.filter((l) => GH_LOGIN_RE.test(l)))].sort(),
    byScope,
    defaultGhUser: legacyOf(a.merge),
    reach,
  };
}
