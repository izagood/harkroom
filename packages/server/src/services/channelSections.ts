import type { Pool, PoolClient } from 'pg';
import type { ChannelSectionRow } from '@harkroom/shared';

type Queryable = Pick<Pool, 'query'>;

/**
 * 채널 섹션(사이드바 섹션 D2, 136 마이그레이션). 계정별 표 `channel_section` 과
 * `channel_pref.section_id` 를 다룬다.
 *
 * **이름 문자열 거울**: `channel_pref.section`(038)은 지우지 않고 섹션 이름을 그대로 비춘다.
 * 옛 앱·롤아웃 중인 옛 서버 파드가 그 컬럼을 읽는다. 그래서 `section_id` 를 쓰는 문장은
 * **언제나 `section` 도 같이 쓴다**(`setChannelSection`), 이름을 바꾸면 거울도 같이 바꾼다.
 * 한쪽만 쓰면 새 앱과 옛 앱이 같은 채널을 다른 섹션에 그린다.
 */

const SECTION_COLUMNS = `id, name, position, collapsed, created_at as "createdAt"`;

export class SectionNameTakenError extends Error {
  constructor() { super('section name already exists'); }
}

export async function listChannelSections(db: Queryable, accountId: string): Promise<ChannelSectionRow[]> {
  const res = await db.query<ChannelSectionRow>(
    `select ${SECTION_COLUMNS} from channel_section where account_id = $1 order by position, name`,
    [accountId],
  );
  return res.rows;
}

/** 요청자의 섹션 하나. 남의 섹션 id 는 없는 것과 같다(null) — 있는지조차 말하지 않는다. */
export async function getChannelSection(
  db: Queryable, accountId: string, sectionId: string,
): Promise<ChannelSectionRow | null> {
  const res = await db.query<ChannelSectionRow>(
    `select ${SECTION_COLUMNS} from channel_section where account_id = $1 and id = $2`,
    [accountId, sectionId],
  );
  return res.rows[0] ?? null;
}

/**
 * 채널을 섹션에 넣거나(id) 뺀다(null). `section_id` 와 이름 거울을 **한 문장에서** 쓴다.
 * 섹션 소유 확인은 부르는 쪽이 한다 — 여기서는 요청자의 섹션 이름을 그대로 베낀다
 * (`account_id` 로 걸러서, 남의 섹션 id 를 넣으면 이름이 null 이 되고 FK 만 남는 일이 없게
 * 부르는 쪽이 먼저 `getChannelSection` 으로 거른다).
 */
export async function setChannelSection(
  db: Queryable, accountId: string, channelId: string, sectionId: string | null,
): Promise<void> {
  await db.query(
    `insert into channel_pref (account_id, channel_id, section_id, section)
     values ($1, $2, $3::uuid,
             (select name from channel_section where id = $3::uuid and account_id = $1))
     on conflict (account_id, channel_id) do update
       set section_id = excluded.section_id, section = excluded.section`,
    [accountId, channelId, sectionId],
  );
}

/**
 * 이름으로 섹션을 찾고, 없으면 맨 뒤에 만든다 — 옛 경로(`PATCH /channels/:id/pref { section }`)가
 * 쓴다. 옛 앱에서는 "새 섹션…"이 곧 "이 이름으로 채널 넣기"였다.
 */
export async function findOrCreateSectionByName(
  db: Queryable, accountId: string, name: string,
): Promise<string> {
  await db.query(
    `insert into channel_section (account_id, name, position)
     select $1, $2, coalesce(max(position) + 1, 0) from channel_section where account_id = $1
     on conflict (account_id, name) do nothing`,
    [accountId, name],
  );
  const res = await db.query<{ id: string }>(
    `select id from channel_section where account_id = $1 and name = $2`,
    [accountId, name],
  );
  return res.rows[0]!.id;
}

/** 섹션 순서를 0..n-1 로 다시 매긴다(지금 순서를 지킨 채 틈만 메운다). */
export async function compactSectionPositions(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    `update channel_section s set position = r.pos
     from (select id, (row_number() over (order by position, name) - 1)::integer as pos
           from channel_section where account_id = $1) r
     where s.id = r.id and s.position <> r.pos`,
    [accountId],
  );
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

/**
 * 섹션 만들기. 빈 섹션도 된다(D2 가 표를 세운 이유 중 하나).
 *
 * @param position 넣을 자리. 생략하면 맨 뒤. 지우기 되돌리기(8초)가 원래 자리로 돌려놓을 때 준다 —
 *   그 자리부터 뒤의 섹션을 한 칸씩 민다.
 * @param channelIds 만들면서 넣을 채널. 되돌리기와 「섹션 머리 ＋로 만든 채널」이 쓴다.
 *   가시성·DM 확인은 라우트가 먼저 한다.
 * @throws SectionNameTakenError 같은 이름이 이미 있으면(이름이 옛 경로의 키라 겹칠 수 없다)
 */
export async function createChannelSection(
  pool: Pool, accountId: string,
  input: { name: string; position?: number; channelIds?: string[] },
): Promise<ChannelSectionRow> {
  try {
    return await inTransaction(pool, async (client) => {
      const count = await client.query<{ n: number }>(
        `select count(*)::integer as n from channel_section where account_id = $1`, [accountId],
      );
      const n = count.rows[0]!.n;
      const position = input.position === undefined ? n : Math.min(Math.max(input.position, 0), n);
      await client.query(
        `update channel_section set position = position + 1 where account_id = $1 and position >= $2`,
        [accountId, position],
      );
      const created = await client.query<ChannelSectionRow>(
        `insert into channel_section (account_id, name, position) values ($1, $2, $3)
         returning ${SECTION_COLUMNS}`,
        [accountId, input.name, position],
      );
      const section = created.rows[0]!;
      for (const channelId of input.channelIds ?? []) {
        await setChannelSection(client, accountId, channelId, section.id);
      }
      await compactSectionPositions(client, accountId);
      return (await getChannelSection(client, accountId, section.id))!;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new SectionNameTakenError();
    throw e;
  }
}

/**
 * 이름 바꾸기·접기. **보낸 것만 쓴다**(channel_pref 의 #157 교훈과 같다 — 접기만 보낸 요청이
 * 이름을 지우면 안 된다). 이름을 바꾸면 거울(`channel_pref.section`)도 같은 트랜잭션에서 바꾼다.
 *
 * 같은 이름이 있으면 거절한다(SectionNameTakenError). 옛 경로(`renameSection`)는 합치지만,
 * 여기서는 이름 칸을 고치다가 우연히 다른 섹션을 삼키는 일을 막는다 — 합치기는 옮기기로 한다.
 *
 * @returns 바뀐 섹션. 요청자의 섹션이 아니면 null.
 */
export async function updateChannelSection(
  pool: Pool, accountId: string, sectionId: string,
  patch: { name?: string; collapsed?: boolean },
): Promise<ChannelSectionRow | null> {
  try {
    return await inTransaction(pool, async (client) => {
      const current = await getChannelSection(client, accountId, sectionId);
      if (!current) return null;
      if (patch.name !== undefined && patch.name !== current.name) {
        await client.query(
          `update channel_section set name = $3 where account_id = $1 and id = $2`,
          [accountId, sectionId, patch.name],
        );
        await client.query(
          `update channel_pref set section = $3 where account_id = $1 and section_id = $2`,
          [accountId, sectionId, patch.name],
        );
      }
      if (patch.collapsed !== undefined) {
        await client.query(
          `update channel_section set collapsed = $3 where account_id = $1 and id = $2`,
          [accountId, sectionId, patch.collapsed],
        );
      }
      return getChannelSection(client, accountId, sectionId);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new SectionNameTakenError();
    throw e;
  }
}

/**
 * 섹션 지우기. 채널은 지워지지 않고 미분류(CHANNELS)로 돌아간다.
 *
 * 돌려주는 값은 **되돌리기(8초)에 필요한 전부**다 — 지운 섹션(이름·자리·접힘)과 그 안에 있던
 * 채널. 클라이언트는 `createChannelSection({ name, position, channelIds })` 한 번으로 되살린다.
 * 서버에 "지운 것 보관"을 두지 않는 이유: 되돌리기는 그 창이 살아 있는 동안만 뜻이 있고,
 * 보관 행은 치울 때를 또 정해야 한다.
 *
 * `sort_order` 는 남긴다 — 038 이래 섹션에서 빼도 순서 값을 남겼다(다시 넣으면 되살아난다).
 */
export async function deleteChannelSection(
  pool: Pool, accountId: string, sectionId: string,
): Promise<{ section: ChannelSectionRow; channelIds: string[] } | null> {
  return inTransaction(pool, async (client) => {
    const section = await getChannelSection(client, accountId, sectionId);
    if (!section) return null;
    const members = await client.query<{ channelId: string }>(
      `update channel_pref set section_id = null, section = null
       where account_id = $1 and section_id = $2
       returning channel_id as "channelId"`,
      [accountId, sectionId],
    );
    await client.query(`delete from channel_section where account_id = $1 and id = $2`, [accountId, sectionId]);
    await compactSectionPositions(client, accountId);
    return { section, channelIds: members.rows.map((r) => r.channelId).sort() };
  });
}

/**
 * 섹션 순서 바꾸기(D3). **요청자의 섹션 전부를** 새 순서로 받는다 — 일부만 받으면 나머지가
 * 어디로 가는지 정해야 하고, 두 기기가 동시에 고치면 섞인다. 집합이 다르면(그새 다른 기기가
 * 만들거나 지웠으면) null 을 돌려 409 로 알린다 — 클라이언트는 다시 읽고 다시 보낸다.
 */
export async function reorderChannelSections(
  pool: Pool, accountId: string, orderedIds: string[],
): Promise<ChannelSectionRow[] | null> {
  return inTransaction(pool, async (client) => {
    const current = await client.query<{ id: string }>(
      `select id from channel_section where account_id = $1 for update`, [accountId],
    );
    const have = new Set(current.rows.map((r) => r.id));
    const want = new Set(orderedIds);
    if (want.size !== orderedIds.length || want.size !== have.size || [...want].some((id) => !have.has(id))) {
      return null;
    }
    for (const [index, id] of orderedIds.entries()) {
      await client.query(
        `update channel_section set position = $3 where account_id = $1 and id = $2 and position <> $3`,
        [accountId, id, index],
      );
    }
    return listChannelSections(client, accountId);
  });
}
