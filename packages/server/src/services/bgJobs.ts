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
  const r = await pool.query<{ id: string }>(
    `insert into bg_job (account_id, kind, day, input)
     select $1, $2, $3::date, $4::jsonb
     where (select count(*) from bg_job where day = $3::date) < $5
     on conflict (account_id, kind, day) do nothing
     returning id`,
    [input.accountId, input.kind, day, JSON.stringify(input.input), backgroundDailyMax(env)],
  );
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
  const r = await pool.query(
    `update bg_job set status = $3, summary = $4, error = $5, tokens = $6, duration_ms = $7, finished_at = now()
     where id = $1 and account_id = $2 and status = 'running'`,
    [jobId, accountId, c.status, c.summary ?? null, c.error ?? null, c.tokens ?? null, c.durationMs ?? null],
  );
  if (r.rowCount) return 'ok';
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
  const sweep = async (now: Date = new Date()) => {
    if (!backgroundEnabled(env) || running) return;
    running = true;
    try {
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
