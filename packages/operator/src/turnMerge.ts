/**
 * 에이전트 머지 — 오퍼레이터가 받는 `harkroom-operator merge` 래퍼(PR 2/3). 설계·검토 스레드 3deac356.
 *
 * **이것은 실수 방지 장치이지 경계가 아니다.** 머지 권한은 서버 표(`account_grant` 의 `repo.merge`)와
 * 이 래퍼가 지킨다. 같은 사용자 계정으로 도는 에이전트는 Keychain 의 gh 토큰으로 이 장치를 돌아갈 수
 * 있으므로, 악의적인 에이전트를 막는 경계가 아니다. 경계가 필요해지면 seatbelt 격리나 서버 머지로 간다.
 *
 * 흐름:
 *   하네스가 `<operatorBin> merge <owner/name> <n> --head <sha>` 를 부른다(러너가 그 에이전트의 턴에만
 *   allow 규칙을 준다 — `agent/src/turn.ts` CLAUDE_PRESET.permissionRules) → 래퍼 프로세스가 브릿지와 같은
 *   소켓으로 `mcp.request{tools/call repo.merge}` 를 보낸다(`main.ts::mergeMain`) → 여기서 받는다:
 *   ① 인자 모양(F3) ② 턴 임대(러너가 relay 로 맡긴 것, `turnSecrets`) ③ 서버 `POST /agent/merge-checks`
 *   (grant·사람 cause, F1·F2·F4 — 닿지 않으면 fail-closed) ④ `gh pr view` 로 OPEN·head 일치·CLEAN·체크 초록
 *   ⑤ `gh pr merge --squash --match-head-commit` — 대상 브랜치가 merge queue 를 쓰면 대신 GraphQL `enqueuePullRequest`
 *   (`expectedHeadOid` = `--head`)로 **큐에 넣는다** ⑥ `POST /agent/merge-results`(서버가 스레드에 시스템 줄).
 *
 * merge queue(10-16, rcms): 큐를 쓰는 브랜치에는 `gh pr merge --squash` 가 거절된다(전략은 큐가 정하고 auto-merge 는 꺼져
 * 있다). 그래서 ⑤ 만 갈린다 — ①~④ 관문은 큐에 넣기 **전에** 똑같이 건다(큐 넣기가 관문을 돌아가는 길이 되면 안 된다).
 * 큐가 끝까지 머지했는지는 기다리지 않는다. **같은 명령을 다시 부르는 것이 확인이다**: 아직 큐에 있으면 `already_queued`
 * (위치·상태), 큐가 머지했으면 `not_open`(pr.state MERGED). 이미 큐에 있는 PR 은 어느 길(1회 승인 사전 확인·권한 거절·
 * 판정 통과)에서도 읽기 전용으로 알아보고 아무것도 하지 않는다 — 다시 넣지 않고, 승인도 쓰지 않고, 카드도 세우지 않는다.
 *
 * F3 를 지키는 자리:
 * - 인자는 네 가지뿐이고 그 밖은 거절한다. `--admin`·`--auto`·`-R` 같은 것은 **문법에 없다**.
 * - gh 는 **절대 경로로 `execFile`** 한다(셸 없음). env 는 비우고 꼭 필요한 것만 넣는다(`ghEnv`) — 하네스
 *   셸의 `GH_REPO`·`GH_HOST`·`PATH` 가 대상을 바꾸지 못한다.
 * - 머지 전에 `gh pr view` 로 base·head·체크·mergeState 를 읽는다. head 가 바뀌었으면 여기서 멈추고,
 *   `--match-head-commit` 이 GitHub 쪽에서 한 번 더 막는다.
 *
 * F5(권한 준 사람 ≠ 오퍼레이터 주인)는 **여기서 판정하지 않는다** — 오퍼레이터는 서버의 소유 사실을 모른다.
 * 서버가 둘 다 알므로 `checkMerge` 에 넣는 것이 맞고, 그 한 줄은 서버 후속 PR 로 둔다. 지금 영향은 없다
 * (사람이 jaebin 하나라 "grant 를 준 사람"과 "오퍼레이터 주인"이 같다). 문서 `docs/agent-merge.md`.
 *
 * gh 계정: 머지는 `operator.json` 의 `merge.byScope` 에서 **그 저장소의 권한 줄**에 고른 gh 계정 토큰으로만 한다
 * (`gh auth token -u`, 정확한 `owner/name` → `owner/*`, 스레드 e085b6a7). **없으면 거절한다**(`no_gh_user`, security P1) —
 * 활성 계정·다른 줄의 계정으로 넘어가지 않는다. 고른 계정이 기기 gh 에 없으면 `gh_user_not_logged_in`. 그 거절도 서버에 보고된다.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

export const MERGE_TOOL = 'repo.merge';

const noRepoAccess = (login: string): string =>
  `the gh account ${login} cannot access or merge this repository — granting more permission will not help; pick another account for this permission row, or a person merges it`;

/** `gh` 의 절대 경로 — 셸 PATH 를 믿지 않는다(F3). 기동 때 한 번 고른다. 없으면 머지는 `pr_not_found` 로 실패한다. */
export const GH_PATH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find((p) => existsSync(p)) ?? '/usr/local/bin/gh';

/** 래퍼가 받는 인자 모양(F3). 셸에서 온 문자열이라 여기서 전부 다시 잰다. */
export const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/i;
export const SHA_RE = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MergeArgs { repo: string; number: number; headSha: string }

/**
 * `merge <owner/name> <n> --head <sha>` — 그 밖의 토큰이 하나라도 있으면 거절. `--approval` 은 **받지 않는다**
 * (security P3): 승인 근거는 서버가 턴 임대의 cause 메시지(그 턴을 띄운 사람 글)로 판정하지, 에이전트가 고른 메시지
 * id 가 아니다. 쓰이지 않는 인자를 받아 두면 감사 근거가 있는 것처럼 보일 뿐이다.
 */
export function parseMergeArgs(argv: readonly string[]): MergeArgs | { error: string } {
  const [repo, num, ...rest] = argv;
  if (!repo || !num) return { error: '사용법: harkroom-operator merge <owner/name> <PR 번호> --head <40자 sha>' };
  if (!REPO_RE.test(repo)) return { error: `저장소 이름이 아니다: ${repo}` };
  if (!/^[1-9][0-9]{0,8}$/.test(num)) return { error: `PR 번호는 양의 정수 하나다: ${num}` };
  let headSha: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]; const value = rest[i + 1];
    if (flag === '--head' && value !== undefined && headSha === undefined) { headSha = value; continue; }
    return { error: `받지 않는 인자: ${flag ?? ''} — 래퍼는 --head 만 받는다(--admin·--auto·-R·--approval 없음)` };
  }
  if (!headSha || !SHA_RE.test(headSha)) return { error: '--head <40자 hex sha> 가 필요하다' };
  return { repo: repo.toLowerCase(), number: Number(num), headSha };
}

/**
 * gh 의 실패가 "이 gh 계정으로는 이 저장소를 볼 수 없다/쓸 수 없다" 인가. `merge.ghUser` 가 개인 계정이면 회사 저장소는 늘 여기
 * 걸린다 — 권한(grant)을 더 줘도 풀리지 않으므로 에이전트는 `no_repo_access` 를 받고 사람에게 머지를 넘긴다(「사람이 머지」).
 * 오류 원문은 서버 보고의 `error`(meta 전용)에만 남고 에이전트 답에는 싣지 않는다.
 */
export function isRepoAccessError(stderr: string): boolean {
  return /Could not resolve to a Repository|Resource not accessible|must have (?:push|write|admin) access|does not have the correct permissions|HTTP 40[34]|not have permission/i.test(stderr);
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (file: string, args: string[], env: Record<string, string>) => Promise<ExecResult>;

export const defaultExec: Exec = (file, args, env) => new Promise((resolve) => {
  execFile(file, args, { env, maxBuffer: 4 * 1024 * 1024, timeout: 120_000, windowsHide: true }, (err, stdout, stderr) => {
    const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** gh 에 주는 env — 상속하지 않는다. 필요한 것만 넣고, 대상을 바꾸는 변수(`GH_REPO`·`GH_HOST`)는 들어올 자리가 없다. */
export function ghEnv(home: string, token: string | null): Record<string, string> {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat',
    ...(token ? { GH_TOKEN: token } : {}),
  };
}

export interface MergeLease { leaseId: string; token: string; agentId: string }

export interface TurnMergeDeps {
  /** 그 에이전트의 커뮤니티 서버로 REST 를 나른다(`community.forward`). */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  /** 러너가 relay 로 맡긴 턴 임대(`turnSecrets.lookup`). 없으면 null — 임대 없이는 아무것도 안 한다. */
  lookupLease(runnerId: string, cause: string): MergeLease | null;
  log(line: string): void;
  /** `gh` 실행 파일의 절대 경로. 셸 PATH 를 믿지 않는다. */
  ghPath: string;
  home: string;
  /**
   * 이 저장소를 머지할 gh 계정(`operator.json` 의 `merge.byScope`, `localMerge.ts::pickMergeGhUser`). 머지마다 다시
   * 읽는다(설정이 바뀌면 다음 머지부터). null 이면 머지하지 않는다.
   */
  ghUserFor(repo: string): Promise<{ login: string; scope: string } | null>;
  exec?: Exec;
}

export interface TurnMerge {
  /** `repo.merge` 호출이면 답하고, 아니면 null(그대로 서버로 넘긴다). */
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function isMergeCall(payload: unknown): payload is JsonRpcCall {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null && p.params.name === MERGE_TOOL;
}

function toolResult(id: string | number | undefined, value: unknown, isError: boolean): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } };
}

/** 셸에서 온 `arguments` 를 다시 잰다 — 래퍼 프로세스가 아니라 **이 프로세스**가 마지막 관문이다. */
function argsOf(call: JsonRpcCall): MergeArgs | { error: string } {
  const a = call.params?.arguments;
  if (typeof a !== 'object' || a === null) return { error: 'arguments 가 없다' };
  const { repo, number, headSha, ...extra } = a as Record<string, unknown>;
  if (Object.keys(extra).length) return { error: `받지 않는 인자: ${Object.keys(extra).join(', ')}` };
  return parseMergeArgs([String(repo ?? ''), String(number ?? ''), '--head', String(headSha ?? '')]);
}

export interface PrView {
  state?: string; isDraft?: boolean; headRefOid?: string; baseRefName?: string; mergeStateStatus?: string;
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string; name?: string; context?: string; workflowName?: string; startedAt?: string }[];
  mergeCommit?: { oid?: string } | null;
}

/** 체크 하나가 초록인가 — check-run 은 `conclusion`, 옛 status-context 는 `state` 로 말한다. */
function checkGreen(c: NonNullable<PrView['statusCheckRollup']>[number]): boolean {
  if (c.state) return c.state === 'SUCCESS';
  if (c.status && c.status !== 'COMPLETED') return false;
  return c.conclusion === 'SUCCESS' || c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL';
}

/** 실패로 끝난 실행 — 같은 이름에 하나라도 있으면 그 이름은 빨강이다(C1). 취소(CANCELLED)·진행 중은 여기 안 든다. */
function checkRed(c: NonNullable<PrView['statusCheckRollup']>[number]): boolean {
  if (c.state) return c.state === 'FAILURE' || c.state === 'ERROR';
  return c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' || c.conclusion === 'ACTION_REQUIRED';
}

/**
 * 머지 전 PR 상태 판정. OPEN·draft 아님·head 일치는 늘 본다. `relaxChecks`(1회 승인의 칸 — 래퍼 인자가 아니다)면 CLEAN·체크
 * 초록은 harkroom 이 따로 보지 않고 GitHub 의 판정(브랜치 보호·required checks)에 맡긴다. `--match-head-commit` 은 그대로다.
 *
 * 체크는 **이름별 최신 실행**으로 본다(`checksByName`). 같은 head 에 같은 이름이 실행 여럿으로 남는다(재실행·PR 본문 수정으로 다시 돈
 * workflow, homelab #219) — GitHub 의 required checks 판정처럼 가장 늦게 시작한 실행 하나만 센다. 옛 실패가 새 초록을 막지
 * 않고, 옛 초록이 새 빨강을 덮지도 않는다(security C1).
 */
/** CI 를 건너뛰는 승인이 지나갈 수 있는 `mergeStateStatus` — CI 말고는 막는 것이 없는 상태. */
const RELAX_STATES = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS']);

/** PR 의 초록 아닌 체크 이름(이름별, C1). */
export function notGreenChecks(pr: PrView): string[] {
  return notGreen(checksByName(pr.statusCheckRollup ?? []));
}

export function refusalOf(pr: PrView, headSha: string, relaxChecks: boolean): { code: string; message: string } | null {
  if (pr.state !== 'OPEN') return { code: 'not_open', message: `PR is ${pr.state ?? 'unknown'}` };
  if (pr.isDraft) return { code: 'draft', message: 'PR is a draft' };
  if (pr.headRefOid !== headSha) return { code: 'head_moved', message: `PR head is ${pr.headRefOid ?? '?'}, not ${headSha}` };
  // CI 실패 무시 승인(스레드 1fccc9a5 F1)은 **CI 만** 건너뛴다 — 충돌(DIRTY)·뒤처진 브랜치(BEHIND)·모름(UNKNOWN)·브랜치 보호(BLOCKED, 리뷰
  // 필수 등)는 승인이 있어도 거절한다. 이 판정은 승인을 쓰기 **전** 사전 확인에서 나므로 승인은 남는다.
  if (relaxChecks) {
    if (RELAX_STATES.has(pr.mergeStateStatus ?? '')) return null;
    return { code: 'not_mergeable', message: `mergeStateStatus is ${pr.mergeStateStatus ?? 'unknown'} — an approval that skips CI still needs CLEAN, UNSTABLE or HAS_HOOKS (conflicts, an out-of-date branch and other branch protection are not skipped)` };
  }
  const byName = checksByName(pr.statusCheckRollup ?? []);
  const red = notGreen(byName);
  if (pr.mergeStateStatus !== 'CLEAN') {
    return { code: 'not_mergeable', message: `mergeStateStatus is ${pr.mergeStateStatus ?? 'unknown'} (need CLEAN)${red.length ? ` — not green: ${namesOf(red)}` : ''}` };
  }
  if (!byName.size || red.length) return { code: 'ci_not_green', message: byName.size ? `not green: ${namesOf(red)}` : 'no checks reported' };
  return null;
}

type CheckItem = NonNullable<PrView['statusCheckRollup']>[number] & { isRequired?: boolean };
type ByName = Map<string, { name: string; green: boolean; red: boolean; required: boolean }>;

/** 시작 시각(ms). 없거나 gh 의 빈 값(`0001-01-01…`)이면 null. */
const startedOf = (c: CheckItem): number | null => {
  const t = c.startedAt ? Date.parse(c.startedAt) : NaN;
  return Number.isFinite(t) && t > 0 ? t : null;
};

/**
 * 이름별로 묶어 **최신 실행 하나**로 판정한다. 열쇠는 workflow 이름 + 체크 이름(다른 workflow 의 같은 job 이름이 서로를 가리지
 * 않게), status-context 는 context. 최신 = `startedAt` 이 가장 늦은 실행 — 아직 도는 최신은 초록이 아니다.
 * - 취소(CANCELLED)된 실행은 최신 고르기에서 뺀다(전부 취소면 남긴다). 판정 없이 끝난 중복이고(#1078·#1083), 막 취소된
 *   대기 실행이 성공한 앞 실행보다 늦게 찍힌다. 같은 head 의 실행이라 앞 실행의 판정이 그대로 이 코드의 판정이다.
 * - 시각을 모르는 실행(아직 대기 중이면 `startedAt` 이 없다)이 끼었으면 전부, 최신이 동률이면 그 동률끼리 본다 — 모두 초록이어야 초록.
 * 이름이 하나라도 required 면 required.
 */
function checksByName(checks: CheckItem[]): ByName {
  const groups = new Map<string, { name: string; runs: CheckItem[] }>();
  checks.forEach((c, i) => {
    const name = c.name ?? c.context ?? `#${i}`;
    const k = c.name !== undefined ? `run\0${c.workflowName ?? ''}\0${c.name}` : c.context !== undefined ? `ctx\0${c.context}` : `#${i}`;
    const g = groups.get(k) ?? { name, runs: [] };
    g.runs.push(c);
    groups.set(k, g);
  });
  const byName: ByName = new Map();
  for (const [k, { name, runs }] of groups) {
    const live = runs.filter((c) => c.conclusion !== 'CANCELLED');
    const pool = live.length ? live : runs;
    const times = pool.map(startedOf);
    let judged = pool;
    if (times.every((t): t is number => t !== null)) {
      const max = Math.max(...times);
      judged = pool.filter((_, i) => times[i] === max);
    }
    byName.set(k, {
      name,
      green: judged.every(checkGreen),
      red: judged.some(checkRed),
      required: runs.some((c) => c.isRequired === true),
    });
  }
  return byName;
}
const notGreen = (byName: ByName, only?: (v: { required: boolean }) => boolean): string[] =>
  [...byName.values()].filter((v) => (!only || only(v)) && (v.red || !v.green)).map((v) => v.name);
const namesOf = (names: string[]): string => names.join(', ').slice(0, 200);
/** 결과 JSON 의 `ignoredChecks` — UNSTABLE 로 통과했을 때만 싣는다(이름은 80자·20개까지). */
const ignoredOf = (ignored: string[]): { ignoredChecks?: string[] } => (ignored.length ? { ignoredChecks: ignored.slice(0, 20).map((n) => n.slice(0, 80)) } : {});

/**
 * 필수 체크 조회(GraphQL, 읽기 전용) — `isRequired(pullRequestNumber:)` 는 브랜치 보호와 ruleset 의 required status checks 를
 * 둘 다 반영한 GitHub 의 판정이다. head 커밋의 oid 도 같이 읽어 사전 확인과 다른 커밋을 보지 않게 한다.
 */
export const REQUIRED_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{workflow{name}}} isRequired(pullRequestNumber:$number)} ... on StatusContext{context state createdAt isRequired(pullRequestNumber:$number)}}}}}}}}}}';

export interface RequiredChecks { headOid: string; truncated: boolean; checks: CheckItem[] }

const workflowNameOf = (n: Record<string, unknown>): string | undefined => {
  const w = (n.checkSuite as { workflowRun?: { workflow?: { name?: unknown } | null } | null } | null | undefined)?.workflowRun?.workflow?.name;
  return typeof w === 'string' ? w : undefined;
};

/** `REQUIRED_QUERY` 의 답. 모양이 틀리면 null(→ 머지하지 않는다). */
export function parseRequiredChecks(stdout: string): RequiredChecks | null {
  try {
    const commit = (JSON.parse(stdout) as { data?: { repository?: { pullRequest?: { commits?: { nodes?: { commit?: Record<string, unknown> }[] } } | null } | null } })
      .data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit;
    if (!commit || typeof commit.oid !== 'string') return null;
    const ctx = (commit.statusCheckRollup as { contexts?: { pageInfo?: { hasNextPage?: boolean }; nodes?: unknown[] } } | null)?.contexts;
    const nodes = Array.isArray(ctx?.nodes) ? ctx.nodes : [];
    const checks: CheckItem[] = nodes.filter((n): n is Record<string, unknown> => typeof n === 'object' && n !== null).map((n) => ({
      ...(typeof n.name === 'string' ? { name: n.name } : {}),
      ...(typeof n.context === 'string' ? { context: n.context } : {}),
      ...(typeof n.status === 'string' ? { status: n.status } : {}),
      ...(typeof n.conclusion === 'string' ? { conclusion: n.conclusion } : {}),
      ...(typeof n.state === 'string' ? { state: n.state } : {}),
      // `gh pr view` 와 같은 모양으로 — 최신 실행 고르기(checksByName)가 두 길에서 같은 열쇠·시각을 본다.
      ...(workflowNameOf(n) !== undefined ? { workflowName: workflowNameOf(n) } : {}),
      ...(typeof n.startedAt === 'string' ? { startedAt: n.startedAt } : typeof n.createdAt === 'string' ? { startedAt: n.createdAt } : {}),
      isRequired: n.isRequired === true,
    }));
    return { headOid: commit.oid, truncated: ctx?.pageInfo?.hasNextPage === true, checks };
  } catch { return null; }
}

/**
 * `UNSTABLE`(필수가 아닌 체크가 실패·진행 중이지만 GitHub 은 머지를 허용) 판정. 「CI 초록」 규칙은 **필수 체크**에 건다:
 * 필수 체크가 하나 이상 있고 그 전부가 초록이면 통과하고, 초록이 아닌 비필수 체크 이름을 `ignored` 로 돌려준다.
 * 필수 체크가 하나도 없는 저장소는 통과시키지 않는다 — 그러면 Test 가 빨개도 머지되는 길이 된다. 그 저장소는 지금처럼
 * 전부 초록이어야 하고, 문구가 「필수 체크를 정하라」를 알려 준다.
 */
export function unstableVerdict(rc: RequiredChecks, headSha: string): { ignored: string[] } | { code: string; message: string } {
  if (rc.headOid !== headSha) return { code: 'head_moved', message: `PR head is ${rc.headOid}, not ${headSha}` };
  if (rc.truncated) return { code: 'not_mergeable', message: 'mergeStateStatus is UNSTABLE and the PR has more than 100 checks — not judged (need CLEAN)' };
  const byName = checksByName(rc.checks);
  const required = [...byName.values()].filter((v) => v.required).length;
  const red = notGreen(byName);
  if (!required) {
    return { code: 'ci_not_green', message: `not green: ${namesOf(red) || '(none reported)'} — the base branch defines no required status checks, so every check must pass; make the checks that must pass required (branch protection or a ruleset) to let other failures through` };
  }
  const requiredRed = notGreen(byName, (v) => v.required);
  if (requiredRed.length) return { code: 'ci_not_green', message: `required checks not green: ${namesOf(requiredRed)}` };
  return { ignored: red };
}

/** merge queue 를 알아보는 GraphQL — 읽기 전용. 대상은 변수로만 받는다(문자열에 끼워 넣지 않는다). */
export const QUEUE_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id isMergeQueueEnabled isInMergeQueue mergeQueueEntry{position state}}}}';
/** 큐에 넣는 뮤테이션 — `jump`(맨 앞으로)는 문법에 없다. `expectedHeadOid` 로 head 를 못박는다(`--match-head-commit` 자리). */
export const ENQUEUE_MUTATION = 'mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position state}}}';

export interface QueueEntry { position: number | null; state: string | null }
export interface QueueInfo { id: string; enabled: boolean; inQueue: boolean; entry: QueueEntry | null }

function entryOf(e: unknown): QueueEntry | null {
  if (typeof e !== 'object' || e === null) return null;
  const { position, state } = e as { position?: unknown; state?: unknown };
  return { position: typeof position === 'number' ? position : null, state: typeof state === 'string' ? state.slice(0, 40) : null };
}

/** `gh api graphql` 의 답에서 큐 정보를 꺼낸다. 모양이 틀리면 null. */
export function parseQueueInfo(stdout: string): QueueInfo | null {
  try {
    const pr = (JSON.parse(stdout) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null } }).data?.repository?.pullRequest;
    if (!pr || typeof pr.id !== 'string' || typeof pr.isMergeQueueEnabled !== 'boolean') return null;
    const entry = entryOf(pr.mergeQueueEntry);
    return { id: pr.id, enabled: pr.isMergeQueueEnabled, inQueue: pr.isInMergeQueue === true || entry !== null, entry };
  } catch { return null; }
}

/**
 * 큐에 넣으려는데 이미 들어 있다는 GitHub 의 답(경합 — 우리가 읽은 뒤 누가 넣었다). 실측(10-16, mq-sandbox): GraphQL
 * `UNPROCESSABLE` 「Pull request is already in the queue」 — 「merge」 낱말이 없다. 문구만 믿지 않고 다시 읽는다(security n1).
 */
export function isAlreadyQueuedError(stderr: string): boolean {
  return /already (?:been )?(?:added to|in|queued in) (?:the )?(?:merge )?queue|is already queued/i.test(stderr);
}

export function createTurnMerge(deps: TurnMergeDeps): TurnMerge {
  const exec = deps.exec ?? defaultExec;

  /**
   * 머지에 쓸 gh 토큰. **`merge.ghUser` 가 없으면 머지하지 않는다**(security P1, fail-closed). 활성 계정으로 넘어가면
   * 그 계정이 무엇이든 — 한 머신에 업무 계정과 개인 계정이 같이 로그인돼 있을 수 있다 — 그 신원으로 머지된다.
   * 서버는 저장소 이름을 가리지 않으므로, "이 계정이 쓸 수 없는 저장소는 래퍼로 머지할 수 없다"를 기계로 지키는
   * 자리가 바로 여기다: ghUser 를 한 계정으로 고정하면 그 계정이 쓸 수 없는 저장소는 머지가 실패한다.
   */
  type TokenFail = { ok: false; code: 'no_gh_user' | 'gh_user_not_logged_in' | 'gh_token_failed'; message: string };
  const tokenFor = async (repo: string): Promise<{ ok: true; token: string; login: string } | TokenFail> => {
    const pick = await deps.ghUserFor(repo);
    if (!pick || !/^[A-Za-z0-9-]{1,39}$/.test(pick.login)) {
      return { ok: false, code: 'no_gh_user', message: `no GitHub account is set for ${repo} on this device — a person picks one in Settings › Agents › Permissions › PR merge (the wrapper never merges with the active gh account)` };
    }
    return tokenForLogin(pick.login, `set for ${pick.scope}`);
  };
  /** 정해진 계정 하나의 토큰. 이 기기 gh 에 없으면 다른 계정으로 넘어가지 않는다(fail-closed) — 사람이 다시 로그인하거나 줄·승인을 바꾼다. */
  const tokenForLogin = async (user: string, why: string): Promise<{ ok: true; token: string; login: string } | TokenFail> => {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) return { ok: false, code: 'no_gh_user', message: `not a GitHub login: ${user.slice(0, 40)}` };
    const r = await exec(deps.ghPath, ['auth', 'token', '-u', user], ghEnv(deps.home, null));
    const token = r.stdout.trim();
    if (r.code !== 0 || !token) {
      if (/no (?:oauth )?token found|not logged in|no account|unknown user/i.test(r.stderr)) {
        return { ok: false, code: 'gh_user_not_logged_in', message: `${user} (${why}) is not logged in to gh on this device — log in again or pick another account` };
      }
      return { ok: false, code: 'gh_token_failed', message: `gh auth token -u ${user} failed: ${r.stderr.trim().slice(0, 200)}` };
    }
    return { ok: true, token, login: user };
  };

  const gh = async (args: string[], env: Record<string, string>): Promise<ExecResult> => exec(deps.ghPath, args, env);

  /** PR 의 merge queue 정보(읽기 전용). 읽지 못하면 null — 부르는 쪽이 정한다. */
  const queueInfo = async (repo: string, number: number, env: Record<string, string>): Promise<QueueInfo | null> => {
    const [owner, name] = repo.split('/');
    const r = await gh(['api', 'graphql', '-f', `query=${QUEUE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], env);
    if (r.code !== 0) return null;
    return parseQueueInfo(r.stdout);
  };

  /**
   * 이미 큐에 있다 — 오류가 아니다(요구 5). 아무것도 하지 않았고 보고도 하지 않는다. 다시 부르면 같은 답이거나 MERGED 다.
   * head 대조보다 먼저 나오므로 PR 의 지금 head(`prHeadRefOid`)를 같이 싣고, `--head` 와 다르면 note 에 적는다(security n2).
   */
  const alreadyQueued = (repo: string, number: number, headSha: string, entry: QueueEntry | null, prHead: string | undefined, note = '') => ({
    ok: true, value: {
      merged: false, queued: true, alreadyQueued: true, repo, number, headSha, prHeadRefOid: prHead ?? null, queue: entry,
      note: `already in the merge queue — nothing was done${note}${prHead && prHead !== headSha ? ` (the PR head is ${prHead}, not the --head you passed)` : ''}. Call the same command again later to check: already_queued while it waits, not_open with pr.state MERGED once the queue merged it.`,
    },
  });

  const run = async (runnerId: string, agentId: string, req: RunnerLinkRequest & { type: 'mcp.request' }, call: JsonRpcCall)
    : Promise<{ ok: boolean; value: unknown }> => {
    const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, value: { error: { code, message }, ...extra } });

    const parsed = argsOf(call);
    if ('error' in parsed) return fail('bad_request', parsed.error);
    const { repo, number, headSha } = parsed;

    const lease = req.cause ? deps.lookupLease(runnerId, req.cause) : null;
    if (!lease || lease.agentId !== agentId) return fail('no_lease', 'merge is not available in this turn (no turn lease)');

    // ②′ 1회 승인(스레드 1b75d7a0, security 순서): 서버의 판정(③)이 승인을 **소모**하므로, 승인이 있으면 그 전에 기록의 계정·head 로
    // GitHub **읽기 전용** 사전 확인을 한다. 여기서 막히면 ③ 을 부르지 않는다 — 승인이 남는다. 사전 확인은 승인을 아끼려는 것일 뿐,
    // 통과 판정은 언제나 ③ 이다. 잠금·해제 API 는 두지 않는다(같은 uid 의 거짓 「실패」 보고로 승인을 되살리는 길이 된다).
    /**
     * PR 이 이미 MERGED·CLOSED 다(스레드 0e30c565 Q3-b) — 서버에 알려 **이 에이전트 자신의** 기다리는 머지 카드를 닫는다. 서버는 그
     * 에이전트의 카드가 있을 때만 받고(없으면 409 no_card), 「머지됨」 줄은 쓰지 않는다. 닿지 않아도 머지 판정에는 영향이 없다.
     */
    const reportClosed = async (state: string | undefined): Promise<void> => {
      if (state !== 'MERGED' && state !== 'CLOSED') return;
      const res = await deps.forward(agentId, {
        type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-closed',
        body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number, state }), contentType: 'application/json',
      }).catch(() => null);
      if (res && res.type === 'http.response' && res.status === 200) deps.log(`merge: ${repo}#${number} 이 이미 ${state} — 기다리던 머지 카드를 닫았다 agent=${agentId}`);
    };

    /**
     * 관문 판정. `UNSTABLE` 이면 필수 체크를 따로 읽어 다시 잰다 — 필수가 전부 초록이면 통과하고 초록 아닌 비필수 이름을
     * `ignored` 로 싣는다. 필수 조회가 안 되면 원래 거절 그대로다(fail-closed).
     */
    type Verdict = { why: { code: string; message: string } | null; ignored: string[]; failing: string[] };
    const judge = async (pr: PrView, env: Record<string, string>, relaxChecks: boolean): Promise<Verdict> => {
      const why = refusalOf(pr, headSha, relaxChecks);
      // CI 를 건너뛰는 승인으로 지나가면 건너뛴 체크(지금 다시 읽은 초록 아닌 이름)를 남긴다.
      if (!why) return { why, ignored: relaxChecks ? notGreenChecks(pr) : [], failing: [] };
      if (why.code !== 'not_mergeable' || pr.mergeStateStatus !== 'UNSTABLE') return { why, ignored: [], failing: why.code === 'ci_not_green' ? notGreenChecks(pr) : [] };
      const [owner, name] = repo.split('/') as [string, string];
      const r = await gh(['api', 'graphql', '-f', `query=${REQUIRED_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`], env);
      const rc = r.code === 0 ? parseRequiredChecks(r.stdout) : null;
      if (!rc) return { why: { code: why.code, message: `${why.message} — could not read which checks are required` }, ignored: [], failing: notGreenChecks(pr) };
      const v = unstableVerdict(rc, headSha);
      return 'code' in v ? { why: v, ignored: [], failing: notGreen(checksByName(rc.checks)) } : { why: null, ignored: v.ignored, failing: [] };
    };
    /** CI 때문에 막혔나(스레드 1fccc9a5 D1) — 서버가 이 거절로 「CI 실패 무시하고 이번 한 번 머지」 카드를 세운다. BLOCKED 는 아니다. */
    const ciRefusalOf = (v: Verdict, pr: PrView) => (v.why && (v.why.code === 'ci_not_green' || (v.why.code === 'not_mergeable' && pr.mergeStateStatus === 'UNSTABLE'))
      ? { code: v.why.code, mergeState: pr.mergeStateStatus ?? null, checks: v.failing.slice(0, 20).map((n) => n.slice(0, 80)) }
      : null);

    const pending = await openApprovalFor(agentId, lease, repo, number, headSha);
    if (pending === 'unavailable') return fail('unavailable', 'the server could not be reached — merge refused (fail-closed)');
    let approvedTok: { token: string; login: string; approvalId: string; approvalGhUser: string | null; prHead?: string; ignored: string[] } | null = null;
    if (pending) {
      // 승인에 계정이 없으면(G1) 이 오퍼레이터가 그 저장소용 계정을 고른다 — 7일 grant 와 같은 길, 없으면 머지하지 않는다(no_gh_user).
      const tok = pending.ghUser ? await tokenForLogin(pending.ghUser, 'chosen in the one-time approval') : await tokenFor(repo);
      if (!tok.ok) return fail(tok.code, `${tok.message} — the one-time approval was not used`);
      const pre = await viewPr(repo, number, ghEnv(deps.home, tok.token));
      if ('error' in pre) {
        if (isRepoAccessError(pre.error)) return fail('no_repo_access', `${noRepoAccess(tok.login)} — the one-time approval was not used`);
        return fail('pr_not_found', `gh pr view failed: ${pre.error} — the one-time approval was not used`);
      }
      if (pre.pr.state === 'OPEN') {
        const q = await queueInfo(repo, number, ghEnv(deps.home, tok.token));
        if (q?.inQueue) return alreadyQueued(repo, number, headSha, q.entry, pre.pr.headRefOid, ' (the one-time approval was not used)');
      }
      const { why, ignored } = await judge(pre.pr, ghEnv(deps.home, tok.token), pending.relaxChecks);
      // 사전 확인 거절은 판정 전이라 보고하지 않는다 — 승인은 남고, 서버에 CI 거절 기록도 생기지 않는다.
      if (why?.code === 'not_open') await reportClosed(pre.pr.state);
      if (why) return fail(why.code, `${why.message} — the one-time approval was not used`, { pr: { state: pre.pr.state, headRefOid: pre.pr.headRefOid, mergeStateStatus: pre.pr.mergeStateStatus } });
      approvedTok = { ...tok, approvalId: pending.id, approvalGhUser: pending.ghUser, prHead: pre.pr.headRefOid, ignored };
    }

    // ③ 서버 판정. 닿지 않으면 머지하지 않는다(fail-closed).
    const check = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-checks',
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number, headSha }), contentType: 'application/json',
    }).catch(() => null);
    if (!check || check.type !== 'http.response' || check.status === 0) return fail('unavailable', 'the server could not be reached — merge refused (fail-closed)');
    if (check.status !== 200) {
      let code = `http_${check.status}`;
      let denialId: string | undefined;
      try {
        const e = (JSON.parse(check.body) as { error?: { code?: string; denialId?: unknown } }).error;
        code = e?.code ?? code;
        if (typeof e?.denialId === 'string' && UUID_RE.test(e.denialId)) denialId = e.denialId;
      } catch { /* 그대로 */ }
      // P4(스레드 febe9ff8): 서버가 카드를 세울 수 있는 거절에만 `denialId` 를 준다(C2). 에이전트는 그것을 `message.ask` 의
      // `mergeDenialId` 로 실어 소유자에게 [7일 주기] 카드를 세운다 — 카드의 저장소·PR 칸은 서버가 기록에서 채운다.
      // 거절된 PR 이 이미 머지·닫혔으면 카드를 세울 일이 아니다(Q3) — 읽기 전용으로 한 번 보고, 그렇다면 기다리던 카드를 닫고
      // `denialId` 없이 `not_open` 으로 끝낸다. 토큰·조회가 안 되면 지금처럼 카드 길로 간다.
      if (code === 'not_granted' || code === 'cause_not_human') {
        const tok = await tokenFor(repo);
        const seen = tok.ok ? await viewPr(repo, number, ghEnv(deps.home, tok.token)) : null;
        const state = seen && 'pr' in seen ? seen.pr.state : undefined;
        if (state === 'MERGED' || state === 'CLOSED') {
          await reportClosed(state);
          return fail('not_open', `PR is ${state} — nothing to merge and no card is needed`, { pr: { state } });
        }
        // 이미 큐에 있다(예: 1회 승인으로 넣은 뒤 확인하러 다시 불렀다) — 카드를 세울 일이 아니다. 읽기 전용, 아무것도 안 한다.
        if (tok.ok && state === 'OPEN') {
          const q = await queueInfo(repo, number, ghEnv(deps.home, tok.token));
          if (q?.inQueue) return alreadyQueued(repo, number, headSha, q.entry, seen && 'pr' in seen ? seen.pr.headRefOid : undefined);
        }
      }
      if (denialId) {
        return { ok: false, value: { error: { code, message: `merge not allowed: ${code} — ask the owner with message.ask and mergeDenialId`, denialId } } };
      }
      return fail(code, `merge not allowed: ${code}`);
    }
    let granted: { grantedBy?: string; causeByHuman?: boolean; approval?: { id?: string; ghUser?: string | null; relaxChecks?: boolean } } = {};
    try { granted = JSON.parse(check.body) as typeof granted; } catch { /* 선택 정보 */ }

    /**
     * 결과 보고. `extra` 는 CI 거절(`ciRefusal`)·무시한 체크(`ignoredChecks`) — 옛 서버는 모르는 키를 버린다(카드만 안 선다).
     * CI 거절이면 서버가 카드용 거절 기록 id(`denialId`)를 돌려준다 — uuid 모양일 때만 넘긴다.
     */
    // 머지에 실제로 쓴 gh 이름(security n6) — 결과 보고에 싣는다. 승인에 계정이 비었으면(G1) 서버는 이 값으로만 안다. 이름뿐이다.
    let usedLogin: string | null = null;
    const report = async (result: 'merged' | 'queued' | 'failed', mergeSha: string | null, error: string | null,
      extra: { ciRefusal?: ReturnType<typeof ciRefusalOf>; ignoredChecks?: string[] } = {}): Promise<{ denialId?: string }> => {
      const res = await deps.forward(agentId, {
        type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-results',
        body: JSON.stringify({
          leaseId: lease.leaseId, token: lease.token, repo, number, headSha, result, mergeSha, error,
          ...(usedLogin ? { ghUserUsed: usedLogin } : {}),
          ...(extra.ciRefusal ? { ciRefusal: extra.ciRefusal } : {}),
          ...(extra.ignoredChecks?.length ? { ignoredChecks: extra.ignoredChecks.slice(0, 20).map((n) => n.slice(0, 80)) } : {}),
        }), contentType: 'application/json',
      }).catch(() => null);
      if (!res || res.type !== 'http.response' || res.status !== 201) {
        deps.log(`merge: ${repo}#${number} ${result} 보고가 서버에 닿지 않았다(${res && res.type === 'http.response' ? res.status : 'no response'})`);
        return {};
      }
      try {
        const d = (JSON.parse(res.body) as { denialId?: unknown }).denialId;
        if (typeof d === 'string' && UUID_RE.test(d)) return { denialId: d };
      } catch { /* 선택 정보 */ }
      return {};
    };

    // ③′ 승인이 소모됐다 — 곧바로 머지한다. 사전 확인과 지금 사이에 head 가 바뀌면 `--match-head-commit` 으로 **GitHub 이** 거절한다.
    // 서버가 돌려준 계정이 사전 확인한 계정과 다르면(그 사이 다른 승인이 쓰였다) 머지하지 않는다 — 다른 계정으로 내려가지 않는다.
    if (granted.approval) {
      // 사전 확인한 바로 그 승인(id)이어야 한다(security F2) — 계정만 맞으면 relaxChecks 가 다른 승인이 쓰여도 지나간다.
      // 계정: 승인에 적혀 있으면 사전 확인한 토큰의 계정과 같아야 한다. 비어 있으면(G1) 서버도 비어 있다고 말해야 하고, 고른 계정은 이 래퍼의 것이다.
      const sameAccount = approvedTok && (approvedTok.approvalGhUser
        ? granted.approval.ghUser === approvedTok.login
        : (granted.approval.ghUser ?? null) === null);
      if (!approvedTok || granted.approval.id !== approvedTok.approvalId || !sameAccount) {
        await report('failed', null, 'approval_mismatch: the approval used by the server is not the one pre-checked');
        return fail('approval_mismatch', 'the server used a one-time approval this wrapper did not pre-check — nothing was merged; ask the owner to approve again');
      }
      return mergeNow(approvedTok, true, null, approvedTok.prHead, approvedTok.ignored);
    }

    // ④ 머지 전 확인. gh 는 절대 경로·빈 env 로만 부른다. 토큰이 없으면 여기서 끝 — 활성 계정으로 넘어가지 않는다(P1).
    const tok = await tokenFor(repo);
    if (!tok.ok) { await report('failed', null, `${tok.code}: ${tok.message}`); return fail(tok.code, tok.message); }
    const env = ghEnv(deps.home, tok.token);
    const view = await gh(['pr', 'view', String(number), '-R', repo, '--json', 'state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup'], env);
    if (view.code !== 0) {
      await report('failed', null, `gh pr view (as ${tok.login}): ${view.stderr.trim().slice(0, 300)}`);
      if (isRepoAccessError(view.stderr)) return fail('no_repo_access', noRepoAccess(tok.login));
      return fail('pr_not_found', `gh pr view failed: ${view.stderr.trim().slice(0, 300)}`);
    }
    let pr: PrView = {};
    try { pr = JSON.parse(view.stdout) as PrView; } catch { await report('failed', null, 'gh pr view: unparseable'); return fail('pr_not_found', 'gh pr view returned no JSON'); }
    const refuse = async (v: Verdict & { why: { code: string; message: string } }) => {
      const ciRefusal = ciRefusalOf(v, pr);
      const { denialId } = await report('failed', null, `${v.why.code}: ${v.why.message}`, { ciRefusal });
      const prInfo = { pr: { state: pr.state, headRefOid: pr.headRefOid, mergeStateStatus: pr.mergeStateStatus } };
      // CI 거절에 카드용 id 가 오면 넘긴다 — 에이전트가 `message.ask` 의 `mergeDenialId` 로 「CI 실패 무시하고 이번 한 번 머지」 카드를 세운다.
      if (denialId) {
        return { ok: false, value: { error: { code: v.why.code, message: `${v.why.message} — the owner can approve this one merge ignoring CI: post message.ask with mergeDenialId`, denialId }, ...prInfo } };
      }
      return fail(v.why.code, v.why.message, prInfo);
    };
    // 이미 큐에 있으면 다시 넣지 않는다(요구 5). 큐에 든 동안의 mergeStateStatus 로 판정하지 않도록 관문보다 먼저 본다 —
    // 이 길은 아무것도 하지 않으므로 관문을 돌아가는 길이 아니다.
    const queue = pr.state === 'OPEN' ? await queueInfo(repo, number, env) : null;
    if (queue?.inQueue) return alreadyQueued(repo, number, headSha, queue.entry, pr.headRefOid);
    const verdict = await judge(pr, env, false);
    const { why, ignored } = verdict;
    // 이미 MERGED·CLOSED 면 「머지 실패」 줄을 쓰지 않는다 — merge queue 의 확인 길(같은 명령 재호출)이 큐가 머지한 PR 에
    // 「⛔ 머지 실패」를 남기게 된다(10-16 mq-sandbox 실측). 기다리던 카드만 닫고 not_open 으로 끝낸다.
    if (why?.code === 'not_open') {
      await reportClosed(pr.state);
      return fail(why.code, why.message, { pr: { state: pr.state, headRefOid: pr.headRefOid, mergeStateStatus: pr.mergeStateStatus } });
    }
    if (why) return refuse({ ...verdict, why });
    return mergeNow(tok, false, queue, pr.headRefOid, ignored);

    /**
     * ⑤ squash 로만, head 를 못박고. `--admin` 은 문법에 없다. 대상 브랜치가 merge queue 를 쓰면 대신 큐에 넣는다(요구 1).
     * 큐 정보를 읽지 못하면 지금처럼 squash 를 시도한다 — 큐 브랜치면 GitHub 이 거절하고(`merge_failed`), 아무것도 머지되지 않는다.
     */
    async function mergeNow(t: { token: string; login: string }, viaApproval: boolean, known: QueueInfo | null, prHead: string | undefined, ignored: string[]): Promise<{ ok: boolean; value: unknown }> {
      const menv = ghEnv(deps.home, t.token);
      usedLogin = t.login;
      // 여기까지 왔으면 1회 승인은 이미 소모됐다 — 경합으로 「이미 큐」가 되면 그 사실을 note 에 남긴다(security n3).
      const usedNote = viaApproval ? ' (the one-time approval was used)' : '';
      const q = known ?? await queueInfo(repo, number, menv);
      if (q?.inQueue) return alreadyQueued(repo, number, headSha, q.entry, prHead, usedNote);
      if (q?.enabled) return enqueueNow(t, viaApproval, q, menv, prHead, usedNote, ignored);
      const merge = await gh(['pr', 'merge', String(number), '-R', repo, '--squash', '--match-head-commit', headSha], menv);
      if (merge.code !== 0) {
        const err = merge.stderr.trim().slice(0, 300);
        await report('failed', null, err);
        const used = viaApproval ? ' — the one-time approval was used; ask the owner to approve again (a new card)' : '';
        if (isRepoAccessError(merge.stderr)) return fail('no_repo_access', noRepoAccess(t.login) + used);
        return fail('merge_failed', `gh pr merge failed: ${err}${used}`);
      }
      let mergeSha: string | null = null;
      const after = await gh(['pr', 'view', String(number), '-R', repo, '--json', 'mergeCommit'], menv);
      try { const oid = (JSON.parse(after.stdout) as PrView).mergeCommit?.oid; if (oid && SHA_RE.test(oid)) mergeSha = oid; } catch { /* 없어도 된다 */ }
      await report('merged', mergeSha, null, { ignoredChecks: ignored });
      deps.log(`merge: ${repo}#${number} 머지됨 ${mergeSha ?? '(sha 모름)'} agent=${agentId}${viaApproval ? ' (1회 승인)' : ''}${ignored.length ? ` 비필수 체크 무시: ${namesOf(ignored)}` : ''}`);
      return { ok: true, value: { merged: true, queued: false, repo, number, headSha, mergeSha, grantedBy: granted.grantedBy ?? null, viaApproval, ghUser: t.login, ...ignoredOf(ignored), note: 'reported to the thread as a system line' } };
    }

    /** ⑤′ merge queue — 큐에 넣고 끝낸다. 큐가 머지할 때까지 기다리지 않는다(요구 4). */
    async function enqueueNow(t: { token: string; login: string }, viaApproval: boolean, q: QueueInfo, menv: Record<string, string>, prHead: string | undefined, usedNote: string, ignored: string[]): Promise<{ ok: boolean; value: unknown }> {
      const r = await gh(['api', 'graphql', '-f', `query=${ENQUEUE_MUTATION}`, '-f', `id=${q.id}`, '-f', `head=${headSha}`], menv);
      let entry: QueueEntry | null = null;
      let gqlError: string | null = null;
      if (r.code === 0) {
        try {
          const d = JSON.parse(r.stdout) as { data?: { enqueuePullRequest?: { mergeQueueEntry?: unknown } | null }; errors?: { message?: string }[] };
          if (d.errors?.length) gqlError = d.errors.map((e) => e.message ?? '').join('; ');
          else entry = entryOf(d.data?.enqueuePullRequest?.mergeQueueEntry);
        } catch { gqlError = 'enqueuePullRequest returned no JSON'; }
      }
      const err = (r.code !== 0 ? r.stderr : gqlError ?? (entry ? '' : 'enqueuePullRequest returned no queue entry')).trim().slice(0, 300);
      if (err) {
        // 우리가 읽은 뒤 누가 먼저 넣었다 — 오류가 아니다. 이 판정의 보고는 하지 않는다(우리는 아무것도 안 했다).
        // 문구만 믿지 않는다(security n1): 다시 읽어 정말 큐에 있을 때만 alreadyQueued, 아니면 아래 enqueue_failed.
        if (isAlreadyQueuedError(err)) {
          const now = await queueInfo(repo, number, menv);
          if (now?.inQueue) return alreadyQueued(repo, number, headSha, now.entry, prHead, usedNote);
        }
        await report('failed', null, `enqueue: ${err}`);
        const used = viaApproval ? ' — the one-time approval was used; ask the owner to approve again (a new card)' : '';
        if (isRepoAccessError(err)) return fail('no_repo_access', noRepoAccess(t.login) + used);
        return fail('enqueue_failed', `enqueuePullRequest failed: ${err}${used}`);
      }
      await report('queued', null, null, { ignoredChecks: ignored });
      deps.log(`merge: ${repo}#${number} 머지 큐에 넣음 위치=${entry?.position ?? '?'} agent=${agentId}${viaApproval ? ' (1회 승인)' : ''}${ignored.length ? ` 비필수 체크 무시: ${namesOf(ignored)}` : ''}`);
      return {
        ok: true, value: {
          merged: false, queued: true, alreadyQueued: false, repo, number, headSha, queue: entry,
          grantedBy: granted.grantedBy ?? null, viaApproval, ghUser: t.login, ...ignoredOf(ignored),
          note: 'added to the merge queue and reported to the thread as a system line — the queue merges it later. Call the same command again to check: already_queued while it waits, not_open with pr.state MERGED once merged.',
        },
      };
    }
  };

  /**
   * 이 임대로 판정하면 서버가 소모할 바로 그 승인(security F2) — 같은 조건·같은 순서를 서버가 고른다(`/agent/merge-approvals/peek`).
   * 판정이 아니다 — 사전 확인의 계정·CI 완화 여부를 알려고 읽는다. 200 이 아니거나 닿지 않으면 unavailable(머지하지 않는다).
   */
  const openApprovalFor = async (agentId: string, lease: MergeLease, repo: string, number: number, headSha: string)
    : Promise<{ id: string; ghUser: string | null; relaxChecks: boolean } | null | 'unavailable'> => {
    const res = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-approvals/peek',
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number, headSha }), contentType: 'application/json',
    }).catch(() => null);
    if (!res || res.type !== 'http.response' || res.status !== 200) return 'unavailable';
    try {
      const a = (JSON.parse(res.body) as { approval?: Record<string, unknown> | null }).approval;
      if (!a) return null;
      if (typeof a.id === 'string' && (typeof a.ghUser === 'string' || a.ghUser === null)) return { id: a.id, ghUser: a.ghUser, relaxChecks: a.relaxChecks === true };
    } catch { /* 모양이 틀리면 아래 */ }
    return 'unavailable';
  };

  const viewPr = async (repo: string, number: number, env: Record<string, string>): Promise<{ pr: PrView } | { error: string }> => {
    const view = await gh(['pr', 'view', String(number), '-R', repo, '--json', 'state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup'], env);
    if (view.code !== 0) return { error: view.stderr.trim().slice(0, 300) };
    try { return { pr: JSON.parse(view.stdout) as PrView }; } catch { return { error: 'gh pr view returned no JSON' }; }
  };

  return {
    async maybeHandle(runnerId, agentId, req) {
      if (req.type !== 'mcp.request' || !isMergeCall(req.payload)) return null;
      const call = req.payload;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse =>
        ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });
      try {
        const r = await run(runnerId, agentId, req, call);
        return reply(r.value, !r.ok);
      } catch (e) {
        deps.log(`merge: 실패 — ${e instanceof Error ? e.message : String(e)}`);
        return reply({ error: { code: 'merge_error', message: 'the merge wrapper hit an internal error; nothing was merged unless gh said so' } }, true);
      }
    },
  };
}
