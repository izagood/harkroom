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
 *   ⑤ `gh pr merge --squash --match-head-commit` ⑥ `POST /agent/merge-results`(서버가 스레드에 시스템 줄).
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
 * gh 계정: 머지는 `operator.json` 의 `merge.ghUser` 로 지정한 gh 계정 토큰으로만 한다(`gh auth token -u`).
 * **없으면 거절한다**(`no_gh_user`, security P1) — 활성 계정으로 넘어가지 않는다. 그 거절도 서버에 보고된다.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

export const MERGE_TOOL = 'repo.merge';

/** `gh` 의 절대 경로 — 셸 PATH 를 믿지 않는다(F3). 기동 때 한 번 고른다. 없으면 머지는 `pr_not_found` 로 실패한다. */
export const GH_PATH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find((p) => existsSync(p)) ?? '/usr/local/bin/gh';

/** 래퍼가 받는 인자 모양(F3). 셸에서 온 문자열이라 여기서 전부 다시 잰다. */
export const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/i;
export const SHA_RE = /^[0-9a-f]{40}$/;

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
 * gh 의 실패가 "이 gh 계정으로는 이 저장소를 볼 수 없다/쓸 수 없다" 인가(P4 의견 ①). `merge.ghUser` 가 개인 계정이면 회사 저장소는
 * 늘 여기 걸린다 — 그때 서버는 카드에 「사람이 머지」를 띄우고 [권한 주기]를 감춘다. 원문은 보고 코드로만 바꾸고 싣지 않는다.
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
  /** `operator.json` 의 `merge.ghUser`. 턴마다 다시 읽는다(설정이 바뀌면 다음 머지부터). */
  ghUser(): Promise<string | undefined>;
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

interface PrView {
  state?: string; isDraft?: boolean; headRefOid?: string; baseRefName?: string; mergeStateStatus?: string;
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string; name?: string; context?: string }[];
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

export function createTurnMerge(deps: TurnMergeDeps): TurnMerge {
  const exec = deps.exec ?? defaultExec;

  /**
   * 머지에 쓸 gh 토큰. **`merge.ghUser` 가 없으면 머지하지 않는다**(security P1, fail-closed). 활성 계정으로 넘어가면
   * 그 계정이 무엇이든 — 이 머신은 회사 계정이고 회사 저장소에 쓰기 권한이 있다 — 그 신원으로 머지된다. 서버는
   * 저장소 이름을 가리지 않으므로, "회사 저장소는 래퍼로 머지할 수 없다"를 기계로 지키는 자리가 바로 여기다:
   * ghUser 를 izagood 로 고정하면 그 계정이 쓸 수 없는 저장소는 머지가 실패한다.
   */
  const tokenFor = async (): Promise<{ ok: true; token: string } | { ok: false; code: 'no_gh_user' | 'gh_token_failed'; message: string }> => {
    const user = await deps.ghUser();
    if (!user || !/^[A-Za-z0-9-]{1,39}$/.test(user)) {
      return { ok: false, code: 'no_gh_user', message: 'operator.json merge.ghUser is not set — the wrapper never merges with the active gh account' };
    }
    const r = await exec(deps.ghPath, ['auth', 'token', '-u', user], ghEnv(deps.home, null));
    const token = r.stdout.trim();
    if (r.code !== 0 || !token) return { ok: false, code: 'gh_token_failed', message: `gh auth token -u ${user} failed: ${r.stderr.trim().slice(0, 200)}` };
    return { ok: true, token };
  };

  const gh = async (args: string[], env: Record<string, string>): Promise<ExecResult> => exec(deps.ghPath, args, env);

  const run = async (runnerId: string, agentId: string, req: RunnerLinkRequest & { type: 'mcp.request' }, call: JsonRpcCall)
    : Promise<{ ok: boolean; value: unknown }> => {
    const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, value: { error: { code, message }, ...extra } });

    const parsed = argsOf(call);
    if ('error' in parsed) return fail('bad_request', parsed.error);
    const { repo, number, headSha } = parsed;

    const lease = req.cause ? deps.lookupLease(runnerId, req.cause) : null;
    if (!lease || lease.agentId !== agentId) return fail('no_lease', 'merge is not available in this turn (no turn lease)');

    // ③ 서버 판정. 닿지 않으면 머지하지 않는다(fail-closed).
    const check = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-checks',
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number, headSha }), contentType: 'application/json',
    }).catch(() => null);
    if (!check || check.type !== 'http.response' || check.status === 0) return fail('unavailable', 'the server could not be reached — merge refused (fail-closed)');
    if (check.status !== 200) {
      let code = `http_${check.status}`;
      try { code = (JSON.parse(check.body) as { error?: { code?: string } }).error?.code ?? code; } catch { /* 그대로 */ }
      return fail(code, `merge not allowed: ${code}`);
    }
    let granted: { grantedBy?: string; causeByHuman?: boolean } = {};
    try { granted = JSON.parse(check.body) as typeof granted; } catch { /* 선택 정보 */ }

    const report = async (result: 'merged' | 'failed', mergeSha: string | null, error: string | null, errorCode: 'no_repo_access' | null = null): Promise<void> => {
      const res = await deps.forward(agentId, {
        type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/merge-results',
        body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number, headSha, result, mergeSha, error, ...(errorCode ? { errorCode } : {}) }), contentType: 'application/json',
      }).catch(() => null);
      if (!res || res.type !== 'http.response' || res.status !== 201) deps.log(`merge: ${repo}#${number} ${result} 보고가 서버에 닿지 않았다(${res && res.type === 'http.response' ? res.status : 'no response'})`);
    };

    // ④ 머지 전 확인. gh 는 절대 경로·빈 env 로만 부른다. 토큰이 없으면 여기서 끝 — 활성 계정으로 넘어가지 않는다(P1).
    const tok = await tokenFor();
    if (!tok.ok) { await report('failed', null, `${tok.code}: ${tok.message}`); return fail(tok.code, tok.message); }
    const env = ghEnv(deps.home, tok.token);
    const view = await gh(['pr', 'view', String(number), '-R', repo, '--json', 'state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup'], env);
    if (view.code !== 0) {
      const access = isRepoAccessError(view.stderr);
      await report('failed', null, `gh pr view: ${view.stderr.trim().slice(0, 300)}`, access ? 'no_repo_access' : null);
      return fail(access ? 'no_repo_access' : 'pr_not_found', access ? 'this operator\'s gh account cannot access the repository — a person merges it' : `gh pr view failed: ${view.stderr.trim().slice(0, 300)}`);
    }
    let pr: PrView = {};
    try { pr = JSON.parse(view.stdout) as PrView; } catch { await report('failed', null, 'gh pr view: unparseable'); return fail('pr_not_found', 'gh pr view returned no JSON'); }
    const refuse = async (code: string, message: string) => { await report('failed', null, `${code}: ${message}`); return fail(code, message, { pr: { state: pr.state, headRefOid: pr.headRefOid, mergeStateStatus: pr.mergeStateStatus } }); };
    if (pr.state !== 'OPEN') return refuse('not_open', `PR is ${pr.state ?? 'unknown'}`);
    if (pr.isDraft) return refuse('draft', 'PR is a draft');
    if (pr.headRefOid !== headSha) return refuse('head_moved', `PR head is ${pr.headRefOid ?? '?'}, not ${headSha}`);
    if (pr.mergeStateStatus !== 'CLEAN') return refuse('not_mergeable', `mergeStateStatus is ${pr.mergeStateStatus ?? 'unknown'} (need CLEAN)`);
    // 체크는 **이름별**로 본다(security C1). 같은 이름의 취소된 중복 실행(CANCELLED, #1078·#1083 에서 실제로 남았다)만
    // 무시한다 — 그 이름에 **빨강(FAILURE·TIMED_OUT·ACTION_REQUIRED)이 하나라도 있으면 빨강**이고, 초록이 하나는 있어야
    // 한다. "초록 하나면 초록"으로 두면 재실행이 빨간데 옛 실행이 초록인 경우가 통과한다. 이름이 없는 항목은 그 항목 하나.
    const checks = pr.statusCheckRollup ?? [];
    const byName = new Map<string, { green: boolean; red: boolean }>();
    checks.forEach((c, i) => {
      const k = c.name ?? c.context ?? `#${i}`;
      const cur = byName.get(k) ?? { green: false, red: false };
      byName.set(k, { green: cur.green || checkGreen(c), red: cur.red || checkRed(c) });
    });
    const red = [...byName.entries()].filter(([, v]) => v.red || !v.green).map(([k]) => k);
    if (!byName.size || red.length) return refuse('ci_not_green', byName.size ? `not green: ${red.join(', ').slice(0, 200)}` : 'no checks reported');

    // ⑤ squash 로만, head 를 못박고. `--admin` 은 문법에 없다.
    const merge = await gh(['pr', 'merge', String(number), '-R', repo, '--squash', '--match-head-commit', headSha], env);
    if (merge.code !== 0) {
      const err = merge.stderr.trim().slice(0, 300);
      const access = isRepoAccessError(merge.stderr);
      await report('failed', null, err, access ? 'no_repo_access' : null);
      return fail(access ? 'no_repo_access' : 'merge_failed', access ? 'this operator\'s gh account cannot merge this repository — a person merges it' : `gh pr merge failed: ${err}`);
    }
    let mergeSha: string | null = null;
    const after = await gh(['pr', 'view', String(number), '-R', repo, '--json', 'mergeCommit'], env);
    try { const oid = (JSON.parse(after.stdout) as PrView).mergeCommit?.oid; if (oid && SHA_RE.test(oid)) mergeSha = oid; } catch { /* 없어도 된다 */ }
    await report('merged', mergeSha, null);
    deps.log(`merge: ${repo}#${number} 머지됨 ${mergeSha ?? '(sha 모름)'} agent=${agentId}`);
    return { ok: true, value: { merged: true, repo, number, headSha, mergeSha, grantedBy: granted.grantedBy ?? null, note: 'reported to the thread as a system line' } };
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
