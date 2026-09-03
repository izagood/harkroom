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
  }
}

// 상태는 여기서 함께 읽는다 — `/auth/me` 가 `req.account` 를 그대로 돌려주므로,
// 빠뜨리면 내가 방금 정한 상태가 내 화면에만 안 보인다.
const ACCOUNT_COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
  a.status, a.status_text as "statusText"`;

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
}
