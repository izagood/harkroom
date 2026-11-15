/**
 * 서버 루프 문지기(S5.3 C5, Rust 전환) — 한 sweep 루프가 TS·Rust 두 프로세스에서 **동시에, 또는 둘 다** 도는 일을 막는다.
 *
 * tick 마다:
 * 1. 풀에서 연결 하나를 빌려 `pg_try_advisory_lock(LOOP_LOCK_CLASS, hashtext(name))` — 못 잡으면 이 tick 은 건너뛴다.
 * 2. 잡은 채로 `server_loop` 에서 주인을 읽는다(줄이 없으면 `ts`). 내가 주인이 아니면 건너뛴다.
 * 3. 주인이면 sweep 을 돌리고, 끝나면(던져도) 잠금을 푼다.
 *
 * Rust 쪽(`crates/harkroom-server/src/loops.rs`)도 **같은 class·같은 키**로 같은 순서를 밟는다. 그래서 주인을 바꾸는 순간 앞
 * 주인의 tick 이 아직 돌고 있어도 새 주인은 잠금을 못 잡아 그 tick 을 건너뛴다 — 겹치는 순간이 없다.
 *
 * 세션 잠금을 쓰는 이유: sweep 은 행마다 자기 트랜잭션을 연다(배치 롤백이 재발송을 만든다 — scheduledMessages.ts). 트랜잭션 잠금
 * (`_xact_`)으로는 tick 전체를 감쌀 수 없다. 잠금을 쥔 연결은 sweep 이 쓰는 연결과 따로다 — 그 연결이 끊기면 서버가 잠금을 푼다.
 */
import type { Pool } from 'pg';

/** advisory lock 의 class — 'LOOP'. Rust `loops::LOOP_LOCK_CLASS` 와 같아야 한다. */
export const LOOP_LOCK_CLASS = 0x4c4f4f50;

export type LoopSide = 'ts' | 'rust';

export type GateResult = 'ran' | 'locked' | 'not_owner' | 'error';

/** 루프 이름 — Rust `loops::LOOP_NAMES` 와 같아야 한다. 주인 표(`server_loop.name`)의 키다. */
export const LOOP_NAMES = [
  'wake', 'delegation.deadline', 'automation', 'scheduled', 'push',
  'permission.expire', 'mandate.idle', 'bg', 'retention', 'stale',
] as const;
export type LoopName = typeof LOOP_NAMES[number];

/**
 * `name` 루프의 tick 하나를 문지기 아래서 돌린다. 이 프로세스(`side`)가 주인이고 잠금을 잡았을 때만 `sweep` 을 부른다.
 * 던지지 않는다 — `setInterval(() => void runGated(…))` 로 부르므로, 연결 실패·sweep 예외는 `onError` 로 넘기고 `'error'` 를 돌려준다
 * (던지면 처리 안 된 rejection 이 프로세스를 죽인다; 기본 onError 는 오류 문구만 찍는다). 잠금은 sweep 이 던져도 푼다.
 */
export async function runGated(
  pool: Pool, name: LoopName, sweep: () => Promise<unknown>,
  opts: { side?: LoopSide; onError?: (err: unknown) => void } = {},
): Promise<GateResult> {
  const side = opts.side ?? 'ts';
  const onError = opts.onError ?? ((err: unknown) => console.error(`loop ${name} error:`, err instanceof Error ? err.message : err));
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    onError(err);
    return 'error';
  }
  let locked = false;
  try {
    locked = (await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock($1, hashtext($2)) as ok', [LOOP_LOCK_CLASS, name])).rows[0]!.ok;
    if (!locked) return 'locked';
    const owner = (await client.query<{ owner: LoopSide }>(
      `select owner from server_loop where name = $1`, [name])).rows[0]?.owner ?? 'ts';
    if (owner !== side) return 'not_owner';
    await sweep();
    return 'ran';
  } catch (err) {
    onError(err);
    return 'error';
  } finally {
    if (locked) await client.query('select pg_advisory_unlock($1, hashtext($2))', [LOOP_LOCK_CLASS, name]).catch(() => {});
    client.release();
  }
}
