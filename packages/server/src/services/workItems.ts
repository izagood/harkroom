import type { Pool } from 'pg';
import { channelVisibleSql } from './channels.js';

/**
 * 작업 항목(110) — 한 사람의 「내 작업」 보드에 서는 **밖의 일**. 협업 통합 설계 ① 이다.
 *
 * 누가 쓰나: **보드 주인 본인**, 그리고 **그 사람이 주인인 에이전트**뿐이다(`resolveWorkItemOwner`).
 * 남의 보드에 카드를 꽂는 길은 처음부터 열지 않는다 — 대상을 몸통으로 받지 않으므로 고를 수도 없다.
 *
 * 무엇을 받나: 짧은 제목·https URL·바깥 키뿐이다. 본문·마크다운은 받지 않는다(화면이 렌더하지 않을
 * 글자만 둔다). 한 사람당 `MAX_ITEMS_PER_OWNER` 개까지다 — 에이전트가 반복하다 보드를 덮지 않게.
 */
export const WORK_ITEM_SOURCES = ['github', 'jira', 'slack', 'other', 'avcs'] as const;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[number];
export const WORK_ITEM_STATES = ['mine', 'blocked', 'active', 'done'] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];
export const MAX_ITEMS_PER_OWNER = 500;

/**
 * avcs 의 바깥 키 = `<repo>/<intent oid>`. repo 는 채널에 묶인 저장소 이름(슬래시 포함 가능),
 * 마지막 마디는 oid(16진). 모양만 본다 — 그 intent 가 실제로 있는지는 ② 가 /reduced 로 안다.
 */
const AVCS_KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[0-9a-f]{12,128}$/;

export interface WorkItem {
  id: string;
  source: WorkItemSource;
  externalKey: string;
  url: string | null;
  title: string;
  /** avcs 는 언제나 null — 정본은 avcs 서버의 /reduced 다. */
  state: WorkItemState | null;
  threadRootId: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkItemRefusal =
  | 'no_owner' | 'bad_key' | 'state_not_allowed' | 'state_required' | 'thread_required'
  | 'thread_not_found' | 'thread_forbidden' | 'not_root' | 'too_many';

/**
 * 이 계정이 쓰는 보드의 주인. 사람은 자기 자신이고, 에이전트는 `agent_config.owner_account_id` 의
 * 살아 있는 사람이다(automation.propose 와 같은 판정). 주인 없는 에이전트는 null — 쓸 보드가 없다.
 */
export async function resolveWorkItemOwner(
  pool: Pool, account: { id: string; kind: string },
): Promise<string | null> {
  if (account.kind === 'human') return account.id;
  if (account.kind !== 'agent') return null;
  const res = await pool.query<{ id: string }>(
    `select o.id from agent_config c join account o on o.id = c.owner_account_id
      where c.account_id = $1 and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null`,
    [account.id],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * 보드를 만지는 쪽. 주인 본인이면 보드 전부를, **주인이 아닌 계정(그 사람의 에이전트)이면 자기도 지금 볼 수
 * 있는 스레드에 붙은 항목만** 읽고 지우고 고쳐 쓴다. 에이전트는 주인 아닌 사람의 글로도 깨어나므로, 주인 보드
 * 전체(비공개 채널·DM 에 붙은 항목, 스레드 없이 손으로 건 PR·티켓)를 그대로 돌려주면 시킨 사람의 채널로 샌다.
 */
export interface WorkItemActor { id: string; kind: string }

/** 주인이 아닌 쪽이 이 항목을 다룰 수 있나 — 스레드에 붙어 있고, 그 루트가 그 계정에게 지금 보인다. */
function actorSeesItemSql(w: string, actorParam: string): string {
  return `(${w}.thread_root_id is not null and exists (
    select 1 from message am join channel ac on ac.id = am.channel_id
     where am.id = ${w}.thread_root_id and am.deleted_at is null and ${channelVisibleSql('ac', actorParam)}))`;
}

const COLUMNS = `w.id, w.source, w.external_key as "externalKey", w.url, w.title, w.state,
  w.thread_root_id as "threadRootId", w.updated_by as "updatedBy",
  w.created_at as "createdAt", w.updated_at as "updatedAt"`;

function toItem(r: Record<string, unknown>): WorkItem {
  return {
    id: r.id as string,
    source: r.source as WorkItemSource,
    externalKey: r.externalKey as string,
    url: (r.url as string | null) ?? null,
    title: r.title as string,
    state: (r.state as WorkItemState | null) ?? null,
    threadRootId: (r.threadRootId as string | null) ?? null,
    updatedBy: (r.updatedBy as string | null) ?? null,
    createdAt: new Date(r.createdAt as string).toISOString(),
    updatedAt: new Date(r.updatedAt as string).toISOString(),
  };
}

export interface UpsertWorkItemInput {
  ownerId: string;
  /** 쓰는 계정(사람 본인 또는 그 사람의 에이전트). 스레드는 **둘 다** 볼 수 있어야 붙인다. */
  actorId: string;
  source: WorkItemSource;
  externalKey: string;
  title: string;
  url: string | null;
  state: WorkItemState | null;
  threadRootId: string | null;
}

/**
 * 같은 (주인, source, 바깥 키)면 고쳐 쓴다(멱등). 스레드를 붙일 때는 그 루트가 **주인과 쓰는 계정 모두에게
 * 지금 보이는지** 본다 — 주인이 못 보는 스레드를 보드에 걸면 제목으로 존재가 새고, 에이전트가 못 보는
 * 스레드를 걸 수 있으면 id 를 짐작해 붙이는 길이 된다.
 */
export async function upsertWorkItem(
  pool: Pool, input: UpsertWorkItemInput,
): Promise<{ item: WorkItem } | { refused: WorkItemRefusal }> {
  const { ownerId, actorId, source, externalKey, title, url, state, threadRootId } = input;
  if (source === 'avcs') {
    if (!AVCS_KEY.test(externalKey)) return { refused: 'bad_key' };
    if (state !== null) return { refused: 'state_not_allowed' };
    if (threadRootId === null) return { refused: 'thread_required' };
  } else if (state === null) {
    return { refused: 'state_required' };
  }
  if (threadRootId !== null) {
    const root = await pool.query<{ thread_root_id: string | null; owner_sees: boolean; actor_sees: boolean }>(
      `select m.thread_root_id, ${channelVisibleSql('c', '$2')} as owner_sees, ${channelVisibleSql('c', '$3')} as actor_sees
         from message m join channel c on c.id = m.channel_id
        where m.id = $1 and m.deleted_at is null`,
      [threadRootId, ownerId, actorId],
    );
    const row = root.rows[0];
    if (!row) return { refused: 'thread_not_found' };
    // 못 보는 것과 없는 것을 같은 답으로 둘지 고민했지만, 보는 사람 기준 판정이라 존재가 새는 쪽은
    // 이미 볼 수 없는 채널의 메시지 id 를 쥔 경우뿐이다 — inbox_thread_state(089)와 같은 답을 쓴다.
    if (!row.owner_sees || !row.actor_sees) return { refused: 'thread_forbidden' };
    if (row.thread_root_id !== null) return { refused: 'not_root' };
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    // 상한은 주인 단위로 센다. 같은 주인의 동시 쓰기가 상한을 같이 넘지 않게 주인마다 트랜잭션 잠금을 건다
    // (account 행을 잠그면 무관한 계정 갱신까지 기다린다).
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 110))`, [ownerId]);
    const existing = await client.query<{ actor_sees: boolean }>(
      `select ${actorSeesItemSql('w', '$4')} as actor_sees
         from work_item w where w.owner_account_id = $1 and w.source = $2 and w.external_key = $3`,
      [ownerId, source, externalKey, actorId],
    );
    // 주인이 아닌 쪽은 자기가 못 보는 기존 항목을 덮지 못한다 — 같은 키로 url·제목·스레드를 바꿔치는 길.
    if (existing.rows[0] && actorId !== ownerId && !existing.rows[0].actor_sees) {
      await client.query('rollback');
      return { refused: 'thread_forbidden' };
    }
    if (!existing.rowCount) {
      const n = await client.query<{ n: number }>(
        `select count(*)::int as n from work_item where owner_account_id = $1`, [ownerId],
      );
      if ((n.rows[0]?.n ?? 0) >= MAX_ITEMS_PER_OWNER) {
        await client.query('rollback');
        return { refused: 'too_many' };
      }
    }
    const res = await client.query(
      `insert into work_item as w (owner_account_id, source, external_key, url, title, state, thread_root_id, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (owner_account_id, source, external_key) do update set
         url = excluded.url, title = excluded.title, state = excluded.state,
         thread_root_id = excluded.thread_root_id, updated_by = excluded.updated_by, updated_at = now()
       returning ${COLUMNS}`,
      [ownerId, source, externalKey, url, title, state, threadRootId, actorId],
    );
    await client.query('commit');
    return { item: toItem(res.rows[0]) };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 주인의 항목. 붙은 스레드가 **지금** 주인에게 안 보이면(채널에서 빠짐·비공개 전환) 그 항목은 싣지 않는다 —
 * 붙일 때의 가시성으로 영원히 보여 주면 #1079 가 막은 길이 여기서 다시 열린다. 주인이 아닌 쪽에게는
 * `WorkItemActor` 의 범위만 싣는다.
 */
export async function listWorkItems(
  pool: Pool, ownerId: string, actor: WorkItemActor,
  filter: { threadRootId?: string; source?: WorkItemSource } = {},
): Promise<WorkItem[]> {
  const params: unknown[] = [ownerId];
  const where = ['w.owner_account_id = $1'];
  if (actor.id !== ownerId) { params.push(actor.id); where.push(actorSeesItemSql('w', `$${params.length}`)); }
  if (filter.threadRootId) { params.push(filter.threadRootId); where.push(`w.thread_root_id = $${params.length}`); }
  if (filter.source) { params.push(filter.source); where.push(`w.source = $${params.length}`); }
  const res = await pool.query(
    `select ${COLUMNS}
       from work_item w
       left join message m on m.id = w.thread_root_id
       left join channel c on c.id = m.channel_id
      where ${where.join(' and ')}
        and (w.thread_root_id is null or (m.deleted_at is null and ${channelVisibleSql('c', '$1')}))
      order by w.updated_at desc
      limit ${MAX_ITEMS_PER_OWNER}`,
    params,
  );
  return res.rows.map(toItem);
}

/**
 * 주인의 항목 하나를 지운다 — id 또는 (source, 바깥 키). 남의 것은 아무 것도 지우지 않는다. 주인이 아닌 쪽은
 * `WorkItemActor` 의 범위 안 것만 지우고, 범위 밖이면 없는 것과 같은 false 다(키가 있는지 새지 않게).
 */
export async function removeWorkItem(
  pool: Pool, ownerId: string, actor: WorkItemActor,
  key: { id: string } | { source: WorkItemSource; externalKey: string },
): Promise<boolean> {
  const params: unknown[] = [ownerId];
  const where = ['w.owner_account_id = $1'];
  if ('id' in key) { params.push(key.id); where.push(`w.id = $${params.length}`); } else {
    params.push(key.source, key.externalKey);
    where.push(`w.source = $${params.length - 1}`, `w.external_key = $${params.length}`);
  }
  if (actor.id !== ownerId) { params.push(actor.id); where.push(actorSeesItemSql('w', `$${params.length}`)); }
  const res = await pool.query(`delete from work_item w where ${where.join(' and ')}`, params);
  return (res.rowCount ?? 0) > 0;
}

/** 거절 코드의 사람 말(REST·MCP 공용). */
export const WORK_ITEM_REFUSAL_MESSAGE: Record<WorkItemRefusal, string> = {
  no_owner: 'this agent has no human owner, so it has no board to write to',
  bad_key: 'avcs externalKey must be <repo>/<intent oid>',
  state_not_allowed: 'avcs items carry no state — it is read from the avcs server',
  state_required: 'state is required for non-avcs items (mine | blocked | active | done)',
  thread_required: 'avcs items must be attached to a thread (threadRootId)',
  thread_not_found: 'no such message',
  thread_forbidden: 'the thread is not visible to the board owner or to you',
  not_root: 'threadRootId must be a thread root',
  too_many: `the board already has ${MAX_ITEMS_PER_OWNER} work items; remove some first`,
};
