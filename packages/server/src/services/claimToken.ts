import type { Pool } from 'pg';

/** sha256 해시 한 개의 모양. 잘못된 값이 조용히 심기는 것을 막는다. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `CLAIM_TOKEN_HASH` 를 `claim_token` 테이블에 심는다. 기동 시 한 번 부른다.
 *
 * ## 왜 env 로 받고 DB 에 넣는가
 *
 * 토큰은 워크스페이스를 만드는 쪽(harkroom-gate)이 SealedSecret 으로 심어 주므로 env 로
 * 들어온다. 그런데 **소진 여부는 env 에 적을 수 없다** — env 에만 두면 파드가 재시작될
 * 때마다 이미 쓴 토큰이 되살아나고, 그것은 "한 번만" 이라는 성질이 없어지는 것이다.
 *
 * 그래서 `on conflict do nothing` 이다. 두 번째 기동부터는 아무것도 하지 않고, **소진
 * 기록(`used_at`)을 덮어쓰지 않는다.** 이 한 줄이 재시작이 토큰을 되살리지 못하게 막는
 * 유일한 장치다.
 *
 * ## 원문이 아니라 해시를 받는다
 *
 * env 이름이 `CLAIM_TOKEN`이 아니라 `CLAIM_TOKEN_HASH` 인 이유: 원문을 env 로 주면
 * 그 값이 파드 스펙·`kubectl describe`·크래시 덤프에 그대로 남는다. 해시만 주면 서버는
 * 검증할 수 있고(오는 토큰을 해시해 비교), 그 값이 새도 토큰이 되지는 않는다.
 *
 * @returns 실제로 새 행을 심었으면 true. 이미 있었으면 false.
 */
export async function seedClaimToken(pool: Pool, rawEnv: string | undefined): Promise<boolean> {
  const hash = rawEnv?.trim().toLowerCase();
  if (!hash) return false;

  // **형식을 검사하고 거절한다.** 원문을 실수로 넣은 경우가 여기서 걸린다 — 그대로 심으면
  // 서버는 정상으로 보이지만 어떤 토큰으로도 클레임이 안 되고(오는 토큰의 해시와 절대
  // 같아지지 않는다), 그 사실이 클레임을 시도할 때까지 드러나지 않는다.
  if (!SHA256_HEX.test(hash)) {
    throw new Error('CLAIM_TOKEN_HASH must be a sha256 hex digest (64 hex chars) — not the token itself');
  }

  const res = await pool.query(
    `insert into claim_token (token_hash) values ($1) on conflict (token_hash) do nothing`,
    [hash],
  );
  return (res.rowCount ?? 0) > 0;
}
