import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AccountView } from '@murmur/shared';
import { hashToken } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest { account: AccountView | null }
  interface FastifyInstance {
    requireAccount: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ACCOUNT_COLS = `a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin"`;

export async function registerAuth(app: FastifyInstance, pool: Pool): Promise<void> {
  app.decorateRequest('account', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;
    const hash = hashToken(header.slice('Bearer '.length));
    const viaSession = await pool.query(
      `select ${ACCOUNT_COLS} from session s join account a on a.id = s.account_id
       where s.token_hash = $1 and s.expires_at > now()`, [hash]);
    if (viaSession.rowCount) { req.account = viaSession.rows[0]; return; }
    const viaPat = await pool.query(
      `select ${ACCOUNT_COLS} from pat p join account a on a.id = p.account_id
       where p.token_hash = $1 and p.revoked_at is null`, [hash]);
    if (viaPat.rowCount) req.account = viaPat.rows[0];
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
