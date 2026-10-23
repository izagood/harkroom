// 에이전트의 머지 계정 줄(D1) — 그 에이전트를 도는 오퍼레이터가 알린 gh 이름·저장소별 계정 줄. 이름뿐이다(토큰·이메일 없음).
//
// **사람 세션만, 그 에이전트의 소유자만** 받는다(머지 카드 grant 와 같은 판정). 소유자가 아니면 그런 에이전트가 있는지도
// 말하지 않는다 — 404.
//
// D3: 같은 소유자가 다른 기기에서 줄 하나를 고친다(`PUT .../lines`). 서버는 줄을 직접 정하지 않는다 — 그 에이전트를 도는
// 오퍼레이터에 `gh.lines.set` 을 보내고, 오퍼레이터가 로컬에서 고를 때와 같은 길로 적은 뒤 답한다. 이름은 그 오퍼레이터가
// 마지막으로 알린 로그인 가운데 하나여야 한다(아무 이름이나 적는 자리가 되지 않게) — 오퍼레이터가 그 순간의 gh 로 다시 잰다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { repoGrantScope } from '@harkroom/shared';
import { GH_LOGIN_RE } from '@harkroom/shared/daemonProtocol';
import { parseGhLinesResult, type GhLinesRefusal } from '@harkroom/shared/operatorProtocol';
import { mergeAccountsOf } from '../services/operatorGhReport.js';
import { actorOf, recordAudit } from '../audit.js';
import type { OperatorHub } from '../ws/operatorHub.js';

const params = z.object({ id: z.string().uuid() });
const lineBody = z.object({ scope: z.string().max(220), ghUser: z.string().nullable() });
/** 오퍼레이터의 답을 기다리는 기본 시간 — 사람이 화면에서 누르고 기다리는 자리다. */
const GH_LINES_TIMEOUT_MS = 10_000;

type LineOutcome = { ok: true } | { ok: false; code: GhLinesRefusal | 'operator_unreachable' };

export async function registerMergeAccountRoutes(
  app: FastifyInstance, pool: Pool,
  deps: { operatorHub: Pick<OperatorHub, 'send' | 'onFrame'>; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? GH_LINES_TIMEOUT_MS;
  // requestId → 기다리는 요청. 답은 **보낸 그 오퍼레이터**에게서 온 것만 받는다.
  const pending = new Map<string, { operatorId: string; resolve: (o: LineOutcome) => void }>();
  const offResult = deps.operatorHub.onFrame((operatorId, frame) => {
    if (frame.type !== 'gh.lines.result') return;
    const r = parseGhLinesResult(frame);
    if (!r) return;
    const wait = pending.get(r.requestId);
    if (!wait || wait.operatorId !== operatorId) return;
    pending.delete(r.requestId);
    wait.resolve(r.ok ? { ok: true } : { ok: false, code: r.code });
  });
  app.addHook('onClose', async () => {
    offResult();
    for (const w of pending.values()) w.resolve({ ok: false, code: 'operator_unreachable' });
    pending.clear();
  });

  /** 사람 세션 + 그 에이전트의 소유자. 아니면 null(라우트가 404). */
  const ownerOk = async (req: { account?: { id: string; kind: string } | null; authVia?: string | null }, agentId: string): Promise<boolean> => {
    if (req.account?.kind !== 'human' || req.authVia !== 'session') return false;
    const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [agentId, req.account.id]);
    return (owner.rowCount ?? 0) > 0;
  };

  app.get<{ Params: { id: string } }>('/agents/:id/merge-accounts', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id must be a uuid' } });
    if (!(await ownerOk(req, p.data.id))) return reply.code(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    void reply.header('cache-control', 'no-store');
    return mergeAccountsOf(pool, p.data.id);
  });

  app.put<{ Params: { id: string } }>('/agents/:id/merge-accounts/lines', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id must be a uuid' } });
    if (!(await ownerOk(req, p.data.id))) return reply.code(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    const b = lineBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'scope 와 ghUser(지우려면 null)가 필요하다' } });
    // 로컬 앱과 같은 범위 규칙 — 정확한 `owner/name` 또는 조직 전체 `owner/*`.
    const scope = repoGrantScope(b.data.scope)?.slice('repo:'.length) ?? null;
    if (!scope) return reply.code(400).send({ error: { code: 'bad_scope', message: 'scope 는 owner/name 이나 owner/* 여야 한다' } });
    const ghUser = b.data.ghUser;
    if (ghUser !== null && !GH_LOGIN_RE.test(ghUser)) return reply.code(400).send({ error: { code: 'bad_request', message: 'ghUser 는 GitHub 로그인 이름이어야 한다' } });

    // 그 에이전트가 **지금 배정된** 오퍼레이터(이 커뮤니티의 배정, 폐기되지 않은 것)에만 보낸다.
    const accounts = await mergeAccountsOf(pool, p.data.id);
    const operatorId = accounts.operatorId;
    if (!operatorId) return reply.code(409).send({ error: { code: 'no_operator', message: '이 에이전트를 도는 오퍼레이터가 없다' } });
    if (ghUser !== null && !(accounts.report?.logins ?? []).includes(ghUser)) {
      return reply.code(409).send({ error: { code: 'unknown_login', message: '그 오퍼레이터가 알린 gh 로그인이 아니다' } });
    }

    const requestId = randomUUID();
    const outcome = await new Promise<LineOutcome>((resolve) => {
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, code: 'operator_unreachable' }); }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { operatorId, resolve: (o) => { clearTimeout(timer); resolve(o); } });
      if (!deps.operatorHub.send(operatorId, { type: 'gh.lines.set', requestId, scope, ghUser })) {
        pending.delete(requestId); clearTimeout(timer);
        resolve({ ok: false, code: 'operator_unreachable' });
      }
    });

    await recordAudit(pool, {
      action: 'operator.merge_line.set_remote', ...actorOf(req), target: operatorId,
      detail: { operatorId, agentId: p.data.id, scope, ghUser, by: req.account!.id, outcome: outcome.ok ? 'ok' : outcome.code },
    }, req);
    if (!outcome.ok) {
      if (outcome.code === 'operator_unreachable') {
        return reply.code(504).send({ error: { code: 'operator_unreachable', message: '오퍼레이터가 답하지 않았다' } });
      }
      return reply.code(409).send({ error: { code: outcome.code, message: '오퍼레이터가 줄을 고치지 않았다' } });
    }
    // 저장된 보고에 바로 반영한다 — 오퍼레이터가 곧 다시 내는 보고가 이 값을 덮는다(그쪽이 참이다).
    await pool.query(
      `update operator_gh_report
          set by_scope = case when $3::text is null then coalesce(by_scope, '{}'::jsonb) - $2::text
                              else coalesce(by_scope, '{}'::jsonb) || jsonb_build_object($2::text, $3::text) end
        where operator_id = $1`,
      [operatorId, scope, ghUser]);
    return { ok: true };
  });
}
