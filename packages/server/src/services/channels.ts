import type { Pool, PoolClient } from 'pg';
import type { ChannelRow } from '@murmur/shared';

const COLS = `id, name, topic, kind, repo`;

/**
 * `pool` 이 `PoolClient` 도 받는 이유: 부트스트랩이 계정과 기본 채널을 한 트랜잭션에 묶는다
 * (`authRoutes.ts`). 그 트랜잭션의 커넥션으로 불러야 begin/commit 이 실제로 이 INSERT 를
 * 덮는다 — Pool 로 부르면 다른 커넥션의 별개 자동커밋이 된다.
 */
export async function createChannel(
  pool: Pool | PoolClient, input: { name: string; topic?: string; repo?: string | null },
): Promise<ChannelRow> {
  const res = await pool.query(
    `insert into channel (name, topic, kind, repo) values ($1, $2, 'standard', $3) returning ${COLS}`,
    [input.name, input.topic ?? '', input.repo ?? null],
  );
  return res.rows[0];
}

/** 지정된 필드만 갱신한다. `repo: null`은 "바인딩 해제"이고, 키 자체가 없으면 "손대지 않음"이다 —
 *  둘을 구분하지 못하면 topic만 고치려다 avcs 바인딩이 조용히 끊긴다. */
export async function updateChannel(
  pool: Pool, id: string, patch: { topic?: string; repo?: string | null },
): Promise<ChannelRow | null> {
  const res = await pool.query(
    `update channel set
       topic = case when $2::bool then $3::text else topic end,
       repo  = case when $4::bool then $5::text else repo  end
     where id = $1 and kind = 'standard'
     returning ${COLS}`,
    [
      id,
      patch.topic !== undefined, patch.topic ?? null,
      patch.repo !== undefined, patch.repo ?? null,
    ],
  );
  return res.rowCount ? res.rows[0] : null;
}

export async function listChannels(pool: Pool): Promise<ChannelRow[]> {
  const res = await pool.query(`select ${COLS} from channel where kind = 'standard' order by name`);
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

export async function listBoundRepos(pool: Pool): Promise<{ repo: string; channelId: string }[]> {
  const res = await pool.query(
    `select repo, id as "channelId" from channel where repo is not null and kind = 'standard'`,
  );
  return res.rows;
}

export async function dmMemberIds(pool: Pool, channelId: string): Promise<string[]> {
  const res = await pool.query(`select account_id from channel_member where channel_id = $1`, [channelId]);
  return res.rows.map((r) => r.account_id);
}

// dm 채널은 멤버만 읽고 쓸 수 있다. standard 채널(또는 존재하지 않는 채널 id — 이후
// 단계에서 별도로 실패한다)은 항상 visible로 취급한다.
export async function assertChannelVisible(pool: Pool, channelId: string, accountId: string): Promise<boolean> {
  const channel = await pool.query(`select kind from channel where id = $1`, [channelId]);
  if (channel.rows[0]?.kind !== 'dm') return true;
  const member = await pool.query(
    `select 1 from channel_member where channel_id = $1 and account_id = $2`,
    [channelId, accountId],
  );
  return Boolean(member.rowCount);
}

/**
 * 이 채널의 이벤트를 누가 받아야 하는가. DM 은 멤버만, 그 외는 전원이다.
 *
 * 한 곳에 모으는 이유: 같은 계산이 REST 라우트(messageRoutes 의 지역 함수)와 MCP 플러그인
 * (인라인)에 각각 있었다. 이벤트 수신자 판정이 두 표면에서 갈리면 한쪽만 고쳐서 DM 내용이
 * 새거나(넓게 잡음) 실시간 갱신이 안 되는(좁게 잡음) 사고가 난다.
 */
export async function audienceFor(pool: Pool, channelId: string): Promise<'all' | string[]> {
  const channel = await pool.query(`select kind from channel where id = $1`, [channelId]);
  return channel.rows[0]?.kind === 'dm' ? await dmMemberIds(pool, channelId) : 'all';
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
