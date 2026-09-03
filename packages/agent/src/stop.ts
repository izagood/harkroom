/**
 * 종료 요청 판정(#129). murmur 는 러너를 죽이지 못하므로 — 러너를 띄우지도 않는다 —
 * 서버가 할 수 있는 것은 정의에 시각을 남기는 것까지고, 물러날지는 이 러너가 정한다.
 *
 * 왜 불리언이 아니라 시각 비교인가: 요청은 컬럼에 남고 저절로 지워지지 않는다. 값의
 * 존재만 보고 종료하면, 운영자가 종료를 요청해 러너가 물러난 뒤 새로 띄운 러너가 같은
 * 값을 읽고 곧바로 또 죽는다 — 다시는 뜨지 않는 에이전트가 된다. 내 기동 시각보다
 * **나중에** 온 요청만 나를 향한 것이다.
 *
 * 파싱할 수 없는 값은 요청으로 보지 않는다. 종료는 되돌리는 데 사람 손이 필요한 동작이라
 * (murmur 가 다시 띄우지 못한다) 확실할 때만 한다.
 */
export function stopRequestedForRunner(
  stopRequestedAt: string | null | undefined, startedAtMs: number,
): boolean {
  if (!stopRequestedAt) return false;
  const at = Date.parse(stopRequestedAt);
  return Number.isFinite(at) && at > startedAtMs;
}
