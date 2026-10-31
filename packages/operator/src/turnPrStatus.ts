/**
 * 읽기 전용 PR 상태 `pr.status`(2026-10-31, `shared/src/prStatus.ts` 의 P3). 브릿지로 온 `tools/call pr.status` 를 여기서 받아
 * 서버 허락 → gh 읽기 → 고정 칸만 돌려준다. 서버까지 가면 `operator_required` 다(P2).
 *
 * 흐름(머지 래퍼 `turnMerge.ts` 의 앞쪽과 같은 순서):
 *   ① 인자 모양(`repo`·`number` 둘뿐) ② 턴 임대(`turnSecrets.lookup`, 러너 턴만) ③ 서버 `POST PR_STATUS_CHECKS_PATH` —
 *   **200 `allowed: true` 가 아니면 gh 를 부르지 않는다**(닿지 않음·시간 초과·4xx·5xx·모양이 틀림 모두 거절, fail-closed)
 *   ④ 머지와 같은 gh 계정(`createGhTokens().tokenFor`, `merge.byScope` 정확 → `owner/*` → 없으면 `no_gh_user`)
 *   ⑤ 관문 `createPrGate().inspect` — 머지 판정과 같은 함수로 「지금 머지하면 무엇에 걸리나」를 코드로만 낸다.
 *
 * 지키는 것:
 * - gh `-R` 과 관문에 넣는 저장소는 **서버가 200 에 돌려준 `repo`** 하나다(정규화된 소문자). 모델이 적은 글자가 아니다.
 * - gh 는 관문이 이미 내는 읽기 명령만 부른다(`pr view --json` 고정 칸, GraphQL query 고정 문, activity GET). 쓰기·`gh api` 자유 경로 없음.
 * - 1회 승인의 계정(`tokenForLogin`)은 쓰지 않는다 — 승인은 머지 한 번의 것이지 읽기의 근거가 아니다.
 * - 머지 보고(`merge-results`·`merge-closed`)·글 게시는 하지 않는다. 이 길이 서버에 보내는 것은 ③ 하나뿐이다.
 * - 답에는 고정 칸(`pickPrStatus`)과 판정 **코드**·체크 이름만 싣는다. 판정 문구·gh stderr·제목·URL·activity 의 행위자는 싣지 않는다 —
 *   남이 적은 글이 모델 문맥에 지시로 읽힐 수 있고(프롬프트 주입), stderr 에는 계정 이름·경로가 섞인다.
 * - 유예의 「처음 본 시각」(`firstSeen`)은 머지 길과 같은 Map 이다 — run.ts 가 하나를 만들어 둘에 넘긴다.
 */
import { randomUUID } from 'node:crypto';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { PR_STATUS_CHECKS_PATH, PR_STATUS_TOOL, oneLineText, pickPrStatus, type PrStatusDenial, type PrStatusResult } from '@harkroom/shared/prStatus';
import { createGhTokens, createPrGate, defaultExec, ghEnv, isRepoAccessError, REPO_RE, type Exec, type ExecResult, type MergeLease, type TurnMergeDeps } from './turnMerge.js';

/**
 * 거절 코드. 서버의 것(`PrStatusDenial`)은 그대로 넘긴다. 나머지는 이 오퍼레이터의 것이라 shared 에 두지 않는다 — 서버는 이 코드를
 * 만들지도 읽지도 않는다. `unavailable` 은 머지 래퍼가 서버에 못 닿았을 때 쓰는 것과 같은 이름이다.
 */
export type PrStatusRefusal =
  | PrStatusDenial
  | 'no_lease' | 'unavailable'
  | 'no_gh_user' | 'gh_user_not_logged_in' | 'gh_token_failed'
  | 'no_repo_access' | 'gh_failed' | 'pr_status_error';

const SERVER_DENIALS: ReadonlySet<string> = new Set<PrStatusDenial>(['bad_request', 'bad_repo', 'forbidden', 'lease_invalid', 'not_granted']);

/**
 * 모델에 돌려주는 답. `verdict` 는 「지금 이 head 로 머지하면」의 관문 코드 — 통과면 `ok`, 이미 merge queue 에 있으면 `queued`
 * (큐에 든 동안은 판정하지 않는다), 그 밖은 `not_open`·`draft`·`not_mergeable`·`ci_not_green`·`ci_pending` 같은 머지 거절 코드다.
 * `ignored`·`failing` 은 체크 이름뿐(한 줄, 80자·20개까지).
 */
export interface PrStatusAnswer extends PrStatusResult {
  repo: string;
  number: number;
  verdict: string;
  ignored: string[];
  failing: string[];
  noPrChecks: boolean;
  queued: boolean;
}

export interface TurnPrStatusDeps {
  /** 그 에이전트의 커뮤니티 서버로 REST 를 나른다(`community.forward`). */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  /** 러너가 relay 로 맡긴 턴 임대(`turnSecrets.lookup`). 없으면 null — 임대 없이는 서버에도 묻지 않는다. */
  lookupLease(runnerId: string, cause: string): MergeLease | null;
  log(line: string): void;
  ghPath: string;
  home: string;
  /** 머지와 같은 계정 고르기(`localMerge.ts::pickMergeGhUser`). */
  ghUserFor: TurnMergeDeps['ghUserFor'];
  /** 머지 길과 같은 Map(`PrGateDeps.firstSeen`). */
  firstSeen: Map<string, number>;
  exec?: Exec;
  now?: () => number;
}

export interface TurnPrStatus {
  /** `pr.status` 호출이면 답하고, 아니면 null(다음 가로채기로 넘긴다). */
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function isPrStatusCall(payload: unknown): payload is JsonRpcCall {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null && p.params.name === PR_STATUS_TOOL;
}

/** 인자는 `repo`·`number` 둘뿐 — 그 밖의 칸이 있으면 거절한다. 여기 모양은 서버에 물을 자격만 정하고, 읽을 저장소는 서버가 정한다. */
function argsOf(call: JsonRpcCall): { repo: string; number: number } | { error: string } {
  const a = call.params?.arguments;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return { error: 'arguments are required: repo, number' };
  const { repo, number, ...extra } = a as Record<string, unknown>;
  if (Object.keys(extra).length) return { error: `unknown arguments: ${Object.keys(extra).join(', ').slice(0, 100)}` };
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return { error: 'repo must be owner/name' };
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > 999_999_999) return { error: 'number must be a positive integer' };
  return { repo: repo.toLowerCase(), number };
}

const names = (xs: readonly string[]): string[] => xs.slice(0, 20).map((n) => oneLineText(n).slice(0, 80));

const MESSAGES: Record<PrStatusRefusal, string> = {
  bad_request: 'pr.status needs repo (owner/name) and a positive PR number',
  bad_repo: 'not a repository name',
  forbidden: 'pr.status is only answered through the harkroom operator',
  lease_invalid: 'the turn lease is not valid any more',
  not_granted: 'this agent has no repo.merge permission for that repository, so pr.status cannot read it',
  no_lease: 'pr.status is not available in this turn (no turn lease)',
  unavailable: 'the server could not be reached or gave no clear answer — pr.status refused (fail-closed)',
  no_gh_user: 'no GitHub account is set for this repository on this device — a person picks one in Settings › Agents › Permissions › PR merge',
  gh_user_not_logged_in: 'the GitHub account set for this repository is not logged in to gh on this device',
  gh_token_failed: 'could not get a gh token for the account set for this repository',
  no_repo_access: 'the GitHub account set for this repository cannot read it',
  gh_failed: 'gh could not read this pull request',
  pr_status_error: 'pr.status hit an internal error',
};

export function createTurnPrStatus(deps: TurnPrStatusDeps): TurnPrStatus {
  const exec = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const tokens = createGhTokens({ exec, ghPath: deps.ghPath, home: deps.home, ghUserFor: deps.ghUserFor });
  const gh = async (args: string[], env: Record<string, string>): Promise<ExecResult> => exec(deps.ghPath, args, env);
  const gate = createPrGate({ gh, now, firstSeen: deps.firstSeen });

  type Out = { ok: true; value: PrStatusAnswer } | { ok: false; value: { error: { code: PrStatusRefusal; message: string } } };
  const fail = (code: PrStatusRefusal, message = MESSAGES[code]): Out => ({ ok: false, value: { error: { code, message } } });

  /** ③ 서버 허락. 200·`allowed: true`·저장소 모양이 다 맞을 때만 그 저장소를 돌려준다 — 그 밖은 전부 거절이다. */
  const askServer = async (agentId: string, lease: MergeLease, repo: string, number: number): Promise<{ repo: string } | { code: PrStatusRefusal }> => {
    const res = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: PR_STATUS_CHECKS_PATH,
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, repo, number }), contentType: 'application/json',
    }).catch(() => null);
    if (!res || res.type !== 'http.response' || res.status === 0) return { code: 'unavailable' };
    let body: unknown = null;
    try { body = JSON.parse(res.body); } catch { /* 아래에서 거절 */ }
    if (res.status !== 200) {
      // 서버가 정한 거절 코드만 그대로 넘긴다. 5xx·모르는 코드·본문 없음은 「모름」이라 unavailable(fail-closed).
      const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
      return res.status >= 400 && res.status < 500 && typeof code === 'string' && SERVER_DENIALS.has(code) ? { code: code as PrStatusDenial } : { code: 'unavailable' };
    }
    const ok = body as { allowed?: unknown; repo?: unknown } | null;
    if (!ok || ok.allowed !== true || typeof ok.repo !== 'string' || !REPO_RE.test(ok.repo)) return { code: 'unavailable' };
    return { repo: ok.repo.toLowerCase() };
  };

  const run = async (runnerId: string, agentId: string, req: RunnerLinkRequest & { type: 'mcp.request' }, call: JsonRpcCall): Promise<Out> => {
    const parsed = argsOf(call);
    if ('error' in parsed) return fail('bad_request', parsed.error);

    const lease = req.cause ? deps.lookupLease(runnerId, req.cause) : null;
    if (!lease || lease.agentId !== agentId) return fail('no_lease');

    const allowed = await askServer(agentId, lease, parsed.repo, parsed.number);
    if ('code' in allowed) {
      deps.log(`pr.status: ${parsed.repo}#${parsed.number} 거절 ${allowed.code} agent=${agentId}`);
      return fail(allowed.code);
    }
    // 여기서부터 저장소는 서버가 돌려준 것 하나만 쓴다.
    const { repo } = allowed;
    const { number } = parsed;

    // 문구는 고정 문장으로 — 토큰 실패의 stderr 는 싣지 않는다.
    const tok = await tokens.tokenFor(repo);
    if (!tok.ok) return fail(tok.code);

    const seen = await gate.inspect(repo, number, ghEnv(deps.home, tok.token));
    if (!seen.ok) {
      const access = 'stderr' in seen.viewError && isRepoAccessError(seen.viewError.stderr);
      deps.log(`pr.status: ${repo}#${number} gh pr view 실패(${access ? 'no_repo_access' : 'gh_failed'}) agent=${agentId}`);
      return fail(access ? 'no_repo_access' : 'gh_failed');
    }
    const picked = pickPrStatus(seen.pr);
    if (!picked) return fail('gh_failed');
    const queued = seen.queue?.inQueue === true;
    return {
      ok: true,
      value: {
        repo, number, ...picked,
        verdict: seen.verdict ? (seen.verdict.why?.code ?? 'ok') : queued ? 'queued' : 'unknown',
        ignored: names(seen.verdict?.ignored ?? []),
        failing: names(seen.verdict?.failing ?? []),
        noPrChecks: seen.noPrChecks,
        queued,
      },
    };
  };

  return {
    async maybeHandle(runnerId, agentId, req) {
      if (req.type !== 'mcp.request' || !isPrStatusCall(req.payload)) return null;
      const call = req.payload;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse => ({
        type: 'mcp.response', id: req.id,
        messages: [{ jsonrpc: '2.0', id: call.id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } }],
      });
      try {
        const r = await run(runnerId, agentId, req, call);
        return reply(r.value, !r.ok);
      } catch (e) {
        deps.log(`pr.status: 실패 — ${e instanceof Error ? e.message : String(e)}`);
        return reply(fail('pr_status_error').value, true);
      }
    },
  };
}
