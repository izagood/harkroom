/**
 * 첨부 저장의 진행 상태(2026-10-23 P2, jaebin 결정 92bf2dea D3). 칩·확대 보기·미리보기 패널이 **이 값 하나**를
 * 같이 본다 — 셋이 따로 세면 같은 파일이 자리마다 다른 %를 말한다.
 *
 * - `choosing`: 저장 창이 떠 있다.
 * - `fetching`: 고른 뒤 바이트를 받는 중. `total` 은 서버의 `content-length` — 모르거나 0 이면 `null` 이고, 화면은
 *   %를 지어내지 않고 「받는 중…」만 말한다.
 * - `failed`: 받기에 실패했다. 칩이 「받기 실패 · 다시」를 말하고 다시 누를 수 있다(다시 누르면 저장 창부터).
 */
export type AttachmentSaveState =
  | { phase: 'choosing' }
  | { phase: 'fetching'; loaded: number; total: number | null }
  | { phase: 'failed' };

/** 저장 창이 떠 있거나 받는 중이면 참 — 그동안은 다시 누르지 못한다. */
export function isSaveBusy(s: AttachmentSaveState | undefined): boolean {
  return s?.phase === 'choosing' || s?.phase === 'fetching';
}

/** 받은 비율(0~100 정수). 전체를 모르면 `null`. */
export function savePercent(s: AttachmentSaveState | undefined): number | null {
  if (s?.phase !== 'fetching' || !s.total) return null;
  return Math.min(100, Math.floor((s.loaded / s.total) * 100));
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

function unitOf(bytes: number): number {
  let unit = 0;
  let value = bytes;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  return unit;
}

function inUnit(bytes: number, unit: number): string {
  if (unit === 0 || bytes === 0) return String(bytes);
  const value = bytes / 1024 ** unit;
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}

/** `3.1/7.5 MB` — 단위는 **전체** 쪽에 맞춰 한 번만 적는다(designer 기준). */
export function formatProgressBytes(loaded: number, total: number): string {
  const unit = unitOf(total);
  return `${inUnit(Math.min(loaded, total), unit)}/${inUnit(total, unit)} ${UNITS[unit]}`;
}

/**
 * 받는 동안 가게에 진행을 얼마나 자주 적나. 조각마다 적으면 큰 파일에서 칩·패널이 수천 번 다시 그려진다.
 * %가 바뀌었을 때만 적고, 전체를 모르면 이 바이트마다 한 번 적는다.
 */
export const UNKNOWN_TOTAL_STEP = 256 * 1024;
