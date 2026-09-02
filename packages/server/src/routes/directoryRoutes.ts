import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export async function registerDirectoryRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/accounts', { preHandler: app.requireAccount }, async () => {
    const res = await pool.query(
      `select id, handle, display_name as "displayName", kind, is_admin as "isAdmin"
       from account where disabled_at is null order by handle`,
    );
    return { accounts: res.rows };
  });

  app.get('/dms', { preHandler: app.requireAccount }, async (req) => {
    const res = await pool.query(
      `select c.id, array_agg(m.account_id order by m.account_id) as "memberIds"
       from channel c
       join channel_member m on m.channel_id = c.id
       where c.kind = 'dm'
         and exists (select 1 from channel_member me where me.channel_id = c.id and me.account_id = $1)
       group by c.id
       order by c.created_at`,
      [req.account!.id],
    );
    return { dms: res.rows };
  });

  app.get('/leases', { preHandler: app.requireAccount }, async () => {
    const res = await pool.query(
      `select repo, path, actor_key_id as "actorKeyId", expires_at as "expiresAt"
       from active_lease where expires_at > now() order by repo, path`,
    );
    return { leases: res.rows };
  });
}
