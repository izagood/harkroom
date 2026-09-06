/**
 * "N분 전". 1분 미만은 '방금' 이다 — **"0분 전"은 사람이 쓰지 않는 말이다.**
 *
 * `LeasePanel` 안에 있던 것을 뽑았다. 투영 사정을 말하는 자리가 둘이 됐고(위쪽 띠와
 * 리스 목록 위), 같은 문장을 두 벌 쓰면 "3분 전"과 "방금"의 경계가 갈라진다.
 */
export function minutesAgo(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '방금';
  return `${minutes}분 전`;
}
