// 날짜 구분선의 날짜 계산(#220). 경계는 **로컬 시간대** 기준이다 — UTC 로 자르면
// 사용자가 보는 "오늘"과 어긋난다(UTC+9 에서는 오전 9시 이전 메시지가 전날로 밀린다).

const pad = (n: number): string => `${n}`.padStart(2, '0');

/** 로컬 달력 하루를 가리키는 키. 같은 키면 같은 날이다. */
const keyOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ISO 타임스탬프가 속한 로컬 하루의 키. */
export function localDayKey(iso: string): string {
  return keyOf(new Date(iso));
}

/**
 * 구분선에 적을 날짜 표기. 가까운 날은 상대어가 더 빨리 읽히고, 먼 날은 상대어가
 * 오히려 세어 봐야 하는 값이 되므로 절대 날짜로 넘어간다.
 *
 * 로캘을 비워(`[]`) 사용자의 것을 따른다 — 하드코딩하면 날짜 순서(Y/M/D)가 남의 관습이 된다.
 */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const key = keyOf(d);
  if (key === keyOf(now)) return '오늘';
  // 로컬 자정 기준으로 하루를 빼야 DST 로 23시간·25시간이 되는 날에도 어제가 어제다.
  if (key === keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return '어제';
  return d.toLocaleDateString([]);
}
