import type { Pool, PoolClient } from 'pg';
import type { ChannelMemberRow, ChannelRow } from '@murmur/shared';

const COLS = `id, name, topic, kind, repo, archived_at as "archivedAt", visibility`;

/**
 * 채널 가시성 술어 — **이 저장소에서 가시성을 판정하는 유일한 정의다.**
 *
 * 표준 채널이 무조건 보이던 시절에는 그 전제가 여덟 자리에 흩어져 있었다: 목록·미읽음
 * 배지·검색·읽기 게이트·쓰기 게이트·이벤트 수신자, 그리고 avcs 투영 두 곳. `visibility`
 * 가 생기면 그 여덟 자리가 전부 분기점이 되므로, 술어를 복사하면 여덟 벌이 된다.
 *
 * 이 저장소는 정확히 그 사고를 이미 겪었다 — 아래 `audienceFor` 의 주석이 기록한다:
 * 같은 수신자 계산이 두 표면에 각각 있어서 한쪽만 고쳐 DM 내용이 샜다. 그래서 문자열
 * 조각 하나로 두고 모든 질의가 **같은 것을 참조**하게 한다. 한쪽만 고치는 일이 구조적으로
 * 불가능해진다.
 *
 * DM 을 따로 다루지 않는 것이 핵심이다. `kind = 'dm'` 은 언제나 `visibility` 기본값
 * 'public' 을 갖지만 첫 절의 `kind = 'standard'` 에 걸려 떨어지고, 두 번째 절(멤버십)로만
 * 통과한다 — 즉 DM 은 지금까지와 똑같이 멤버만 본다. private 채널도 **같은
 * `channel_member` 테이블**을 쓴다. 테이블을 둘로 나누면 가시성 계산이 다시 갈라진다.
 *
 * @param channel 질의 안에서 `channel` 테이블을 가리키는 별칭
 * @param accountParam 보는 사람의 계정 id 를 담은 바인드 파라미터 (예: `'$1'`)
 */
export function channelVisibleSql(channel: string, accountParam: string): string {
  return `((${channel}.kind = 'standard' and ${channel}.visibility = 'public')
     or exists (select 1 from channel_member cm_vis
                 where cm_vis.channel_id = ${channel}.id and cm_vis.account_id = ${accountParam}))`;
}

/**
 * `pool` 이 `PoolClient` 도 받는 이유: 부트스트랩이 계정과 기본 채널을 한 트랜잭션에 묶는다
 * (`authRoutes.ts`). 그 트랜잭션의 커넥션으로 불러야 begin/commit 이 실제로 이 INSERT 를
 * 덮는다 — Pool 로 부르면 다른 커넥션의 별개 자동커밋이 된다.
 */
export async function createChannel(
  pool: Pool | PoolClient,
  input: {
    name: string; topic?: string; repo?: string | null;
    visibility?: 'public' | 'private';
    /** private 채널의 첫 멤버. public 에서는 쓰지 않는다. */
    creatorId?: string;
  },
): Promise<ChannelRow> {
  const visibility = input.visibility ?? 'public';
  const insert = async (q: Pool | PoolClient): Promise<ChannelRow> => {
    const res = await q.query(
      `insert into channel (name, topic, kind, repo, visibility)
       values ($1, $2, 'standard', $3, $4) returning ${COLS}`,
      [input.name, input.topic ?? '', input.repo ?? null, visibility],
    );
    const row = res.rows[0] as ChannelRow;
    // 멤버가 0 인 private 채널은 **아무도 열 수 없는 채널**이다 — 만든 사람조차 목록에서
    // 보지 못하고, admin 만 이름을 볼 수 있는 유령이 된다. 그래서 만든 사람이 첫 멤버다.
    if (visibility === 'private') {
      if (!input.creatorId) throw new Error('private channel requires creatorId');
      await q.query(
        `insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`,
        [row.id, input.creatorId],
      );
    }
    return row;
  };
  // 채널 행과 첫 멤버는 **함께** 커밋되어야 한다(둘 사이에서 끊기면 위의 유령이 생긴다).
  // 이미 트랜잭션 안이면(부트스트랩이 `PoolClient` 를 넘긴다) 그 트랜잭션을 그대로 쓴다 —
  // 여기서 새 커넥션을 잡으면 바깥 begin/commit 이 이 INSERT 를 덮지 못한다.
  if (visibility === 'public' || 'release' in pool) return insert(pool);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const row = await insert(client);
    await client.query('commit');
    return row;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 지정된 필드만 갱신한다. `repo: null`은 "바인딩 해제"이고, 키 자체가 없으면 "손대지 않음"이다 —
 *  둘을 구분하지 못하면 topic만 고치려다 avcs 바인딩이 조용히 끊긴다.
 * archived 는 archived_at 과 archived_by 를 함께 갱신한다 — archived_at = now() / null,
 * archived_by = actorId / null.
 * visibility 도 같은 규칙이다 — 키가 없으면 손대지 않는다. 여기서 public 을 기본값으로
 * 흘리면 admin 이 topic 만 고칠 때 private 채널이 조용히 전원에게 열린다. */
export async function updateChannel(
  pool: Pool, id: string, actorId: string,
  patch: { topic?: string; repo?: string | null; archived?: boolean; visibility?: 'public' | 'private' },
): Promise<ChannelRow | null> {
  const hasArchived = patch.archived !== undefined;
  const res = await pool.query(
    `update channel set
       topic = case when $2::bool then $3::text else topic end,
       repo  = case when $4::bool then $5::text else repo  end,
       archived_at = case when $6 is true then now() when $6 is false then null else archived_at end,
       archived_by = case when $6 is true then $7::uuid when $6 is false then null else archived_by end,
       visibility = case when $8::bool then $9::text else visibility end
     where id = $1 and kind = 'standard'
     returning ${COLS}`,
    [
      id,
      patch.topic !== undefined, patch.topic ?? null,
      patch.repo !== undefined, patch.repo ?? null,
      hasArchived ? patch.archived : null, patch.archived ? actorId : null,
      patch.visibility !== undefined, patch.visibility ?? null,
    ],
  );
  return res.rowCount ? res.rows[0] : null;
}

/**
 * 사이드바 목록. **계정을 받는다** — 채널의 존재 자체가 계정마다 다르기 때문이다(#182).
 *
 * admin 예외(`isAdmin`)를 여기에만 두는 이유: 운영(채널 정리·보관·이름 확인)은 가능해야
 * 하지만 private 의 뜻은 지켜져야 한다. 그래서 admin 은 **목록에서는 보되 메시지는 못
 * 본다** — 읽기·쓰기 게이트(`assertChannelVisible`, `channelPostGate`)에는 이 예외가
 * 없다. `MessageItem.tsx` 가 "삭제는 admin 에게 열고 수정은 안 연다"고 한 것과 같은 결의
 * 절충이다: 조정 수단은 주되, 남의 대화 내용을 읽을 권한은 주지 않는다.
 */
export async function listChannels(pool: Pool, accountId: string, isAdmin = false): Promise<ChannelRow[]> {
  const res = await pool.query(
    `select ${COLS} from channel c
     where c.kind = 'standard' and ($2::bool or ${channelVisibleSql('c', '$1')})
     order by name`,
    [accountId, isAdmin],
  );
  return res.rows;
}

export async function getOrCreateDm(pool: Pool, accountIds: string[]): Promise<ChannelRow> {
  const members = [...new Set(accountIds)].sort();
  const existing = await pool.query(
    `select c.id from channel c
     join channel_member m on m.channel_id = c.id
     where c.kind = 'dm'
     group by c.id
     having array_agg(m.account_id order by m.account_id) = $1::uuid[]`,
    [members],
  );
  if (existing.rowCount) {
    const res = await pool.query(`select ${COLS} from channel where id = $1`, [existing.rows[0].id]);
    return res.rows[0];
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const created = await client.query(
      `insert into channel (kind, topic) values ('dm', '') returning ${COLS}`,
    );
    for (const id of members) {
      await client.query(`insert into channel_member (channel_id, account_id) values ($1, $2)`, [created.rows[0].id, id]);
    }
    await client.query('commit');
    return created.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * avcs 투영 대상. **멤버십 게이트를 통과하지 않는다** — 이건 사람의 조회가 아니라 서버가
 * 이벤트를 어디에 쓸지 고르는 일이고, 서버에는 '보는 계정'이 없다.
 *
 * 그래도 새지 않는 이유: 투영이 private 채널에 글을 쓰면 그 메시지를 읽는 사람은 여전히
 * **그 채널의 멤버뿐**이다(읽기 게이트가 같은 술어를 본다). 즉 투영은 되고, 보이는 사람이
 * 제한된다. 여기에 가시성 술어를 넣으면 반대로 private 채널만 avcs 갱신을 조용히 놓친다.
 */
export async function listBoundRepos(pool: Pool): Promise<{ repo: string; channelId: string }[]> {
  const res = await pool.query(
    `select repo, id as "channelId" from channel where repo is not null and kind = 'standard'`,
  );
  return res.rows;
}

/**
 * 이 채널의 멤버 id. DM 과 private 채널이 **같은 테이블**을 쓰므로 함수도 하나다 — 예전
 * 이름은 `dmMemberIds` 였는데, 그 이름을 남겨 두면 private 채널에 쓸 때 "이건 DM 전용
 * 아닌가" 하고 두 번째 함수를 만들게 된다.
 */
export async function channelMemberIds(pool: Pool, channelId: string): Promise<string[]> {
  const res = await pool.query(`select account_id from channel_member where channel_id = $1`, [channelId]);
  return res.rows.map((r) => r.account_id);
}

/** 멤버 목록 화면용. handle 을 함께 준다 — 화면이 계정 목록을 따로 받아 맞출 필요가 없다. */
export async function listChannelMembers(pool: Pool, channelId: string): Promise<ChannelMemberRow[]> {
  const res = await pool.query(
    `select m.account_id as "accountId", a.handle
     from channel_member m join account a on a.id = m.account_id
     where m.channel_id = $1 order by a.handle`,
    [channelId],
  );
  return res.rows;
}

export async function isChannelMember(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `select 1 from channel_member where channel_id = $1 and account_id = $2`, [channelId, accountId],
  );
  return Boolean(res.rowCount);
}

/** 이미 멤버면 아무 일도 하지 않는다 — 초대를 두 번 눌렀다고 실패로 보이면 안 된다. */
export async function addChannelMember(pool: Pool, channelId: string, accountId: string): Promise<void> {
  await pool.query(
    `insert into channel_member (channel_id, account_id) values ($1, $2) on conflict do nothing`,
    [channelId, accountId],
  );
}

/**
 * 나가기/내보내기. **마지막 멤버가 나가도 채널 행은 남는다** — 삭제는 캐스케이드 결정이
 * 필요한 별개 문제다(#155). 남은 채널은 admin 만 목록에서 보는 상태가 된다.
 */
export async function removeChannelMember(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `delete from channel_member where channel_id = $1 and account_id = $2`, [channelId, accountId],
  );
  return Boolean(res.rowCount);
}

// dm 채널은 멤버만 읽고 쓸 수 있다. standard 채널(또는 존재하지 않는 채널 id — 이후
// 단계에서 별도로 실패한다)은 항상 visible로 취급한다.
//
// #182 이후 "standard 는 항상 visible" 은 **public standard 에만** 해당한다. 판정은
// `channelVisibleSql` 하나가 하고, 이 함수는 그것을 채널 하나에 대해 물을 뿐이다.
// admin 예외는 여기에 **없다** — 목록에서 보는 것과 내용을 읽는 것은 다른 권한이다.
export async function assertChannelVisible(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const res = await pool.query(
    `select ${channelVisibleSql('c', '$2')} as visible from channel c where c.id = $1`,
    [channelId, accountId],
  );
  // 존재하지 않는 채널 id 는 여기서 막지 않는다 — 위 주석대로 이후 단계가 404 로 답한다.
  if (!res.rowCount) return true;
  return Boolean(res.rows[0].visible);
}

/**
 * 이 채널의 이벤트를 누가 받아야 하는가. DM 은 멤버만, 그 외는 전원이다.
 *
 * 한 곳에 모으는 이유: 같은 계산이 REST 라우트(messageRoutes 의 지역 함수)와 MCP 플러그인
 * (인라인)에 각각 있었다. 이벤트 수신자 판정이 두 표면에서 갈리면 한쪽만 고쳐서 DM 내용이
 * 새거나(넓게 잡음) 실시간 갱신이 안 되는(좁게 잡음) 사고가 난다.
 */
export async function audienceFor(pool: Pool, channelId: string): Promise<'all' | string[]> {
  const channel = await pool.query(`select kind, visibility from channel where id = $1`, [channelId]);
  const row = channel.rows[0] as { kind: string; visibility: string } | undefined;
  // 존재하지 않는 채널 id 는 예전과 같이 'all' 이다 — 그런 채널의 이벤트는 애초에 생기지 않는다.
  if (!row) return 'all';
  // 여기 조건은 `channelVisibleSql` 의 첫 절과 **같은 것**이어야 한다: public standard 면
  // 전원, 그 밖(DM 과 private)은 멤버만. 한쪽만 넓히면 private 채널의 발화가 비멤버의
  // 화면에 실시간으로 뜬다 — 목록에 없는 채널의 메시지가 흘러드는 형태로.
  if (row.kind === 'standard' && row.visibility === 'public') return 'all';
  return channelMemberIds(pool, channelId);
}

export interface ChannelPrefRow {
  accountId: string;
  channelId: string;
  mutedAt: string | null;
  starredAt: string | null;
}

export async function updateChannelPref(
  pool: Pool, accountId: string, channelId: string, patch: { muted?: boolean; starred?: boolean },
): Promise<ChannelPrefRow | null> {
  const channel = await pool.query(`select id from channel where id = $1`, [channelId]);
  if (!channel.rowCount) return null;

  if (patch.muted !== undefined) {
    await pool.query(
      `insert into channel_pref (account_id, channel_id, muted_at)
       values ($1, $2, $3)
       on conflict (account_id, channel_id) do update set muted_at = $3`,
      [accountId, channelId, patch.muted ? new Date() : null],
    );
  }
  if (patch.starred !== undefined) {
    await pool.query(
      `insert into channel_pref (account_id, channel_id, starred_at)
       values ($1, $2, $3)
       on conflict (account_id, channel_id) do update set starred_at = $3`,
      [accountId, channelId, patch.starred ? new Date() : null],
    );
  }
  return getChannelPref(pool, accountId, channelId);
}

export async function getChannelPref(
  pool: Pool, accountId: string, channelId: string,
): Promise<ChannelPrefRow | null> {
  const res = await pool.query(
    `select account_id as "accountId", channel_id as "channelId", muted_at as "mutedAt", starred_at as "starredAt"
     from channel_pref where account_id = $1 and channel_id = $2`,
    [accountId, channelId],
  );
  return res.rows[0] ?? null;
}

export async function listChannelPrefs(pool: Pool, accountId: string): Promise<ChannelPrefRow[]> {
  const res = await pool.query(
    `select account_id as "accountId", channel_id as "channelId", muted_at as "mutedAt", starred_at as "starredAt"
     from channel_pref where account_id = $1`,
    [accountId],
  );
  return res.rows;
}

/**
 * 글을 쓸 수 있는가 — 가시성과 보관 여부를 **한 질의로** 함께 본다.
 *
 * 둘을 따로 물으면 메시지 POST 한 번에 왕복이 하나 늘어난다. 이건 이 앱에서 가장 자주
 * 도는 경로이고, 보관 여부는 이미 읽고 있는 `channel` 행에 같이 들어 있다 — 같은 행을
 * 두 번 읽을 이유가 없다.
 *
 * 편집·삭제·리액션에는 쓰지 않는다. 보관된 채널에서도 잘못 올라간 것을 치울 수 있어야
 * 하고, 그 경로까지 닫으면 admin 에게 조정 수단이 없어진다.
 */
export async function channelPostGate(
  pool: Pool, channelId: string, accountId: string,
): Promise<'ok' | 'forbidden' | 'archived'> {
  const res = await pool.query(
    `select ${channelVisibleSql('c', '$2')} as visible,
            c.archived_at is not null as archived
     from channel c where c.id = $1`,
    [channelId, accountId],
  );
  const row = res.rows[0] as { visible: boolean; archived: boolean } | undefined;
  if (!row) return 'ok';
  // 쓰기 게이트도 읽기와 **같은 술어**를 본다. public 채널은 멤버가 아니어도 쓸 수 있고
  // (멤버십은 구독일 뿐이다), private 채널은 비멤버에게 403 이다 — admin 예외 없다.
  if (!row.visible) return 'forbidden';
  return row.archived ? 'archived' : 'ok';
}

/**
 * 보관된 표준 채널을 영구히 삭제한다(#155).
 *
 * 삭제 대상 테이블( channel_id 또는 message_id 로 참조하는 전부):
 *   - attachment (message_id 로 참조, on delete cascade)
 *   - message_reaction (message_id 로 참조, on delete cascade)
 *   - message_pin (channel_id 로 직접 참조)
 *   - channel_read (channel_id 로 직접 참조)
 *   - channel_member (channel_id 로 직접 참조)
 *   - channel_pref (channel_id 로 직접 참조, on delete cascade)
 *   - message (channel_id 로 직접 참조)
 *   - channel (자신)
 *
 * FK cascade 를 쓰지 않는 이유: cascade 를 스키마에 박으면 무엇이 함께 사라지는지가
 * 코드 어디에도 안 적혀서, 나중에 새 테이블이 channel_id 를 참조할 때 그 테이블도
 * 조용히 같이 지워진다. 이 함수가 명시적으로 지우는 순서와 대상을 적는 것이 이 작업의
 * 산출물이다.
 *
 * 계정 삭제(009_agent_disable.sql) 와 다른 이유: 계정은 남의 메시지에 작성자로 남지만,
 * 채널은 그 안의 것을 다 지우면 참조가 남지 않는다 — 계정은 soft delete 로
 * "비활성화"하고, 채널은 hard delete 로 "완전히 사라진다".
 *
 * 파일 삭제는 행 삭제 **이후**에 한다: 행을 먼저 지우면 파일 삭제가 실패해도 남는
 * 것이 고아 파일(나중에 GC 로 치울 수 있다)이고, 파일을 먼저 지우면 그 사이 읽는
 * 요청이 '깨진 첨부'를 본다. 파일 삭제 실패는 트랜잭션을 되돌리지 않는다 — 고아 파일은
 * 무해하고, 되돌리면 사람은 지웠다고 믿는데 채널이 살아 있다.
 *
 * @param storage 파일 삭제를 위한 스토리지 백엔드 (테스트용 mocking 가능)
 * @returns 삭제된 채널 정보와 지운 메시지·첨부 개수, 삭제할 파일 키 목록
 */
export async function deleteChannel(
  pool: Pool, channelId: string,
  storage?: { remove(key: string): Promise<void> },
): Promise<{ name: string; messageCount: number; attachmentCount: number; storageKeys: string[] } | 'not_archived' | 'not_found' | 'is_dm'> {
  const client = await pool.connect();
  try {
    // 채널 존재와 상태 확인 (트랜잭션 외부에서 먼저 확인)
    const channel = await pool.query(
      `select id, name, kind, archived_at from channel where id = $1`,
      [channelId],
    );
    if (!channel.rowCount) return 'not_found';
    const row = channel.rows[0] as { id: string; name: string; kind: string; archived_at: string | null };
    if (row.kind !== 'standard') return 'is_dm';
    if (!row.archived_at) return 'not_archived';

    // 삭제할 파일 키를 먼저 조회 (행 삭제 전에)
    const storageKeysResult = await pool.query(
      `select a.storage_key from attachment a
       join message m on m.id = a.message_id
       where m.channel_id = $1`,
      [channelId],
    );
    const storageKeys = storageKeysResult.rows.map((r) => r.storage_key);

    // 삭제 대상 개수 조회 (감사에 남기기 위함)
    const messageCountResult = await pool.query(
      `select count(*)::int as cnt from message where channel_id = $1`,
      [channelId],
    );
    const messageCount = messageCountResult.rows[0]!.cnt;

    const attachmentCount = storageKeys.length;

    // 트랜잭션 시작
    await client.query('begin');

    // 행 삭제 (파일보다 먼저 — 행을 먼저 지우면 파일 삭제가 실패해도 고아 파일만 남는다)
    // message_pin: channel_id 로 직접 참조
    await client.query(`delete from message_pin where channel_id = $1`, [channelId]);
    // channel_read: channel_id 로 직접 참조
    await client.query(`delete from channel_read where channel_id = $1`, [channelId]);
    // channel_member: channel_id 로 직접 참조
    await client.query(`delete from channel_member where channel_id = $1`, [channelId]);
    // channel_pref: channel_id 로 직접 참조, cascade 로도 되지만 명시적으로
    await client.query(`delete from channel_pref where channel_id = $1`, [channelId]);
    // message: channel_id 로 직접 참조 (attachment, message_reaction 은 cascade 로 함께 삭제)
    await client.query(`delete from message where channel_id = $1`, [channelId]);
    // channel: 마지막에 삭제
    await client.query(`delete from channel where id = $1`, [channelId]);

    await client.query('commit');

    // 트랜잭션 성공 후 파일 삭제 (실패해도 트랜잭션은 되돌리지 않음 — 고아 파일은 무해)
    if (storage && storageKeys.length > 0) {
      await Promise.allSettled(storageKeys.map((key) => storage.remove(key).catch(() => {})));
    }

    return { name: row.name ?? '', messageCount, attachmentCount, storageKeys };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
