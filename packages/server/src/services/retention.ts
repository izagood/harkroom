import type { Pool } from 'pg';
import type { SweepHost } from './delegations.js';

/**
 * 자라기만 하던 표의 보존 기간 정리(2026-10-13 쿼리 개선 Q5-c, jaebin 결정 #task 9cb9fdcd 「데이터 정리만(추천대로)」).
 *
 * **지우는 것은 둘뿐이다** — 표와 조건은 아래 상수로만 정하고 요청 값을 받지 않는다(security):
 * - `idempotency_key`: 만든 지 7일 지난 것. 같은 요청이 두 번 실행되지 않게 막는 재시도 창(분~시간)보다 훨씬 길다.
 *   7일 지난 같은 키로 다시 보내면 새 요청으로 실행된다 — 재시도로 그렇게 늦게 오는 요청은 없다.
 * - `session`: 만료된 지 30일 지난 것. 이미 쓸 수 없는 토큰 해시다(폐기는 행을 지우는 것이라 따로 남는 행이 없다).
 *   만료 전 세션은 건드리지 않는다. `push_device` 는 세션을 cascade 로 따라 지워진다 — 만료된 세션의 기기는 이미
 *   푸시를 받지 못한다(`pushJobs.ts` 가 `s.expires_at > now()` 인 기기에만 보낸다).
 *
 * **지우지 않는 것**(같은 결정): `secret_turn_lease`(「(에이전트, cause) 당 평생 하나」 약속이 행에 기댄다 — security),
 * 읽은 `inbox`(보드·모바일 기록), `audit_log`·`secret_access_log`(감사 기록, audit_log 는 append-only 트리거).
 *
 * 한 시간마다 표마다 `RETENTION_BATCH` 줄까지만 지운다 — 처음 켤 때 쌓인 것이 많아도 한 번에 큰 삭제로 표를 붙잡지 않는다.
 * **처음 도는 sweep 은 지우기 전에 표마다 지울 대상 수를 세어 로그에 남긴다**(jaebin 조건). 로그에는 표 이름과 수만
 * 남기고 행 내용(토큰 해시·키 값)은 남기지 않는다.
 */
export const RETENTION_RULES = [
  { table: 'idempotency_key', where: `created_at < now() - interval '7 days'` },
  { table: 'session', where: `expires_at < now() - interval '30 days'` },
] as const;

export const RETENTION_BATCH = 1000;
export const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
/** 기동 직후에는 몰리는 일이 많다 — 첫 sweep 은 잠깐 뒤에. */
export const RETENTION_FIRST_DELAY_MS = 5 * 60_000;

export function createRetentionSweeper(pool: Pool, opts: { log?: (msg: string) => void } = {}): {
  startSweep(app: SweepHost): void;
  sweep(): Promise<{ table: string; deleted: number }[]>;
} {
  const log = opts.log ?? ((m: string) => console.log(m));
  let counted = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  async function sweep(): Promise<{ table: string; deleted: number }[]> {
    if (running) return [];
    running = true;
    try {
      if (!counted) {
        for (const r of RETENTION_RULES) {
          const c = await pool.query<{ n: string }>(`select count(*) as n from ${r.table} where ${r.where}`);
          log(`retention: ${r.table} eligible=${c.rows[0]?.n ?? '0'} (first sweep, before deleting)`);
        }
        counted = true;
      }
      const out: { table: string; deleted: number }[] = [];
      for (const r of RETENTION_RULES) {
        const res = await pool.query(
          `delete from ${r.table} where ctid in (select ctid from ${r.table} where ${r.where} limit ${RETENTION_BATCH})`);
        const deleted = res.rowCount ?? 0;
        out.push({ table: r.table, deleted });
        if (deleted) log(`retention: ${r.table} deleted=${deleted}`);
      }
      return out;
    } finally {
      running = false;
    }
  }

  const tick = () => {
    // 실패는 다음 시각에 다시 한다 — 정리는 늦어도 해가 없다. 오류 문구만 남긴다(행 내용 없음).
    void sweep().catch((err: unknown) => console.error('retention sweep error:', err instanceof Error ? err.message : err));
  };

  return {
    sweep,
    startSweep(app) {
      if (timer || interval) return;
      timer = setTimeout(() => {
        timer = null;
        tick();
        interval = setInterval(tick, RETENTION_SWEEP_INTERVAL_MS);
        interval.unref?.();
      }, RETENTION_FIRST_DELAY_MS);
      timer.unref?.();
      app.addHook('onClose', async () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (interval) { clearInterval(interval); interval = null; }
      });
    },
  };
}
