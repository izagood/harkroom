import type { Pool } from 'pg';
import type { ChannelRow } from '@murmur/shared';

const COLS = `id, name, topic, kind, repo`;

export async function createChannel(
  pool: Pool, input: { name: string; topic?: string; repo?: string | null },
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
