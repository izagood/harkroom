import type { Pool } from 'pg';

/**
 * 보관소 잠금 해제(step-up) — 로그인한 세션이 비밀번호를 **한 번 더** 대면 그 세션만 잠깐 민감한 일을 할 수 있다.
 * 지금 쓰는 곳은 비밀 보관소 소유자 보기(`POST /secrets/:id/reveal`) 하나다.
 *
 * 창의 규칙(jaebin 정정, 스레드 464aff1c): 한 번 풀면 여러 값을 본다. **볼 때마다 15분 밀리고**(`extendStepUp`),
 * **처음 푼 때부터 1시간**을 넘지 못한다. 잠그기·설정 닫기는 `endStepUp` 으로 바로 끝낸다.
 *
 * 왜 세션 칸인가: 푼 사실을 클라이언트가 들고 다니면(토큰·쿠키) 그것도 훔칠 수 있는 것이 하나 더 는다.
 * 서버가 그 세션 행에 시각만 적으면, 푼 기기의 그 세션 말고는 아무것도 열리지 않는다. 화면은 만료 시각을
 * 따로 셈하지 않고 서버가 돌려준 `steppedUpUntil` 로만 그린다.
 */
export const STEP_UP_IDLE_MS = 15 * 60_000;
export const STEP_UP_MAX_MS = 60 * 60_000;

/** 비밀번호를 확인한 직후 — 창을 새로 연다(1시간 상한도 지금부터 다시 센다). */
export async function openStepUp(pool: Pool, credentialHash: string, now = new Date()): Promise<Date> {
  const r = await pool.query(
    `update session set stepped_up_at = $2, stepped_up_until = $2::timestamptz + $3 * interval '1 millisecond'
      where token_hash = $1 returning stepped_up_until as "until"`,
    [credentialHash, now, STEP_UP_IDLE_MS]);
  return (r.rows[0] as { until: Date }).until;
}

/** 이 세션의 창이 지금 열려 있으면 그 끝 시각, 아니면 null. 세션이 아닌 인증(PAT·오퍼레이터)은 늘 null 이다. */
export async function currentStepUp(pool: Pool, credentialHash: string | null | undefined, now = new Date()): Promise<Date | null> {
  if (!credentialHash) return null;
  const r = await pool.query(
    `select stepped_up_until as "until" from session
      where token_hash = $1 and expires_at > $2 and stepped_up_until > $2`,
    [credentialHash, now]);
  return (r.rows[0] as { until: Date } | undefined)?.until ?? null;
}

/**
 * 값을 하나 내줬다 — 창을 지금부터 15분으로 밀되 처음 푼 때 + 1시간을 넘기지 않는다. 이미 닫혔으면 열지 않는다(null).
 * 판정과 연장을 한 줄의 조건부 update 로 해서, 그 사이 다른 요청이 잠갔으면 되살리지 않는다.
 */
export async function extendStepUp(pool: Pool, credentialHash: string, now = new Date()): Promise<Date | null> {
  const r = await pool.query(
    `update session
        set stepped_up_until = least($2::timestamptz + $3 * interval '1 millisecond',
                                     stepped_up_at + $4 * interval '1 millisecond')
      where token_hash = $1 and stepped_up_until > $2 and stepped_up_at is not null
      returning stepped_up_until as "until"`,
    [credentialHash, now, STEP_UP_IDLE_MS, STEP_UP_MAX_MS]);
  return (r.rows[0] as { until: Date } | undefined)?.until ?? null;
}

/** 잠그기 — 멱등. 창 기록이 남아 있었으면 true(감사 기록용 — 이미 시간이 지난 창도 true 다). */
export async function endStepUp(pool: Pool, credentialHash: string): Promise<boolean> {
  const r = await pool.query(
    `update session set stepped_up_at = null, stepped_up_until = null
      where token_hash = $1 and stepped_up_until is not null`, [credentialHash]);
  return (r.rowCount ?? 0) > 0;
}
