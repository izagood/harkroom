import type { Pool } from 'pg';
import { repoScope } from '@harkroom/shared';
import { mergeGrantFor, readGrantFor } from '../auth/permissions.js';
import { recordAudit } from '../audit.js';
import { postMessage } from './messages.js';
import { delegationV2Enabled } from './delegations.js';

/**
 * PR 감시(위임 재설계 P5, 164 의 `pr_watch`·`pr_watch_subscriber`). 서버가 상태를 쥔다 — 감시 하나 = (repo, number, head, until),
 * 같은 키의 열린 감시는 하나(`pr_watch_open_key`)라 위임자와 담당이 같이 걸어도 폴링은 한 번이다.
 *
 * 폴링은 gh 가 있는 오퍼레이터가 한다(`pr.status` 와 같은 길 — 서버는 gh 자격이 없다). 오퍼레이터는 자기가 띄우는 에이전트의
 * 이름으로 `GET /agent/pr-watches/due` 를 읽고, gh 로 읽은 고정 칸을 `POST /agent/pr-watches/:id/status` 로 보낸다.
 * 바뀐 것을 가르고·끝내고·구독자 스레드에 시스템 줄을 쓰고·구독자만 깨우는 것은 전부 여기(`reportWatchStatus`)다.
 *
 * 깨우기 사유는 `wake` 다: 구독자가 스스로 건 감시의 결과로 자기 자신을 다시 부르는 것이라 `turn.wake` 가 무르익은 것과 뜻이 같다
 * (`agentWakes.ts` 의 생 insert 와 같은 이유로 `insertInbox` 를 쓰지 않는다 — 남의 화면을 바꾸지 않는다). 시스템 줄에는 멘션이 없다.
 *
 * 스위치(`delegationV2Enabled`)가 꺼지면 아무것도 만들지 않는다 — 도구는 `disabled`, due 는 빈 목록, 머지 래퍼는 감시를 걸지 않는다.
 */

export const PR_WATCH_TTL_SEC = 6 * 60 * 60;
export const PR_WATCH_POLL_SEC = 60;
export type PrWatchUntil = 'checks' | 'merged';
export type PrWatchSource = 'manual' | 'merge_queue';

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/** 끝난 체크의 결론. 이 밖(IN_PROGRESS·QUEUED·PENDING·''…)은 아직 도는 중이다. */
const CONCLUDED = new Set(['SUCCESS', 'FAILURE', 'NEUTRAL', 'CANCELLED', 'SKIPPED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STALE', 'ERROR', 'STARTUP_FAILURE']);

export type CreateWatchDenial = 'disabled' | 'bad_request' | 'not_granted' | 'forbidden' | 'delegation_not_found';
export type CreateWatchResult =
  | { ok: true; watchId: string; created: boolean; expiresAt: string }
  | { ok: false; code: CreateWatchDenial };

/** `pr.status` 와 **같은** grant 판정(`prStatusChecks.ts`): 읽기 grant 또는 머지 grant, 그 채널에서 센다. */
export async function holdsPrGrant(pool: Pool, accountId: string, repo: string, channelId: string): Promise<boolean> {
  const opts = { channelId };
  return !!(await readGrantFor(pool, accountId, repo, opts)) || !!(await mergeGrantFor(pool, accountId, repo, opts));
}

/**
 * 감시를 건다(또는 같은 키의 열린 감시에 구독자로 붙는다). `source` 는 인자가 아니다 — 도구 길은 늘 `manual`,
 * `merge_queue` 는 머지 래퍼 보고(`autoWatchOnQueued`)만 정한다.
 */
export async function createWatch(pool: Pool, args: {
  accountId: string; repo: string; number: number; head: string; until: PrWatchUntil;
  channelId: string; threadRootId: string; delegationId?: string | null;
}, internal: { source?: PrWatchSource; skipGrant?: boolean } = {}): Promise<CreateWatchResult> {
  if (!delegationV2Enabled()) return { ok: false, code: 'disabled' };
  if (!REPO_RE.test(args.repo) || !SHA_RE.test(args.head) || !Number.isInteger(args.number) || args.number <= 0) {
    return { ok: false, code: 'bad_request' };
  }
  const scope = repoScope(args.repo);
  if (!scope) return { ok: false, code: 'bad_request' };
  const repo = scope.slice('repo:'.length);
  // 채널 멤버(공개 채널 열람이 아니라 `channel_member` 행)이고, 스레드 머리가 그 채널의 머리 글이어야 한다.
  const member = await pool.query(
    `select 1 from channel_member cm join message m on m.channel_id = cm.channel_id
      where cm.channel_id = $1 and cm.account_id = $2 and m.id = $3 and m.thread_root_id is null`,
    [args.channelId, args.accountId, args.threadRootId]);
  if (!member.rowCount) return { ok: false, code: 'forbidden' };
  if (!internal.skipGrant && !(await holdsPrGrant(pool, args.accountId, repo, args.channelId))) {
    await recordAudit(pool, { action: 'pr.status.denied', actorId: args.accountId, target: scope, detail: { number: args.number, code: 'not_granted', via: 'pr.watch' } });
    return { ok: false, code: 'not_granted' };
  }
  if (args.delegationId) {
    // 그 스레드의 위임이고, 나는 넘긴 쪽(lead)이거나 받은 쪽(delegate)이다.
    const d = await pool.query(
      `select 1 from team_delegation d
        where d.id = $1 and d.thread_root_id = $2
          and (d.lead_account_id = $3 or exists (select 1 from team_delegation_item di where di.delegation_id = d.id and di.delegate_account_id = $3))`,
      [args.delegationId, args.threadRootId, args.accountId]);
    if (!d.rowCount) return { ok: false, code: 'delegation_not_found' };
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    const ins = await client.query<{ id: string; expires_at: Date; created: boolean }>(
      `insert into pr_watch (repo, number, head, until, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(secs => $5))
       on conflict (repo, number, head, until) where state = 'open' do update set expires_at = greatest(pr_watch.expires_at, excluded.expires_at)
       returning id, expires_at, (xmax = 0) as created`,
      [repo, args.number, args.head, args.until, PR_WATCH_TTL_SEC]);
    const w = ins.rows[0]!;
    await client.query(
      `insert into pr_watch_subscriber (watch_id, account_id, channel_id, thread_root_id, delegation_id, source)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (watch_id, account_id, thread_root_id) do update set delegation_id = coalesce(excluded.delegation_id, pr_watch_subscriber.delegation_id)`,
      [w.id, args.accountId, args.channelId, args.threadRootId, args.delegationId ?? null, internal.source ?? 'manual']);
    await client.query('commit');
    return { ok: true, watchId: w.id, created: w.created, expiresAt: w.expires_at.toISOString() };
  } catch (e) {
    await client.query('rollback').catch(() => null);
    throw e;
  } finally {
    client.release();
  }
}

/** 머지 래퍼가 `queued` 를 보고했다 — 머지한 에이전트 이름으로 그 머지 스레드에 `until: merged` 감시를 건다. 스위치가 꺼지면 아무것도. */
export async function autoWatchOnQueued(pool: Pool, args: {
  agentId: string; repo: string; number: number; headSha: string; channelId: string; threadRootId: string;
}): Promise<CreateWatchResult | null> {
  if (!delegationV2Enabled()) return null;
  // grant 는 방금 머지 판정(N1 관문)이 봤다 — 다시 보지 않는다.
  return createWatch(pool, { accountId: args.agentId, repo: args.repo, number: args.number, head: args.headSha, until: 'merged',
    channelId: args.channelId, threadRootId: args.threadRootId }, { source: 'merge_queue', skipGrant: true });
}

export interface DueWatch { id: string; repo: string; number: number; head: string; until: PrWatchUntil }

/** 이 에이전트가 구독한, 폴링할 때가 된 열린 감시. 만료된 것은 여기서 `expired` 로 닫는다. */
export async function dueWatches(pool: Pool, agentId: string, now: Date = new Date()): Promise<DueWatch[]> {
  if (!delegationV2Enabled()) return [];
  await expireWatches(pool, now);
  const r = await pool.query<DueWatch>(
    `select w.id, w.repo, w.number, w.head, w.until from pr_watch w
      where w.state = 'open' and (w.last_polled_at is null or w.last_polled_at <= $2::timestamptz - make_interval(secs => $3))
        and exists (select 1 from pr_watch_subscriber s where s.watch_id = w.id and s.account_id = $1)
      order by w.last_polled_at nulls first limit 20`,
    [agentId, now, PR_WATCH_POLL_SEC - 5]);
  return r.rows;
}

export async function expireWatches(pool: Pool, now: Date = new Date()): Promise<number> {
  const r = await pool.query(
    `update pr_watch set state = 'expired', ended_at = $1 where state = 'open' and expires_at <= $1`, [now]);
  return r.rowCount ?? 0;
}

export interface WatchStatusInput { state: string; headRefOid: string; checks: { name: string; conclusion: string }[] }

function summarize(s: WatchStatusInput) {
  const checks = [...s.checks].map((c) => ({ name: c.name.slice(0, 200), conclusion: c.conclusion.toUpperCase().slice(0, 40) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { state: s.state.toUpperCase(), head: s.headRefOid, checks };
}

/** 다음 상태. null 이면 계속 연다. */
export function nextState(until: PrWatchUntil, head: string, sum: ReturnType<typeof summarize>): 'done' | 'gone' | null {
  if (until === 'merged') return sum.state === 'MERGED' || sum.state === 'CLOSED' ? 'done' : null;
  if (sum.state === 'MERGED') return 'done';
  if (sum.state === 'CLOSED' || sum.head !== head) return 'gone';
  return sum.checks.length > 0 && sum.checks.every((c) => CONCLUDED.has(c.conclusion)) ? 'done' : null;
}

export type ReportWatchResult =
  | { ok: true; changed: boolean; state: 'open' | 'done' | 'gone'; woke: string[] }
  | { ok: false; code: 'disabled' | 'not_found' | 'not_granted' };

/**
 * 오퍼레이터가 읽은 상태를 받는다. 보고하는 에이전트는 그 감시의 구독자이고 지금도 그 저장소의 grant 를 쥐어야 한다(`pr.status` 와 같은 판정).
 * 바뀌었으면 구독자 스레드마다 시스템 줄 하나(멘션 없음)와 구독자 `wake` 하나. until 에 닿으면 `done`, PR 이 닫혔거나 head 가 밀렸으면 `gone`.
 */
export async function reportWatchStatus(pool: Pool, args: { agentId: string; watchId: string; status: WatchStatusInput; now?: Date }): Promise<ReportWatchResult> {
  if (!delegationV2Enabled()) return { ok: false, code: 'disabled' };
  const now = args.now ?? new Date();
  const w = (await pool.query<{ id: string; repo: string; number: number; head: string; until: PrWatchUntil; last_status: unknown; channel_id: string }>(
    `select w.id, w.repo, w.number, w.head, w.until, w.last_status, s.channel_id
       from pr_watch w join pr_watch_subscriber s on s.watch_id = w.id and s.account_id = $2
      where w.id = $1 and w.state = 'open' limit 1`, [args.watchId, args.agentId])).rows[0];
  if (!w) return { ok: false, code: 'not_found' };
  if (!(await holdsPrGrant(pool, args.agentId, w.repo, w.channel_id))) return { ok: false, code: 'not_granted' };
  const sum = summarize(args.status);
  // jsonb 는 키 순서를 바꾸므로 비교는 DB 에서(jsonb 동치) 한다.
  const changed = (await pool.query<{ c: boolean }>(`select ($1::jsonb is distinct from last_status) as c from pr_watch where id = $2`, [JSON.stringify(sum), w.id])).rows[0]?.c ?? true;
  const end = nextState(w.until, w.head, sum);
  // 같은 감시를 두 오퍼레이터가 겹쳐 보고해도 한 번만 넘어가게 — 여전히 열려 있고 last_status 가 그대로일 때만 쓴다.
  const upd = await pool.query(
    `update pr_watch set last_status = $2, last_polled_at = $3,
            state = coalesce($4, state), ended_at = case when $4::text is null then null else $3::timestamptz end
      where id = $1 and state = 'open' and last_status is not distinct from $5::jsonb`,
    [w.id, JSON.stringify(sum), now, end, w.last_status === null || w.last_status === undefined ? null : JSON.stringify(w.last_status)]);
  if (!upd.rowCount) return { ok: true, changed: false, state: 'open', woke: [] };
  if (!changed && !end) return { ok: true, changed: false, state: 'open', woke: [] };
  const subs = (await pool.query<{ account_id: string; channel_id: string; thread_root_id: string }>(
    `select account_id, channel_id, thread_root_id from pr_watch_subscriber where watch_id = $1`, [w.id])).rows;
  const done = sum.checks.filter((c) => CONCLUDED.has(c.conclusion)).length;
  const failing = sum.checks.filter((c) => CONCLUDED.has(c.conclusion) && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)).length;
  const tail = end === 'done' ? ' · 감시 끝' : end === 'gone' ? (sum.head !== w.head ? ' · head 가 바뀌어 감시 끝' : ' · PR 이 닫혀 감시 끝') : '';
  // 본문은 고정 문구와 숫자뿐 — 체크 이름(남이 정한 글)은 meta 에만 둔다. `postMessage` 가 본문 멘션을 풀므로 남의 글을 싣지 않는다.
  const body = `👀 ${w.repo}#${w.number} ${sum.state} · 체크 ${done}/${sum.checks.length} 끝 · 실패 ${failing}${tail}`;
  const woke: string[] = [];
  for (const s of subs) {
    const posted = await postMessage(pool, {
      channelId: s.channel_id, threadRootId: s.thread_root_id, authorId: s.account_id, body, kind: 'system',
      meta: { prWatch: { watchId: w.id, repo: w.repo, number: w.number, head: w.head, until: w.until, state: end ?? 'open', status: sum } },
    });
    if (posted.failure) continue;
    await pool.query(`insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake') on conflict do nothing`, [s.account_id, posted.message.id]);
    woke.push(s.account_id);
  }
  return { ok: true, changed, state: end ?? 'open', woke };
}

/** 이 위임에 열린 감시가 붙어 있는가 — 있으면 「외부 대기」라 침묵 스위퍼가 건드리지 않는다. */
export async function delegationHasOpenWatch(pool: Pool, delegationId: string): Promise<boolean> {
  if (!delegationV2Enabled()) return false;
  const r = await pool.query(
    `select 1 from pr_watch_subscriber s join pr_watch w on w.id = s.watch_id
      where s.delegation_id = $1 and w.state = 'open' and w.expires_at > now() limit 1`, [delegationId]);
  return !!r.rowCount;
}
