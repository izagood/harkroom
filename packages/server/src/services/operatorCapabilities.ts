/**
 * AC6 — 하네스가 밝힌 모델 목록을 찾는다. 먼저 이 프로세스의 오퍼레이터 허브를 보고, 거기 없으면
 * Rust 가 적은 스냅숏(`operator_capability`, 마이그레이션 174)을 본다 — 오퍼레이터 코어가 Rust
 * (`HARKROOM_CORE=rust`)에 있으면 TS 허브는 비어 있다.
 *
 * - 스냅숏은 `seen_at` 이 {@link SNAPSHOT_FRESH_SEC} 초보다 낡으면 「모른다」(undefined)다. Rust 는 붙어 있는
 *   오퍼레이터의 `seen_at` 을 60초마다 고치므로, 지우지 못하고 죽은 프로세스의 줄은 여기서 걸러진다.
 * - 오퍼레이터가 보낸 값이라 모양을 믿지 않는다. 문자열 `id` 가 있는 항목만 남기고, `efforts` 는 문자열만 남긴다.
 *   목록이 아니면 「모른다」다. 「모른다」는 막지 않는 쪽이다(`checkOffered` 와 같은 원칙).
 */
import type { HarnessModel } from '@harkroom/shared';
import type { Pool } from 'pg';
import type { OperatorHub } from '../ws/operatorHub.js';

export const SNAPSHOT_FRESH_SEC = 180;

function narrowModels(raw: unknown): HarnessModel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HarnessModel[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object' || typeof (m as { id?: unknown }).id !== 'string') continue;
    const { id, label, efforts } = m as { id: string; label?: unknown; efforts?: unknown };
    out.push({
      id,
      ...(typeof label === 'string' ? { label } : {}),
      ...(Array.isArray(efforts) ? { efforts: efforts.filter((e): e is string => typeof e === 'string') } : {}),
    });
  }
  return out;
}

function modelsIn(caps: unknown, harness: string): HarnessModel[] | undefined {
  if (!caps || typeof caps !== 'object') return undefined;
  const harnesses = (caps as { harnesses?: unknown }).harnesses;
  if (!harnesses || typeof harnesses !== 'object' || Array.isArray(harnesses)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(harnesses, harness)) return undefined;
  const h = (harnesses as Record<string, unknown>)[harness];
  if (!h || typeof h !== 'object') return undefined;
  return narrowModels((h as { models?: unknown }).models);
}

/** 그 오퍼레이터에서 그 하네스가 밝힌 모델 목록. 모르면 undefined. */
export async function offeredModels(
  pool: Pool, hub: OperatorHub | undefined, operatorId: string, harness: string,
): Promise<HarnessModel[] | undefined> {
  const live = hub?.capabilities(operatorId);
  if (live) return modelsIn(live, harness);
  const r = await pool.query<{ body: unknown }>(
    `select body from operator_capability
      where operator_id = $1 and seen_at > now() - make_interval(secs => $2)`,
    [operatorId, SNAPSHOT_FRESH_SEC]);
  return r.rows[0] ? modelsIn(r.rows[0].body, harness) : undefined;
}
