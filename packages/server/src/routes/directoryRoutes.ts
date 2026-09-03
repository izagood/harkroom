import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export async function registerDirectoryRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/accounts', { preHandler: app.requireAccount }, async () => {
    const res = await pool.query(
      // 비활성 계정도 **준다.** 이 목록은 멘션 자동완성의 원천이면서 작성자 이름을 푸는
      // 표이기도 하다 — 빼면 비활성화한 에이전트의 과거 메시지가 작성자를 잃는다.
      // 자동완성 후보에서 빼는 것은 `disabled` 를 보는 화면의 몫이다.
      // ownerAccountId(#181) 도 함께 반환한다 — 에이전트에만 값이 있다.
      `select a.id, a.handle, a.display_name as "displayName", a.kind, a.is_admin as "isAdmin",
              a.disabled_at is not null as disabled,
              a.status, a.status_text as "statusText",
              -- 아바타는 id 만 싣는다(#159) — 바이트를 실으면 디렉터리 한 번에 모든 사진이
              -- 따라온다. 화면이 이 id 로 아바타를 따로 받아 온다.
              a.avatar_attachment_id as "avatarAttachmentId",
              c.owner_account_id as "ownerAccountId"
       from account a left join agent_config c on c.account_id = a.id
       order by a.handle`,
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
