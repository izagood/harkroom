import type { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { createSecretKeyring, keyCheckValue, type LoadedSecretKeys, type SecretKeyring } from './secretKeyring.js';

/**
 * 기동 때 키 묶음을 DB 의 키 확인값(104 `secret_key_check`)과 맞춰 본다.
 *
 * - **행이 있으면** 마운트한 키의 KCV 와 비교한다. 다르면 그 kid 를 키링에서 뺀다 — 그 kid 로는
 *   봉인도 풀기도 하지 않는다. 틀린 키로 새 값을 봉인하는 순간 값이 섞이기 때문이다.
 * - **행이 없으면** 넣기 전에, 그 kid 로 봉인된 값이 이미 있는지 본다. 있으면 그중 하나를 실제로
 *   풀어(AEAD 태그 통과) 이 키가 맞는다는 것을 확인한 뒤에만 넣는다. 그냥 넣으면 이 기능이
 *   배포되는 순간 걸려 있던 키를 — 틀렸더라도 — 정답으로 박는다. 값이 없으면 그냥 넣는다.
 * - 넣기는 `on conflict do nothing` 뒤 **다시 읽어** 비교한다. 서버 둘이 동시에 떠도 먼저 넣은
 *   쪽이 기준이 되고 뒤의 것은 그것과 비교된다.
 * - KCV 를 고쳐 쓰는 길은 없다. 키를 바꾸려면 새 kid 를 넣고 활성 kid 를 옮긴다 — 옛 kid 가
 *   디렉터리에서 사라지는 것은 막지 않는다(그 값들은 목록에서 keyLost 로 보인다).
 *
 * 활성 kid 가 빠지면 키링은 null(보관소 꺼짐)이고 `mismatch` 가 true 다 — 라우트가 꺼진 이유를
 * 구분해 답한다.
 */
export interface VerifiedSecretKeys {
  keyring: SecretKeyring | null;
  /** 활성 kid 가 DB 의 확인값과 맞지 않아 보관소를 껐다. */
  mismatch: boolean;
  /** 확인값이 맞지 않아 뺀 kid 들. 로그용 — 화면에 싣지 않는다. */
  rejectedKids: string[];
}

export async function verifySecretKeys(pool: Pool, loaded: LoadedSecretKeys): Promise<VerifiedSecretKeys> {
  const accepted = new Map<string, Buffer>();
  const rejectedKids: string[] = [];
  for (const [kid, key] of loaded.keys) {
    if (await keyMatches(pool, kid, key)) accepted.set(kid, key);
    else rejectedKids.push(kid);
  }
  if (!accepted.has(loaded.activeKid)) return { keyring: null, mismatch: true, rejectedKids };
  return { keyring: createSecretKeyring(accepted, loaded.activeKid), mismatch: false, rejectedKids };
}

async function storedKcv(pool: Pool, kid: string): Promise<Buffer | null> {
  const r = await pool.query<{ kcv: Buffer }>('select kcv from secret_key_check where kid = $1', [kid]);
  return r.rows[0]?.kcv ?? null;
}

async function keyMatches(pool: Pool, kid: string, key: Buffer): Promise<boolean> {
  const mine = keyCheckValue(key);
  let stored = await storedKcv(pool, kid);
  if (!stored) {
    if (!(await opensExistingValue(pool, kid, key))) return false;
    await pool.query('insert into secret_key_check (kid, kcv) values ($1, $2) on conflict (kid) do nothing', [kid, mine]);
    stored = await storedKcv(pool, kid);
    if (!stored) return false;
  }
  return stored.length === mine.length && timingSafeEqual(stored, mine);
}

/** 이 kid 로 봉인된 값이 없으면 true, 있으면 그중 하나가 이 키로 풀리는지. */
async function opensExistingValue(pool: Pool, kid: string, key: Buffer): Promise<boolean> {
  // kid 는 `_` 를 쓸 수 있어 like 로 찾으면 와일드카드가 된다 — 봉투의 두 번째 칸을 그대로 비교한다.
  const r = await pool.query<{ secretId: string; version: number; kind: 'text' | 'file'; sealed: string }>(
    `select v.secret_id as "secretId", v.version, s.kind, v.sealed
       from secret_version v join secret s on s.id = v.secret_id
      where v.sealed is not null and split_part(v.sealed, '.', 1) = 'v2' and split_part(v.sealed, '.', 2) = $1
      limit 1`, [kid]);
  const row = r.rows[0];
  if (!row) return true;
  const plain = createSecretKeyring(new Map([[kid, key]]), kid)
    .open(row.sealed, { secretId: row.secretId, version: row.version, kind: row.kind });
  if (!plain) return false;
  plain.fill(0);
  return true;
}
