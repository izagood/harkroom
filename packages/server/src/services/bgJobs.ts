/**
 * 백그라운드 턴 일감(G1 · BG1, 마이그레이션 131, 설계 harkroom://message/4a44f18a 3~5절).
 *
 * 앵커(메시지) 없이, 채팅에 글도 쓰지 않는 턴의 큐다. `inbox`·`runMentionTurn` 을 쓰지 않는 이유는 설계 2절 —
 * 발화 강제·실패 보고·스레드 임대가 모두 「스레드가 있다」를 전제해, 하나라도 우회를 빠뜨리면 채팅에 글이 샌다.
 * - 넣는 것은 서버 sweep 뿐이다(종류별 생산자는 BG3~). 사람·에이전트는 열 수 없다.
 * - 러너가 하루 한 창(03~07 KST)에만 `bg.claim` 으로 집는다. 창 판정은 서버도 한다(러너가 뚫려도 낮에 안 돈다).
 * - (에이전트, 종류, KST 날짜) 유일 → 하루 1회. 서버 전체 하루 상한은 env.
 * - 실패는 행에만 남는다. 같은 (에이전트, 종류)가 3번 연속 실패하면 멈춘다 — 새로 넣지 않는다.
 */
import type { Pool } from 'pg';

import {
  JOURNAL_EXPIRING_WINDOW, MAX_JOURNAL_MEMORIES_PER_ACCOUNT, MEMORY_CORE_WARN_CHARS, MEMORY_ITEMS_WARN_COUNT,
} from '@harkroom/shared';

import { channelVisibleSql } from './channels.js';

export const BG_KINDS = ['distill', 'cleanup'] as const;
export type BgKind = typeof BG_KINDS[number];
export type BgStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** 회차당 기억 쓰기(set·archive·merge) 상한(설계 5절). */
export const BG_MAX_WRITES = 20;
/** 러너의 하드 타임아웃은 10분 — 집은 지 이만큼 지나도 running 이면 sweep 이 failed(timeout) 로 닫는다. */
export const BG_STALE_RUNNING_MS = 15 * 60 * 1000;
/** 연속 실패가 이만큼이면 그 (에이전트, 종류)를 멈춘다. */
export const BG_PAUSE_AFTER_FAILURES = 3;
/** claim 창(KST 시, [시작, 끝)). */
export const BG_WINDOW_KST: readonly [number, number] = [3, 7];
const DEFAULT_DAILY_MAX = 50;

/** 전역 스위치(기본 꺼짐). 정확히 `1` 일 때만 켠다 — 기본값이 비용을 만들지 않게. */
export function backgroundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARKROOM_BACKGROUND_ENABLED === '1';
}

/** 서버 전체 하루 회차 상한. 모양이 틀리면 기본값. */
export function backgroundDailyMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HARKROOM_BACKGROUND_DAILY_MAX);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_MAX;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 날짜(YYYY-MM-DD). */
export function kstDay(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function inBgWindow(now: Date): boolean {
  const h = new Date(now.getTime() + KST_OFFSET_MS).getUTCHours();
  return h >= BG_WINDOW_KST[0] && h < BG_WINDOW_KST[1];
}

export interface BgJobRow {
  id: string;
  accountId: string;
  kind: BgKind;
  day: string;
  status: BgStatus;
  input: { threadIds?: string[] } & Record<string, unknown>;
  summary: string | null;
  error: string | null;
  writes: number;
  tokens: number | null;
  durationMs: number | null;
  createdAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

const SELECT_JOB = `select id, account_id as "accountId", kind, to_char(day, 'YYYY-MM-DD') as day, status, input, summary, error,
  writes, tokens, duration_ms as "durationMs", created_at as "createdAt", claimed_at as "claimedAt", finished_at as "finishedAt"
  from bg_job`;

/** 최근 3회가 모두 실패면 멈춘 상태다. */
export async function bgPaused(pool: Pool, accountId: string, kind: BgKind): Promise<boolean> {
  const r = await pool.query<{ status: string }>(
    `select status from bg_job where account_id = $1 and kind = $2 and status in ('done', 'failed', 'skipped')
     order by created_at desc limit $3`,
    [accountId, kind, BG_PAUSE_AFTER_FAILURES],
  );
  return r.rows.length === BG_PAUSE_AFTER_FAILURES && r.rows.every((x) => x.status === 'failed');
}

export type EnqueueResult = { job: BgJobRow } | { refused: 'disabled' | 'exists' | 'daily_cap' | 'paused' | 'agent_off' };

/** 서버 sweep(종류별 생산자) 전용. 같은 (에이전트, 종류, 날짜)는 한 번뿐이다. */
export async function enqueueBgJob(
  pool: Pool, input: { accountId: string; kind: BgKind; input: BgJobRow['input']; now?: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnqueueResult> {
  if (!backgroundEnabled(env)) return { refused: 'disabled' };
  const now = input.now ?? new Date();
  const day = kstDay(now);
  if (await bgPaused(pool, input.accountId, input.kind)) return { refused: 'paused' };
  // 소유자의 「백그라운드 정리」 토글(132). 꺼진 에이전트에는 넣지 않는다.
  const on = await pool.query<{ bg_enabled: boolean }>(`select bg_enabled from agent_config where account_id = $1`, [input.accountId]);
  if (on.rows[0] && !on.rows[0].bg_enabled) return { refused: 'agent_off' };
  // 하루 상한은 날짜별 advisory 잠금으로 직렬화한다(security n4) — 두 생산자가 동시에 세면 상한을 넘긴다.
  const client = await pool.connect();
  let r: { rows: { id: string }[] };
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('bg_job_daily:' || $1))`, [day]);
    r = await client.query<{ id: string }>(
      `insert into bg_job (account_id, kind, day, input)
       select $1, $2, $3::date, $4::jsonb
       where (select count(*) from bg_job where day = $3::date) < $5
       on conflict (account_id, kind, day) do nothing
       returning id`,
      [input.accountId, input.kind, day, JSON.stringify(input.input), backgroundDailyMax(env)],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (!r.rows[0]) {
    const exists = await pool.query(`select 1 from bg_job where account_id = $1 and kind = $2 and day = $3::date`, [input.accountId, input.kind, day]);
    return { refused: exists.rowCount ? 'exists' : 'daily_cap' };
  }
  return { job: (await getBgJob(pool, r.rows[0].id))! };
}

export async function getBgJob(pool: Pool, id: string): Promise<BgJobRow | null> {
  const r = await pool.query<BgJobRow>(`${SELECT_JOB} where id = $1`, [id]);
  return r.rows[0] ?? null;
}

export type ClaimResult = { job: BgJobRow } | { job: null; reason: 'disabled' | 'outside_window' | 'none' };

/** 러너가 집는다 — 이 에이전트의 가장 오래된 오늘 일감 하나를 running 으로. 창 밖·스위치 꺼짐이면 아무것도 안 준다. */
export async function claimBgJob(pool: Pool, accountId: string, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<ClaimResult> {
  if (!backgroundEnabled(env)) return { job: null, reason: 'disabled' };
  if (!inBgWindow(now)) return { job: null, reason: 'outside_window' };
  const r = await pool.query<{ id: string }>(
    `update bg_job set status = 'running', claimed_at = now()
     where id = (
       select id from bg_job where account_id = $1 and status = 'queued' and day = $2::date
       order by created_at limit 1 for update skip locked)
     returning id`,
    [accountId, kstDay(now)],
  );
  if (!r.rows[0]) return { job: null, reason: 'none' };
  return { job: (await getBgJob(pool, r.rows[0].id))! };
}

export interface CompleteInput {
  status: 'done' | 'failed' | 'skipped';
  summary?: string | null;
  error?: string | null;
  tokens?: number | null;
  durationMs?: number | null;
}

/** running 인 자기 일감만 닫는다. 이미 닫혔으면 not_running(두 번 닫기·늦은 러너 보고는 덮지 않는다). */
export async function completeBgJob(pool: Pool, accountId: string, jobId: string, c: CompleteInput): Promise<'ok' | 'not_found' | 'not_running'> {
  const r = await pool.query<{ kind: string; input: BgJobRow['input'] }>(
    `update bg_job set status = $3, summary = $4, error = $5, tokens = $6, duration_ms = $7, finished_at = now()
     where id = $1 and account_id = $2 and status = 'running'
     returning kind, input`,
    [jobId, accountId, c.status, c.summary ?? null, c.error ?? null, c.tokens ?? null, c.durationMs ?? null],
  );
  if (r.rows[0]) {
    // 증류가 끝났으면(done) 입력 스레드의 메모를 보관한다(BG3). 실패·건너뜀이면 그대로 두어 다음 날 다시 고른다.
    const row = r.rows[0];
    if (c.status === 'done' && row.kind === 'distill' && Array.isArray(row.input.threadIds) && row.input.threadIds.length) {
      await pool.query(
        `update thread_note set archived_at = now(), archived_by_run = $3
          where account_id = $1 and thread_root_id = any($2::uuid[]) and archived_at is null`,
        [accountId, row.input.threadIds, jobId],
      );
    }
    return 'ok';
  }
  const exists = await pool.query(`select 1 from bg_job where id = $1 and account_id = $2`, [jobId, accountId]);
  return exists.rowCount ? 'not_running' : 'not_found';
}

/**
 * 쓰기 n 건을 한 번에 예약한다(원자적, 상한 20). running 이 아니거나 넘치면 false 이고 아무것도 안 센다.
 * merge 는 into 하나 + 보관하는 from 수만큼이다(security F1 — 한 건으로 세면 상한이 merge 로 10배 풀린다).
 */
export async function reserveBgWrite(pool: Pool, jobId: string, n = 1): Promise<boolean> {
  const r = await pool.query(
    `update bg_job set writes = writes + $3 where id = $1 and status = 'running' and writes + $3 <= $2`,
    [jobId, BG_MAX_WRITES, n],
  );
  return (r.rowCount ?? 0) > 0;
}

/** 실패한 쓰기의 예약(n 건)을 돌려준다. */
export async function releaseBgWrite(pool: Pool, jobId: string, n = 1): Promise<void> {
  await pool.query(`update bg_job set writes = greatest(writes - $2, 0) where id = $1`, [jobId, n]);
}

export async function recordBgChange(
  pool: Pool, jobId: string, slug: string, op: 'create' | 'update' | 'archive' | 'merge', afterUpdatedAt: Date | null,
): Promise<void> {
  await pool.query(
    `insert into bg_job_change (run_id, slug, op, after_updated_at) values ($1, $2, $3, $4)`,
    [jobId, slug, op, afterUpdatedAt],
  );
}

/** 증류 한 회차의 스레드 상한(설계 3절). 넘는 것은 다음 날로. */
export const DISTILL_MAX_THREADS = 10;
/** done 이 이만큼 유지된 스레드만 증류한다 — done 은 「지금 걸린 것 없음」이라 바로는 끝이 아니다(설계 2절). */
export const DISTILL_DONE_AGE_MS = 24 * 60 * 60 * 1000;
/** 생산자를 도는 간격. sweep 은 1분마다 돌지만 생산은 한 시간에 한 번이면 된다. */
export const DISTILL_PRODUCE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 증류 생산자(BG3). 스레드 메모가 있고(보관·쓰기 검사 걸림 제외) 그 스레드가 done 으로 24h 넘게 머문 (에이전트, 스레드)를
 * 에이전트마다 오래된 것부터 10개 묶어 하루 1회 넣는다. **그 에이전트가 지금 볼 수 있는 채널의 스레드만** — 회차의
 * message.read·thread.note 허용 목록이 이 입력으로 묶이므로, 못 보는 스레드가 섞이면 허용 목록이 그것을 열어 준다.
 * 창(03~07 KST)이 끝나기 전에만 넣는다 — 그 뒤에 넣으면 집지 못하고 다음 날 expired 로 닫힌다.
 */
export async function produceDistillJobs(pool: Pool, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ queued: number; refused: Record<string, number> }> {
  const out = { queued: 0, refused: {} as Record<string, number> };
  if (!backgroundEnabled(env)) return out;
  if (new Date(now.getTime() + KST_OFFSET_MS).getUTCHours() >= BG_WINDOW_KST[1]) return out;
  const r = await pool.query<{ account_id: string; threads: string[] }>(
    `select n.account_id, (array_agg(n.thread_root_id order by s.updated_at, n.thread_root_id))[1:$2] as threads
       from thread_note n
       join account a on a.id = n.account_id and a.kind = 'agent' and a.deleted_at is null
       join thread_status s on s.root_id = n.thread_root_id
       join message m on m.id = n.thread_root_id and m.deleted_at is null
       join channel c on c.id = m.channel_id
      where s.status = 'done' and s.updated_at < $1
        and n.archived_at is null and n.flag_reason is null
        and ${channelVisibleSql('c', 'n.account_id')}
      group by n.account_id`,
    [new Date(now.getTime() - DISTILL_DONE_AGE_MS), DISTILL_MAX_THREADS],
  );
  for (const row of r.rows) {
    const res = await enqueueBgJob(pool, { accountId: row.account_id, kind: 'distill', input: { threadIds: row.threads }, now }, env);
    if ('job' in res) out.queued += 1;
    else out.refused[res.refused] = (out.refused[res.refused] ?? 0) + 1;
  }
  return out;
}

/** 정리를 백그라운드 회차가 맡는가(BG5) — 전역 스위치 켜짐 + 소유자 토글 켬. 러너가 정리 신호를 뺄지 이것으로 정한다. */
export async function bgCleanupOn(pool: Pool, accountId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!backgroundEnabled(env)) return false;
  // 하네스도 본다(security n1) — 실행기(BG2)는 claude 만 집는다. 다른 하네스의 신호를 빼면 정리 일감은 아무도 안 집어
  // expired 로 닫히고, 그 에이전트는 아무도 정리하지 않게 된다. 그런 에이전트는 지금처럼 신호를 받는다.
  const r = await pool.query<{ bg_enabled: boolean; harness: string }>(`select bg_enabled, harness from agent_config where account_id = $1`, [accountId]);
  return r.rows[0]?.bg_enabled === true && r.rows[0].harness === BG_HARNESS;
}

/** 실행기(agent `bgExecutor.ts`)가 집는 하네스. 생산자·신호 판정이 같은 값을 본다. */
export const BG_HARNESS = 'claude-code';

/** 주간 정리를 거는 최소 항목 수 — 설계 3절 목표(`mem/*` < 60)를 넘은 에이전트만 주 1회. 신호가 켜지면 수와 상관없이. */
export const CLEANUP_WEEKLY_MIN_ITEMS = 60;
export const CLEANUP_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 정리 생산자(BG5) — 주간 정리(C3)와 정리 신호를 옮겨 온 것. 에이전트마다:
 * - 정리 신호가 켜졌으면(core 2,600자↑·항목 180↑·journal 이 곧 밀려남 — 러너 `memorySignals` 와 같은 문턱) 그날,
 * - 아니면 살아 있는 항목이 60개 이상이고 지난 7일에 정리 회차가 없을 때(주 1회)
 * cleanup 일감을 넣는다. (에이전트, cleanup, KST 날짜) 유일·소유자 토글·3연속 실패 멈춤·서버 하루 상한은 enqueue 가 본다.
 * 창(03~07 KST)이 끝난 뒤엔 넣지 않는다.
 */
export async function produceCleanupJobs(pool: Pool, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): Promise<{ queued: number; refused: Record<string, number> }> {
  const out = { queued: 0, refused: {} as Record<string, number> };
  if (!backgroundEnabled(env)) return out;
  if (new Date(now.getTime() + KST_OFFSET_MS).getUTCHours() >= BG_WINDOW_KST[1]) return out;
  const r = await pool.query<{ account_id: string; core_len: number; active: number; journals: number; recent: boolean }>(
    `select a.id as account_id,
            coalesce((select char_length(value) from agent_memory where account_id = a.id and slug = 'core'), 0)::int as core_len,
            (select count(*) from agent_memory where account_id = a.id and archived_at is null)::int as active,
            (select count(*) from agent_memory where account_id = a.id and kind = 'journal' and archived_at is null)::int as journals,
            exists (select 1 from bg_job j where j.account_id = a.id and j.kind = 'cleanup' and j.created_at > $1) as recent
       from account a
      where a.kind = 'agent' and a.deleted_at is null
        -- 실행기가 집는 하네스만 — 다른 하네스는 신호로 지금처럼 정리한다(bgCleanupOn 과 같은 판정).
        and exists (select 1 from agent_config ac where ac.account_id = a.id and ac.harness = $2)
        and exists (select 1 from agent_memory m where m.account_id = a.id)`,
    [new Date(now.getTime() - CLEANUP_WEEKLY_MS), BG_HARNESS],
  );
  for (const row of r.rows) {
    const reasons: string[] = [];
    if (row.core_len >= MEMORY_CORE_WARN_CHARS) reasons.push('core_near_limit');
    if (row.active >= MEMORY_ITEMS_WARN_COUNT) reasons.push('items_near_limit');
    if (row.journals > MAX_JOURNAL_MEMORIES_PER_ACCOUNT - JOURNAL_EXPIRING_WINDOW) reasons.push('journal_expiring');
    if (!reasons.length && row.active >= CLEANUP_WEEKLY_MIN_ITEMS && !row.recent) reasons.push('weekly');
    if (!reasons.length) continue;
    const res = await enqueueBgJob(pool, { accountId: row.account_id, kind: 'cleanup', input: { reasons }, now }, env);
    if ('job' in res) out.queued += 1;
    else out.refused[res.refused] = (out.refused[res.refused] ?? 0) + 1;
  }
  return out;
}

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

export const BG_SWEEP_INTERVAL_MS = 60_000;

/**
 * 뼈대 sweep. 스위치가 꺼져 있으면 아무것도 안 한다. 지금 하는 일은 닫기뿐이다 — 집고 죽은 회차(timeout)와
 * 지난 날의 집히지 않은 일감(expired). 종류별 생산자는 BG3 에서 이 자리에 붙는다.
 */
export function createBgJobSweeper(pool: Pool, env: NodeJS.ProcessEnv = process.env): { startSweep(app: SweepHost): void; sweep(now?: Date): Promise<void> } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let lastProducedAt = 0;
  const sweep = async (now: Date = new Date()) => {
    if (!backgroundEnabled(env) || running) return;
    running = true;
    try {
      // 생산(BG3)은 한 시간에 한 번. (에이전트, 종류, 날짜) 유일이라 더 자주 돌아도 늘지 않지만 질의를 아낀다.
      if (now.getTime() - lastProducedAt >= DISTILL_PRODUCE_INTERVAL_MS) {
        lastProducedAt = now.getTime();
        const p = await produceDistillJobs(pool, now, env);
        if (p.queued || Object.keys(p.refused).length) console.log(`bg: distill queued=${p.queued} refused=${JSON.stringify(p.refused)}`);
        const c = await produceCleanupJobs(pool, now, env);
        if (c.queued || Object.keys(c.refused).length) console.log(`bg: cleanup queued=${c.queued} refused=${JSON.stringify(c.refused)}`);
      }
      await pool.query(
        `update bg_job set status = 'failed', error = 'timeout', finished_at = now()
         where status = 'running' and claimed_at < $1`,
        [new Date(now.getTime() - BG_STALE_RUNNING_MS)],
      );
      await pool.query(
        `update bg_job set status = 'skipped', error = 'expired', finished_at = now()
         where status = 'queued' and day < $1::date`,
        [kstDay(now)],
      );
    } catch (err) {
      // 던지면 처리 안 된 거절로 프로세스가 죽는다(agentWakes sweep 과 같은 이유) — 다음 주기에 다시 한다.
      console.error('bg job sweep error:', err);
    } finally {
      running = false;
    }
  };
  return {
    sweep,
    startSweep(app) {
      if (timer) return;
      timer = setInterval(() => { void sweep(); }, BG_SWEEP_INTERVAL_MS);
      timer.unref?.();
      app.addHook('onClose', () => { if (timer) clearInterval(timer); timer = null; });
    },
  };
}
