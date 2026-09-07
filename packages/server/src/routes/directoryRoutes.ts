import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listHandleGroups } from '../services/handleGroups.js';

export async function registerDirectoryRoutes(
  app: FastifyInstance,
  pool: Pool,
  /**
   * 투영이 지금 보고 있는 avcs 서버. `active_lease` 가 (repo, avcs_base_url)로 키가
   * 잡히므로, 이 값 없이 전체를 긁으면 예전에 붙었던 다른 서버의 낡은 리스가 현재
   * 활성 작업으로 섞여 나온다 — `#267`·`#488` 이 닫은 결함이 다른 모양으로 돌아오는
   * 셈이다.
   */
  projection?: { currentUrl(): string | null },
): Promise<void> {
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
    // 집합 목록은 `listHandleGroups` 하나가 낸다(#285). 여기에 질의 사본을 두면 서버가
    // 집합 행에 필드를 하나 더할 때(구성원 수가 그것이었다) 이쪽만 낡아, 같은 `groups` 를
    // 두 라우트가 **다른 모양**으로 주게 된다 — 화면은 어느 쪽을 받았는지 모른다.
    const groups = await listHandleGroups(pool);
    return { accounts: res.rows, groups };
  });

  app.get('/dms', { preHandler: app.requireAccount }, async (req) => {
    const res = await pool.query(
      /**
       * `lastMessageAt` 을 함께 낸다 — 정본 문서 `docs/desktop-rail.html` 2단계가
       * `DIRECT MESSAGES` 와 `AGENTS` 를 **"최근순 한 목록"** 으로 합치라고 했고,
       * 그 "최근"의 근거가 이 응답에 없었다.
       *
       * **`order by c.created_at` 이었다.** 그것은 DM 이 **만들어진** 순서다 — 반년 전에
       * 열고 오늘 대화한 DM 이 어제 열고 안 쓴 DM 보다 아래에 선다. 정렬만 여기서
       * 바꾸는 것으로는 부족했다: 화면은 `message.created` 를 실시간으로 받아
       * (`controller.ts` 의 `handleEvent`) 목록을 **다시 세워야** 하는데, 서버가 순서만
       * 주고 근거를 안 주면 화면이 그 순간 비교할 값이 없다. 그래서 **시각 자체**를 싣고
       * 정렬은 여기서도 하되(첫 화면이 바로 맞다) 최종 판단은 화면이 한다.
       *
       * **왜 마지막 메시지 시각인가**(마지막 읽음이 아니라): 마지막 읽음은 **내가 어디까지
       * 봤는가**이고 대화가 언제 오갔는가와 다른 사실이다. 그것으로 정렬하면 아직 안 열어
       * 본 DM — 즉 **가장 새 말이 와 있는 DM** — 이 목록 맨 아래로 가라앉는다. 문서가
       * 원한 "최근순"의 반대다.
       *
       * **`max(seq)` 가 아니라 `max(created_at)` 인 이유**: `seq` 는 채널 안에서만 단조
       * 증가하는 값이라(`001_init.sql` 의 identity) **채널끼리 비교할 수 없다**. 스레드
       * 상태(`messages.ts` 의 `THREAD_STATE_FACTS`)가 `seq` 로 마지막 말을 고르는 것은
       * 한 채널 안의 순서를 정하는 일이라 다르다. 여기서는 `THREAD_STATS` 가 답글의
       * 마지막 시각을 `MAX(created_at)` 로 내는 것과 같은 모양을 쓴다.
       *
       * **삭제된 메시지는 세지 않는다**(`deleted_at is null`). 지운 말로 DM 이 위로 올라오면
       * 목록이 "여기 새 말이 있다"고 말하는데 열어 보면 아무것도 없다.
       *
       * **말이 하나도 없는 DM 은 `null` 이다** — `c.created_at` 으로 채우지 않는다. 그것은
       * '대화한 적 없다'를 '그때 대화했다'로 바꿔 쓰는 거짓이고, 화면이 두 경우를 달리
       * 다루고 싶어도(예: 갓 만든 빈 DM 을 맨 위에 두기) 구분할 수가 없어진다.
       * 정렬에서 빈 DM 을 어디에 둘지는 화면의 몫이다 — 여기서는 `nulls last` 로 첫
       * 화면의 기본만 정한다.
       */
      `select c.id,
              array_agg(m.account_id order by m.account_id) as "memberIds",
              (select max(msg.created_at)::text from message msg
                where msg.channel_id = c.id and msg.deleted_at is null) as "lastMessageAt"
       from channel c
       join channel_member m on m.channel_id = c.id
       where c.kind = 'dm'
         and exists (select 1 from channel_member me where me.channel_id = c.id and me.account_id = $1)
       group by c.id
       order by "lastMessageAt" desc nulls last, c.created_at desc`,
      [req.account!.id],
    );
    return { dms: res.rows };
  });

  app.get('/leases', { preHandler: app.requireAccount }, async () => {
    const currentUrl = projection?.currentUrl() ?? null;
    // 투영이 꺼져 있으면(워커가 없거나 이 표면 자체가 없으면) "지금 잡혀 있는 리스"도
    // 없다 — 보고 있는 서버가 없는데 리스만 남아 있다고 답하면 화면은 실제로는 아무도
    // 갱신하지 않는 리스를 여전히 활성으로 그린다. `DISABLED_PROJECTION_STATUS` 와 같은
    // 논리다.
    if (currentUrl === null) return { leases: [] };
    const res = await pool.query(
      `select repo, path, actor_key_id as "actorKeyId", expires_at as "expiresAt"
       from active_lease where expires_at > now() and avcs_base_url = $1 order by repo, path`,
      [currentUrl],
    );
    return { leases: res.rows };
  });
}
