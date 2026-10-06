/**
 * **채널의 어느 seq 구간을 실제로 받아 왔는가**(2026-10-06, 메시지 링크 이동이 외톨이 줄로 가던 결함).
 *
 * 스토어의 채널 목록은 "한 번이라도 손에 든 줄"의 합집합이다 — 열 때 받은 최신 페이지, 위로 올려
 * 받은 과거 페이지, 점프 창, 소켓으로 온 새 글, 그리고 **스레드를 열 때 함께 실려 온 뿌리**까지.
 * 그래서 "그 줄이 스토어에 있다"는 "그 줄의 이웃도 있다"가 아니다. 인박스에서 연 스레드의 뿌리는
 * 채널 목록에 홀로 서고, 그 줄로 점프하면 앞뒤가 없는 자리에 서서 목록 맨 위에 걸린다.
 *
 * 이 모듈은 **받아 온 페이지가 말한 구간**만 적는다. 닫힌 구간 `[lo, hi]` 이고, `hi` 가
 * `Infinity` 면 "가장 최신까지"다(처음 연 채널의 최신 페이지 — 그 뒤 소켓으로 오는 새 글은 늘
 * 그 안에 든다). 겹치거나 맞닿은 구간은 하나로 합친다.
 *
 * seq 는 채널 안에서 뿌리와 답글이 **같이** 쓰므로 번호가 이어지지 않는 것이 정상이다 — 구간의
 * 끝은 받은 줄의 seq 가 아니라 **물은 범위**로 적는 것이 맞다(`before: X` 페이지는 `X - 1` 까지를
 * 말한 것이다). 그래서 구간을 합칠 때도 `hi + 1 === lo` 를 맞닿은 것으로 본다.
 */
export interface SeqRange {
  lo: number;
  hi: number;
}

/** `ranges` 에 `add` 를 넣고 겹치거나 맞닿은 것을 합쳐 돌려준다. 입력은 바꾸지 않는다. */
export function addRange(ranges: readonly SeqRange[], add: SeqRange): SeqRange[] {
  if (!(add.lo <= add.hi)) return [...ranges];
  let merged: SeqRange = { lo: add.lo, hi: add.hi };
  const out: SeqRange[] = [];
  for (const r of ranges) {
    if (r.hi + 1 < merged.lo || merged.hi + 1 < r.lo) {
      out.push(r);
    } else {
      merged = { lo: Math.min(r.lo, merged.lo), hi: Math.max(r.hi, merged.hi) };
    }
  }
  out.push(merged);
  return out.sort((a, b) => a.lo - b.lo);
}

/** 그 seq 가 받아 온 어느 구간 안에 있는가. */
export function coversSeq(ranges: readonly SeqRange[], seq: number): boolean {
  return ranges.some((r) => r.lo <= seq && seq <= r.hi);
}
