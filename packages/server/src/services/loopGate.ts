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
 *
 * **문지기 연결은 풀마다 하나를 함께 쓴다**(security n2). tick 마다 따로 빌리면 루프 10개가 한꺼번에 돌 때 풀(POOL_MAX 20) 중 10개가
 * 문지기 몫이 되고, sweep 연결까지 더하면 요청이 connect timeout 을 맞는다. 그래서 돌고 있는 tick 이 있는 동안 연결 하나를 쥐고 여럿이
 * 같이 쓰다가, 마지막 tick 이 끝나면 돌려준다(쥐고만 있으면 `pool.end()` 가 기다린다). 잠금은 이름마다 키가 달라 한 세션에서 서로를
 * 막지 않는다. 같은 이름의 tick 이 이 프로세스에서 겹치면(sweep 이 주기보다 길 때) 뒤 것은 `'busy'` 로 건너뛴다 — 세션 잠금은
 * 재진입되므로 한 세션 안의 겹침은 잠금이 막지 못한다.
 *
 * **unlock 이 실패하면 연결째 버린다**(security n1). 잠금이 남은 연결을 풀로 돌려보내면 그 루프는 다른 프로세스에서 계속 locked 가 되고,
 * 그 연결을 다시 집은 tick 만 돈다. 버리면 서버가 그 세션의 잠금을 모두 푼다 — 같은 연결을 쓰던 다른 tick 의 잠금도 함께 풀리지만,
 * unlock 이 실패했다는 것은 대개 그 연결이 이미 죽었다는 뜻이라(잠금도 이미 풀렸다) 더 열리는 것은 없다. 행 단위 `skip locked` 는 그대로다.
 */
import type { Pool, PoolClient } from 'pg';

/** advisory lock 의 class — 'LOOP'. Rust `loops::LOOP_LOCK_CLASS` 와 같아야 한다. */
export const LOOP_LOCK_CLASS = 0x4c4f4f50;

export type LoopSide = 'ts' | 'rust';

export type GateResult = 'ran' | 'locked' | 'not_owner' | 'busy' | 'error';

/** 루프 이름 — Rust `loops::LOOP_NAMES` 와 같아야 한다. 주인 표(`server_loop.name`)의 키다. */
export const LOOP_NAMES = [
  'wake', 'delegation.deadline', 'automation', 'scheduled', 'push',
  'permission.expire', 'mandate.idle', 'bg', 'retention', 'stale', 'bg.produce', 'outbox.prune',
] as const;
export type LoopName = typeof LOOP_NAMES[number];

/** 풀마다 함께 쓰는 문지기 연결. `users` 는 그 연결을 쓰고 있는 tick 수다. */
interface Shared { conn: Promise<PoolClient>; users: number; dropped: boolean }
const sharedByPool = new WeakMap<Pool, Shared>();
/** 이 프로세스(풀)에서 지금 돌고 있는 루프 이름. */
const busyByPool = new WeakMap<Pool, Set<string>>();

function borrow(pool: Pool): Shared {
  let s = sharedByPool.get(pool);
  if (!s) {
    const fresh: Shared = { conn: pool.connect(), users: 0, dropped: false };
    fresh.conn.catch(() => { if (sharedByPool.get(pool) === fresh) sharedByPool.delete(pool); });
    sharedByPool.set(pool, fresh);
    s = fresh;
  }
  s.users += 1;
  return s;
}

/** tick 하나가 문지기 연결을 다 썼다. `err` 가 있으면 연결째 버린다(n1). 마지막 사용자면 풀로 돌려준다. */
function giveBack(pool: Pool, s: Shared, client: PoolClient | null, err?: Error): void {
  s.users -= 1;
  if (err) {
    if (sharedByPool.get(pool) === s) sharedByPool.delete(pool);
    if (client && !s.dropped) { s.dropped = true; client.release(err); }
    return;
  }
  if (s.users === 0 && !s.dropped) {
    if (sharedByPool.get(pool) === s) sharedByPool.delete(pool);
    s.dropped = true;
    client?.release();
  }
}

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
  let busy = busyByPool.get(pool);
  if (!busy) { busy = new Set(); busyByPool.set(pool, busy); }
  if (busy.has(name)) return 'busy';
  busy.add(name);
  const s = borrow(pool);
  let client: PoolClient | null = null;
  let locked = false;
  let unlockErr: Error | undefined;
  let inSweep = false;
  try {
    client = await s.conn;
    locked = (await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock($1, hashtext($2)) as ok', [LOOP_LOCK_CLASS, name])).rows[0]!.ok;
    if (!locked) return 'locked';
    const owner = (await client.query<{ owner: LoopSide }>(
      `select owner from server_loop where name = $1`, [name])).rows[0]?.owner ?? 'ts';
    if (owner !== side) return 'not_owner';
    inSweep = true;
    await sweep();
    return 'ran';
  } catch (err) {
    onError(err);
    // 문지기 쿼리(잠금·주인 읽기)가 실패했으면 그 연결은 믿을 수 없다 — 버린다. sweep 의 실패는 연결과 무관하다.
    if (!inSweep && client) unlockErr = err instanceof Error ? err : new Error(String(err));
    return 'error';
  } finally {
    if (locked && client && !unlockErr) {
      try {
        await client.query('select pg_advisory_unlock($1, hashtext($2))', [LOOP_LOCK_CLASS, name]);
      } catch (err) {
        unlockErr = err instanceof Error ? err : new Error(String(err));
        onError(unlockErr);
      }
    }
    giveBack(pool, s, client, unlockErr ?? (client ? undefined : new Error('connect failed')));
    busy.delete(name);
  }
}
