import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AccountView } from '@murmur/shared';
import { hashToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountView | null;
    /** 이 요청을 인증한 자격증명의 해시. WS 티켓이 운반해 소켓 수명을 자격증명에 묶는다. */
    credentialHash: string | null;
  }
  interface FastifyInstance {
    requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOwnerOrAdmin: (paramName: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// 상태는 여기서 함께 읽는다 — `/auth/me` 가 `req.account` 를 그대로 돌려주므로,
// 빠뜨리면 내가 방금 정한 상태가 내 화면에만 안 보인다.
const ACCOUNT_COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  a.status, a.status_text as "statusText", a.avatar_attachment_id as "avatarAttachmentId"`;

export async function registerAuth(app: FastifyInstance, pool: Pool): Promise<void> {
  app.decorateRequest('account', null);
  app.decorateRequest('credentialHash', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const hash = hashToken(header.slice('Bearer '.length));
    const viaSession = await pool.query(
      `select ${ACCOUNT_COLS} from session s join account a on a.id = s.account_id
       where s.token_hash = $1 and s.expires_at > now()`, [hash]);
    if (viaSession.rowCount) { req.account = viaSession.rows[0]; req.credentialHash = hash; return; }
    const viaPat = await pool.query(
      `select ${ACCOUNT_COLS} from pat p join account a on a.id = p.account_id
       where p.token_hash = $1 and p.revoked_at is null`, [hash]);
    if (viaPat.rowCount) { req.account = viaPat.rows[0]; req.credentialHash = hash; }
  });

  app.decorate('requireAccount', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
    }
  });

  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account?.isAdmin) {
      await reply.code(403).send({ error: { code: 'forbidden', message: 'admin required' } });
    }
  });

  app.decorate('requireOwnerOrAdmin', (paramName: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.account) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
      return;
    }

    // 어느 파라미터가 대상 에이전트인지는 라우트마다 다르다(`:id` 인 곳과 `:agentId` 인
    // 곳이 있다) — 그래서 술어가 이름을 인자로 받는다.
    const paramValue = (req.params as Record<string, string>)[paramName];
    if (!paramValue) {
      await reply.code(400).send({ error: { code: 'bad_request', message: `param '${paramName}' not found` } });
      return;
    }

    const verdict = await checkOwnerOrAdmin(pool, req.account, paramValue);
    if (!verdict.ok) {
      await reply.code(verdict.status).send({ error: { code: verdict.code, message: verdict.message } });
    }
  });
}

/** 인가 판정 결과. 거절은 그대로 응답이 되도록 상태·코드·문구를 함께 들고 온다. */
export type OwnerVerdict =
  | { ok: true }
  | { ok: false; status: 403; code: 'forbidden'; message: string }
  | { ok: false; status: 404; code: 'not_found'; message: string };

/**
 * 소유자 기반 인가 술어 — **이 파일에 하나만 둔다**(#253).
 *
 * `requireOwnerOrAdmin` preHandler 와, 필드별로 게이트가 갈려서 preHandler 로는 표현할 수
 * 없는 `PATCH /accounts/agents/:id` 가 **같은 이 함수**를 부른다. 판정을 두 곳에 복사하면
 * 한쪽만 고치는 사고가 난다 — 인가에서 그것은 조용히 열리는 쪽으로 어긋난다.
 *
 * 판정: 요청자가 admin 이거나, 대상 에이전트의 `agent_config.owner_account_id` 와 같다.
 *
 * **소유자가 없는 에이전트(`null`)는 admin 만이다.** 마이그레이션 `008` 이 기존 에이전트에
 * backfill 을 넣지 않은 것은 의도였다 — 그래서 `null` 은 "아무나"가 아니라 "아직 아무도"다.
 * `null` 을 "일치"로 읽으면 소유자를 지정하지 않은 모든 에이전트의 PAT 가 워크스페이스
 * 전체에 열린다. 아래 분기를 **명시적으로** 두는 이유가 이것이다: 이어지는 `!==` 비교도
 * 지금은 `null` 을 걸러 내지만, 그 비교가 언젠가 느슨해지거나(`==`, `?? ''`) 요청자 쪽
 * 값이 비게 되면 조용히 통과한다. 판정의 근거를 비교의 부산물로 두지 않는다.
 */
export async function checkOwnerOrAdmin(
  pool: Pool,
  account: AccountView,
  agentAccountId: string,
): Promise<OwnerVerdict> {
  if (account.isAdmin) return { ok: true };

  // `left join` 이라 계정은 있는데 agent_config 가 없는 경우(사람 계정)도 한 행으로 온다 —
  // 그때 owner_account_id 는 null 이고, 아래 null 분기가 admin 만으로 좁힌다.
  const res = await pool.query<{ owner_account_id: string | null }>(
    `select c.owner_account_id from account a left join agent_config c on c.account_id = a.id where a.id = $1`,
    [agentAccountId],
  );
  if (!res.rowCount) {
    return { ok: false, status: 404, code: 'not_found', message: 'no such agent' };
  }

  const ownerAccountId = res.rows[0]!.owner_account_id;
  if (ownerAccountId === null) {
    return { ok: false, status: 403, code: 'forbidden', message: 'owner required — this agent has no owner' };
  }
  if (ownerAccountId !== account.id) {
    return { ok: false, status: 403, code: 'forbidden', message: 'owner or admin required' };
  }
  return { ok: true };
}
