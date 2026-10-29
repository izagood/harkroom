// 에이전트 권한 요청(111, 스레드 f61af808). 판정과 쓰기는 `services/permissionRequests.ts` 하나다.
//
// - 승인·거절·1회 승인(approve-once, 머지 거절에서 온 카드만): **사람 세션만**(에이전트 토큰은 물론 사람 PAT 도 403), 그리고 **그 에이전트의 소유자**만. admin 역할은 여기서
//   힘이 없다(merge-denial 의 C5 와 같다). 요청 본문은 읽지 않는다 — 범위·기한은 요청 줄과 서버 상수다.
// - `GET /agent/tool-allows`: 러너가 턴을 띄울 때 이 채널의 allow 규칙을 읽는다. 오퍼레이터를 거친 에이전트만, 자기 것만.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { readLease } from '../services/mergeGrants.js';
import { decide } from '../services/decisions.js';
import { commandGrantsFor, matchCommandGrant, toolAllowsFor, toolReachFor } from '../services/permissionRequests.js';
import { mayDecideFor } from '../services/deciders.js';

const params = z.object({ id: z.string().uuid(), requestId: z.string().uuid(), decision: z.enum(['approve', 'deny', 'approve-once', 'approve_once', 'approve_hour']) });
/** [이번 한 번 머지](스레드 1b75d7a0) — 받는 것은 gh 계정·CI 완화 둘뿐. 저장소·PR·head 는 요청에 묶인 거절 기록이다. */
// number·headSha 는 카드가 보여 준 값 — 대조에만 쓴다(security F1). 저장소·PR·head 의 출처는 여전히 거절 기록이다.
const onceBody = z.object({
  ghUser: z.string().min(1).max(39).nullable().optional(), relaxChecks: z.boolean().optional(),
  number: z.number().int().positive(), headSha: z.string().regex(/^[0-9a-f]{40}$/),
  // CI 거절 카드(스레드 1fccc9a5 n1): 사람이 본 실패 체크 목록 — 거절 기록과 다르면 card_stale. 대조에만 쓴다.
  failedChecks: z.array(z.string().max(200)).max(20).optional(),
}).strict();

export async function registerPermissionRequestRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post<{ Params: { id: string; requestId: string; decision: string } }>(
    '/agents/:id/permission-requests/:requestId/:decision', { preHandler: app.requireAccount }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id and request id must be uuids; decision is approve, approve-once (a merge refusal card), approve_once, approve_hour (an exact command) or deny' } });
      if (req.account!.kind !== 'human' || req.authVia !== 'session') {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'only a person signed in to the app can decide a permission request' } });
      }
      let once: { ghUser: string | null; relaxChecks: boolean; number: number; headSha: string; failedChecks?: string[] } | undefined;
      if (p.data.decision === 'approve-once') {
        const b = onceBody.safeParse(req.body ?? {});
        if (!b.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'number and a 40-hex headSha are required; ghUser is optional (null lets the operator pick); relaxChecks is a boolean; nothing else' } });
        once = { ghUser: b.data.ghUser ?? null, relaxChecks: b.data.relaxChecks ?? false, number: b.data.number, headSha: b.data.headSha, ...(b.data.failedChecks ? { failedChecks: b.data.failedChecks } : {}) };
      }
      const decision = p.data.decision === 'approve-once' ? 'approve_once' : p.data.decision;
      // 누가 정하나는 `decide` 가 요청 줄의 채널로 판정한다(`deciders.mayDecideFor` — 소유자 또는 그 채널에서 부를 수 있는 사람).
      // 남의 요청 id 는 채널을 못 찾아 소유자만 지나고, 그 소유자도 decidePermissionRequest 가 404 로 닫는다.
      const d = await decide(pool, { kind: 'permission', agentId: p.data.id, requestId: p.data.requestId, cardMessageId: null }, req.account!.id, {
        option: decision, via: 'button', ...(once ? { once } : {}),
      });
      if (d.kind !== 'permission') throw new Error('permission route resolved to an ask');
      if (!d.ok) return reply.code(d.status).send({ error: { code: d.code, message: d.message } });
      const r = d.result;
      return { status: r.status, grantExpiresAt: r.grantExpiresAt, ...(r.approvalExpiresAt ? { approvalExpiresAt: r.approvalExpiresAt } : {}), cardMessageId: r.cardMessageId, ...(r.grantMode ? { grantMode: r.grantMode } : {}) };
    });

  // 이 사람이 이 채널에서 이 에이전트의 권한·머지 카드를 정할 수 있나(소유자 결정 2026-10-29) — 화면이 버튼을 그릴지 정한다.
  // 카드 글은 모두가 같은 행을 보므로 보는 사람마다 다른 값은 카드에 싣지 않고 여기서 준다 — 같은 (에이전트, 채널)의 카드는 답이 같다.
  // `decideScope` 는 「누가 정하나」 문구용(designer 시안 v1 ②·③), 정할 수 없는 사람에게도 준다. 판정은 결정 때 `decide` 가 다시 한다.
  app.get<{ Params: { id: string }; Querystring: { channelId?: string } }>('/agents/:id/decide-check', { preHandler: app.requireAccount }, async (req, reply) => {
    const q = z.object({ id: z.string().uuid(), channelId: z.string().uuid() }).safeParse({ ...(req.params ?? {}), ...(req.query ?? {}) });
    if (!q.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id and channelId must be uuids' } });
    void reply.header('cache-control', 'no-store');
    const v = await mayDecideFor(pool, { agentId: q.data.id, actorId: req.account!.id, channelId: q.data.channelId });
    // 버튼을 누를 수 있는 것은 사람 세션뿐이다 — PAT·에이전트는 언제나 정할 수 없다고 답한다.
    const session = req.account!.kind === 'human' && req.authVia === 'session';
    return {
      viewerCanDecide: session && v.ok, asOwner: session && v.ok && v.asOwner,
      decideScope: v.decideScope, ownerAccountId: v.ownerAccountId,
    };
  });

  app.get<{ Querystring: { channelId?: string } }>('/agent/tool-allows', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const q = z.object({ channelId: z.string().uuid() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId (uuid) is required' } });
    void reply.header('cache-control', 'no-store');
    // `reach` 는 모든 채널의 합 — codex 턴의 명령 규칙 파일이 채널을 가리지 않아서다(`toolReachFor`).
    return { rules: await toolAllowsFor(pool, req.account!.id, q.data.channelId), reach: await toolReachFor(pool, req.account!.id) };
  });

  // 정확한 명령 grant(H②, 112). 오퍼레이터를 거친 에이전트만, 자기 것만. 목록은 읽기만, match 는 맞으면 그 grant 하나를 쓴다.
  const threadQuery = z.object({ channelId: z.string().uuid(), threadRootId: z.string().uuid() });
  app.get<{ Querystring: { channelId?: string; threadRootId?: string } }>('/agent/command-grants', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const q = threadQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId and threadRootId (uuids) are required' } });
    void reply.header('cache-control', 'no-store');
    return { grants: await commandGrantsFor(pool, req.account!.id, q.data.channelId, q.data.threadRootId) };
  });

  // match 는 채널·스레드를 **받지 않는다** — 턴 임대(leaseId·token, 러너가 relay 로 오퍼레이터에 맡긴 것)에서 서버가 읽는다.
  // 그래서 이 턴의 스레드에 승인된 것만 열리고, 다른 스레드의 grant 를 이름으로 끌어다 쓸 수 없다. 임대가 이 에이전트·이
  // 오퍼레이터의 것이 아니거나 끝났·만료면 열지 않는다(allow:false — hook 은 무출력으로 분류기에 넘긴다).
  const matchBody = z.object({
    leaseId: z.string().uuid(), token: z.string().min(1).max(200),
    command: z.string().min(1).max(2000), toolUseId: z.string().max(200).optional(),
    // 오퍼레이터가 지금 잰 파일 해시와 hook 입력의 cwd(H③a). 없으면 파일 있는 명령은 열리지 않는다.
    files: z.array(z.object({ path: z.string().min(1).max(1024), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).max(16).optional(),
    cwd: z.string().max(4096).optional(),
  });
  app.post<{ Body: unknown }>('/agent/command-grants/match', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const b = matchBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token and command are required' } });
    void reply.header('cache-control', 'no-store');
    const lease = await readLease(pool, { leaseId: b.data.leaseId, token: b.data.token, now: new Date() });
    if (!lease || lease.agentId !== req.account!.id || lease.operatorId !== req.operator.id || lease.expired || lease.ended) {
      return { allow: false, reason: 'lease_invalid' };
    }
    return matchCommandGrant(pool, {
      agentId: req.account!.id, channelId: lease.channelId, threadRootId: lease.threadRootId,
      command: b.data.command, toolUseId: b.data.toolUseId ?? null, files: b.data.files ?? [], cwd: b.data.cwd ?? null,
    });
  });
}

