/**
 * 인박스 「오늘」(C안 P1, 마이그레이션 167) — 마지막으로 본 시각(S1)·열린 것(S2)·끝난 것(S3)·버전 태그(S5).
 *
 * **가시성.** 모든 조회가 `listInbox` 와 같은 술어(`channelVisibleSql`)를 지난다 — 나간 비공개 채널·남의 DM 의
 * 글이 「오늘」로 새지 않는다. 계정은 언제나 부른 사람(`accountId`)이다.
 *
 * **버전 태그(S5).** 두 GET 은 본문 전에 작은 질의 하나로 태그를 구하고, 같으면 본문 질의를 돌리지 않는다(304).
 * 태그는 **본문이 기대는 것을 모두** 품어야 한다 — 늦은 304 는 버그다:
 * - 열린 것: 열린 카드·안 풀린 실패·pending 권한의 id(+수정 시각), 내 스레드들의 thread_status(상태·시각),
 *   seen_at, UTC 날짜(`ageDays`). 카드에 답하거나 닫으면 inbox 줄이 안 생겨도(남이 답한 사람 앞 카드) 그 카드가
 *   열린 집합에서 빠지므로 태그가 바뀐다. 그래서 `max(inbox.id)` 같은 짧은 신호 대신 **같은 술어로 고른 집합의
 *   서명**을 쓴다 — 본문 질의에서 글자 뽑기·JSON 만들기·묶기를 뺀 것이다.
 * - 끝난 것: 내 inbox 의 보이는 줄 수·채널 집합·max(id)·max(edited_at)·지운 줄 수, thread_status 상태별
 *   max(updated_at)(167 색인으로 상태마다 한 번 짚는다), seen_at, UTC 날짜(seen 이 없을 때 기본 since).
 */
import type { Pool } from 'pg';
import type { InboxTodayDone, InboxTodayDoneItem, InboxTodayOpen, InboxTodayOpenItem } from '@harkroom/shared';
import { channelVisibleSql } from './channels.js';
import { displayBodySql } from './systemBody.js';

export const TODAY_OPEN_MAX = 200;
export const TODAY_DONE_MAX = 50;
const TEXT_MAX = 500;

export async function getSeenAt(pool: Pool, accountId: string): Promise<Date | null> {
  const r = await pool.query<{ seen_at: Date }>('select seen_at from inbox_view_cursor where account_id = $1', [accountId]);
  return r.rows[0]?.seen_at ?? null;
}

/** seen 을 올린다 — `greatest()` 로만, 미래는 지금으로 자른다. `changed` 는 실제로 올랐는가. */
export async function markSeen(pool: Pool, accountId: string, upTo: Date): Promise<{ seenAt: Date; changed: boolean }> {
  const r = await pool.query<{ seen_at: Date; prev: Date | null }>(
    `with prev as (select seen_at from inbox_view_cursor where account_id = $1)
     insert into inbox_view_cursor as v (account_id, seen_at) values ($1, least($2::timestamptz, now()))
     on conflict (account_id) do update
       set seen_at = greatest(v.seen_at, excluded.seen_at),
           updated_at = case when excluded.seen_at > v.seen_at then now() else v.updated_at end
     returning v.seen_at, (select seen_at from prev) as prev`,
    [accountId, upTo.toISOString()],
  );
  const row = r.rows[0]!;
  return { seenAt: row.seen_at, changed: row.prev == null || row.seen_at.getTime() !== row.prev.getTime() };
}

/**
 * 열린 것의 재료. `$1` 계정, `$2` 사람인가.
 * - `r`: 내 inbox 의 보이는 글(지운 것 빼고). 한 글에 줄이 여럿이어도 한 번.
 * - `asks`: 열린 사람 앞 카드 — 답·닫힘·거울·권한 카드가 아니고, 나를 지목했거나(account) 사람 아무나(human, 내가 사람일 때).
 * - `fails`: 안 풀린 실패(사람에게만). 해소 규칙은 `THREAD_STATE_FACTS` 의 unresolved_failure_count 와 같다.
 * - `perms`: 내가 주인인 에이전트의 pending 권한 요청(시한 안), 보이는 채널의 것.
 * - `st`: 내 스레드들의 thread_status.
 */
function openCtes(): string {
  return `with r as (
    select distinct on (m.id) m.id, coalesce(m.thread_root_id, m.id) as root, m.channel_id, m.author_id,
           m.created_at, m.seq, m.meta, m.edited_at, m.kind as mkind
      from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
     where i.account_id = $1 and m.deleted_at is null and ${channelVisibleSql('c', '$1')}
     order by m.id
  ), roots as (select distinct root from r),
  asks as (
    select r.* from r
     where r.meta->>'kind' = 'ask'
       and r.meta->'ask'->>'answeredWith' is null
       and r.meta->'ask'->>'closedAt' is null
       and r.meta->'ask'->>'mirrorOf' is null
       and not (r.meta ? 'permissionRequest')
       and ((r.meta->'ask'->'to'->>'kind' = 'human' and $2::boolean)
         or (r.meta->'ask'->'to'->>'kind' = 'account' and r.meta->'ask'->'to'->>'accountId' = $1::text))
  ), fails as (
    select r.* from r
     where $2::boolean and r.meta->>'kind' = 'failure'
       and not exists (
         select 1 from message x
          where (x.id = r.root or x.thread_root_id = r.root) and x.deleted_at is null and x.seq > r.seq
            and (x.kind in ('progress', 'wake') or x.meta->>'kind' = 'report' or x.author_id = r.author_id))
  ), perms as (
    select pr.id, pr.card_message_id, pr.thread_root_id, pr.channel_id, pr.agent_id, pr.kind, pr.target, pr.reason, pr.created_at
      from permission_request pr
      join agent_config ac on ac.account_id = pr.agent_id
      join channel c on c.id = pr.channel_id
     where ac.owner_account_id = $1 and pr.status = 'pending' and pr.expires_at > now()
       and ${channelVisibleSql('c', '$1')}
  ), st as (
    select ts.root_id, ts.status, ts.reason, ts.updated_at from thread_status ts join roots on roots.root = ts.root_id
  )`;
}

/** 열린 것의 버전 태그 재료 — 본문과 **같은 CTE** 에서 집합의 서명만 낸다. */
export async function openVersion(pool: Pool, accountId: string, human: boolean): Promise<string> {
  const r = await pool.query<{ sig: string; seen: string | null; day: string }>(
    `${openCtes()}
     select md5(coalesce((select string_agg(k, ',' order by k) from (
              select 'a' || id || ':' || coalesce(edited_at::text, '') from asks
              union all select 'f' || id || ':' || coalesce(edited_at::text, '') from fails
              union all select 'p' || id || ':' || coalesce(card_message_id::text, '') from perms
              union all select 's' || root_id || ':' || status || ':' || updated_at::text from st
            ) x(k)), '')) as sig,
            (select seen_at::text from inbox_view_cursor where account_id = $1) as seen,
            ((now() at time zone 'utc')::date)::text as day`,
    [accountId, human],
  );
  const row = r.rows[0]!;
  return `open|${row.sig}|${row.seen ?? ''}|${row.day}`;
}

interface OpenRow {
  k: 'ask' | 'fail' | 'perm' | 'st';
  id: string | null; root: string; channel_id: string | null; author_id: string | null;
  created_at: Date; meta: Record<string, unknown> | null; text: string | null;
  status: string | null; reason: string | null; perm_id: string | null; day: string;
}

export async function listTodayOpen(pool: Pool, accountId: string, human: boolean): Promise<InboxTodayOpen> {
  const seen = await getSeenAt(pool, accountId);
  const res = await pool.query<OpenRow>(
    `${openCtes()}, rows as (
       select 'ask' as k, a.id, a.root, a.channel_id, a.author_id, a.created_at, a.meta,
              left(coalesce(nullif(a.meta->'ask'->>'prompt', ''), ${displayBodySql('m')}), ${TEXT_MAX}) as text,
              null::text as status, null::text as reason, null::uuid as perm_id
         from asks a join message m on m.id = a.id
       union all
       select 'fail', f.id, f.root, f.channel_id, f.author_id, f.created_at, null,
              left(coalesce(nullif(f.meta->'failure'->>'reason', ''), nullif(f.meta->'failure'->>'what', ''), ${displayBodySql('m')}), ${TEXT_MAX}),
              null, null, null
         from fails f join message m on m.id = f.id
       union all
       select 'perm', p.card_message_id, p.thread_root_id, p.channel_id, p.agent_id, p.created_at, null,
              left(p.target, ${TEXT_MAX}), p.kind, p.reason, p.id
         from perms p
       union all
       select 'st', null, s.root_id, m.channel_id, m.author_id, s.updated_at, null,
              left(coalesce(s.reason, ''), ${TEXT_MAX}), s.status, null, null
         from st s join message m on m.id = s.root_id
     )
     select rows.*, ((now() at time zone 'utc')::date)::text as day from rows`,
    [accountId, human],
  );
  const today = res.rows[0]?.day ?? new Date().toISOString().slice(0, 10);
  const statusByRoot = new Map<string, string>();
  const counts = { running: 0, waiting: 0 };
  for (const row of res.rows) {
    if (row.k !== 'st') continue;
    statusByRoot.set(row.root, row.status!);
    if (row.status === 'running' || row.status === 'received') counts.running++;
    else if (row.status === 'waiting' || row.status === 'my-turn') counts.waiting++;
  }
  const ageDays = (at: Date) => {
    const d = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
    return Math.max(0, Math.round(d / 86_400_000));
  };
  const asks = res.rows.filter((r) => r.k === 'ask');
  const failRoots = new Set(res.rows.filter((r) => r.k === 'fail').map((r) => r.root));
  const items: InboxTodayOpenItem[] = [];
  for (const row of res.rows) {
    if (row.k === 'st' && row.status !== 'stuck') continue;
    // 막힌 스레드는 그 안의 안 풀린 실패 줄이 이미 서 있으면 두 번 세우지 않는다.
    if (row.k === 'st' && failRoots.has(row.root)) continue;
    const base = {
      threadRootId: row.root, channelId: row.channel_id!, authorId: row.author_id,
      question: row.text ?? '', createdAt: row.created_at.toISOString(),
      isNew: seen == null || row.created_at > seen, ageDays: ageDays(row.created_at),
    };
    if (row.k === 'ask') {
      const ask = (row.meta?.ask ?? {}) as { options?: { id: string; label: string }[] };
      // 같은 작성자가 같은 스레드에 더 새 열린 카드를 세웠다 — 그 카드도 **내 열린 카드 집합 안**에서만 본다(태그가 그 집합을 품는다).
      const newer = asks.some((o) => o.id !== row.id && o.root === row.root && o.author_id === row.author_id && o.created_at > row.created_at);
      items.push({
        kind: 'ask', messageId: row.id, ...base,
        options: (ask.options ?? []).map((o) => ({ id: String(o.id), label: String(o.label) })),
        staleHint: statusByRoot.get(row.root) === 'done' ? 'thread_done' : newer ? 'newer_card' : null,
      });
    } else if (row.k === 'perm') {
      items.push({
        kind: 'permission', messageId: row.id, permissionRequestId: row.perm_id!, ...base, reason: row.reason,
        staleHint: statusByRoot.get(row.root) === 'done' ? 'thread_done' : null,
      });
    } else {
      items.push({
        kind: 'blocked', messageId: row.k === 'fail' ? row.id : row.root, ...base,
        staleHint: statusByRoot.get(row.root) === 'done' ? 'thread_done' : null,
      });
    }
  }
  // 오래된 것부터 — 오래 기다린 결정이 위에 선다. 같은 시각이면 id 로 정해 둔다(태그가 같으면 본문도 같게).
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || String(a.messageId ?? a.threadRootId).localeCompare(String(b.messageId ?? b.threadRootId)));
  const truncated = items.length > TODAY_OPEN_MAX;
  return { items: items.slice(0, TODAY_OPEN_MAX), truncated, counts, seenAt: seen?.toISOString() ?? null };
}

// ── 끝난 것 ──────────────────────────────────────────────────────────────

export interface DoneCursor { at: string; key: string }

export function encodeCursor(c: DoneCursor): string {
  return Buffer.from(JSON.stringify([c.at, c.key])).toString('base64url');
}
export function decodeCursor(s: string): DoneCursor | null {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string') return null;
    if (Number.isNaN(Date.parse(v[0])) || v[1].length > 64) return null;
    return { at: v[0], key: v[1] };
  } catch { return null; }
}

/** 시각을 마이크로초까지 글자로 — JS Date 는 밀리초라 keyset 비교가 같은 줄을 다시 집는다. */
const AT_TEXT = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** since 가 없을 때의 기본 — seen_at, 없으면 어제 0시(UTC). 날짜에 묶어 두어 태그가 UTC 날짜로 갈린다. */
async function defaultSince(pool: Pool, accountId: string): Promise<DoneCursor> {
  const r = await pool.query<{ at: string }>(
    `select ${AT_TEXT(`coalesce((select seen_at from inbox_view_cursor where account_id = $1),
                       (date_trunc('day', now() at time zone 'utc') - interval '1 day') at time zone 'utc')`)} as at`,
    [accountId],
  );
  return { at: r.rows[0]!.at, key: '' };
}

export async function doneVersion(pool: Pool, accountId: string): Promise<string> {
  const r = await pool.query<Record<string, string | null>>(
    `select
       (select concat_ws('|', count(*) filter (where m.deleted_at is null and ${channelVisibleSql('c', '$1')}),
                         count(*) filter (where m.deleted_at is not null and ${channelVisibleSql('c', '$1')}),
                         max(i.id) filter (where ${channelVisibleSql('c', '$1')}),
                         max(m.edited_at) filter (where ${channelVisibleSql('c', '$1')})::text,
                         md5(coalesce(string_agg(distinct m.channel_id::text, ',') filter (where ${channelVisibleSql('c', '$1')}), '')))
          from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
         where i.account_id = $1) as inbox,
       -- 본문(listTodayDone)과 같은 집합 — 내 inbox 의 보이는 줄이 속한 스레드 머리만 본다. 워크스페이스 전체의
       -- thread_status 를 재면 남의 비공개 채널 활동 시각이 내 태그로 드러난다(security 낮음 1, 2026-11-09).
       (select md5(coalesce(string_agg(ts.root_id::text || ':' || ts.status || ':' || ts.updated_at::text || ':' || (rm.deleted_at is null)::text,
                                       ',' order by ts.root_id), ''))
          from thread_status ts join message rm on rm.id = ts.root_id
         where ts.root_id in (
           select coalesce(m.thread_root_id, m.id)
             from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
            where i.account_id = $1 and m.deleted_at is null and ${channelVisibleSql('c', '$1')})) as st,
       (select seen_at::text from inbox_view_cursor where account_id = $1) as seen,
       ((now() at time zone 'utc')::date)::text as day`,
    [accountId],
  );
  const row = r.rows[0]!;
  return `done|${row.inbox}|${row.st}|${row.seen ?? ''}|${row.day}`;
}

export async function listTodayDone(
  pool: Pool, accountId: string, opts: { since?: DoneCursor; limit: number },
): Promise<InboxTodayDone> {
  const since = opts.since ?? await defaultSince(pool, accountId);
  const res = await pool.query<{ kind: 'report' | 'thread_done'; key: string; id: string; root: string; channel_id: string; author_id: string | null; body: string; at: string }>(
    `with vis as (
       select m.id, coalesce(m.thread_root_id, m.id) as root, m.channel_id, m.author_id, m.created_at, m.meta, i.reason
         from inbox i join message m on m.id = i.message_id join channel c on c.id = m.channel_id
        where i.account_id = $1 and m.deleted_at is null and ${channelVisibleSql('c', '$1')}
     ), items as (
       select distinct on (v.id) 'report'::text as kind, 'r' || v.id::text as key, v.id, v.root, v.channel_id, v.author_id,
              v.created_at as at_ts
         from vis v
        where (v.meta->>'kind' = 'report' or v.reason = 'delegation_done') and v.created_at >= $2::timestamptz
       union all
       select 'thread_done', 't' || ts.root_id::text, ts.root_id, ts.root_id, rm.channel_id, rm.author_id, ts.updated_at
         from thread_status ts join message rm on rm.id = ts.root_id
        where ts.status = 'done' and ts.updated_at >= $2::timestamptz and rm.deleted_at is null
          and exists (select 1 from vis where vis.root = ts.root_id)
     )
     select it.kind, it.key, it.id, it.root, it.channel_id, it.author_id,
            left(${displayBodySql('m')}, ${TEXT_MAX}) as body, ${AT_TEXT('it.at_ts')} as at
       from items it join message m on m.id = it.id
      where (it.at_ts, it.key) > ($2::timestamptz, $3::text)
      order by it.at_ts, it.key
      limit $4`,
    [accountId, since.at, since.key, opts.limit + 1],
  );
  const more = res.rows.length > opts.limit;
  const rows = res.rows.slice(0, opts.limit);
  const items: InboxTodayDoneItem[] = rows.map((r) => ({
    kind: r.kind, messageId: r.id, threadRootId: r.root, channelId: r.channel_id, authorId: r.author_id, body: r.body, at: r.at,
  }));
  const last = rows.length ? { at: rows[rows.length - 1]!.at, key: rows[rows.length - 1]!.key } : since;
  return { items, nextCursor: more ? encodeCursor(last) : null, cursor: encodeCursor(last), cursorAt: last.at };
}
