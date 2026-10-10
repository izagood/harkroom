// 터미널 입력 → 에코 지연을 잰다(2026-10-10, 스레드 8d233406 의 PR-0).
//
// **왜 이 숫자가 필요한가**: "터미널이 느리다"를 지금까지는 느낌으로만 말했다. 조사해 보니
// 키 하나가 앱 → 서버 → 러너 → 서버 → 앱으로 두 번 왕복했고(추정 0.7~0.8초), 고치는 길은
// 경로를 바꾸는 것(로컬 직결·서울 중계)이다. 고친 뒤 **얼마나 줄었는지를 실물 앱에서** 재려면
// 그 자리에서 숫자를 내는 계기가 있어야 한다 — 이 모듈이 그 계기다.
//
// **무엇을 재는가**: 사람이 친 바이트를 보낸 순간부터 **그다음 출력 바이트가 도착한 순간**까지.
// 에코인지 아닌지는 바이트로 가르지 않는다(TUI 는 글자 하나에 화면을 통째로 다시 그린다) —
// "친 뒤 화면이 처음 반응한 때"가 사람이 느끼는 지연과 같다.
//
// - 반응을 기다리는 동안 더 친 키는 **시작 시각을 바꾸지 않는다** — 가장 오래 기다린 키가
//   사람이 느끼는 지연이다.
// - `MAX_SAMPLE_MS` 를 넘는 값은 버린다. 관찰 전용 창이나 출력 없는 키(예: 아무 반응 없는
//   조합 키)는 다음 출력이 몇 초 뒤의 무관한 화면일 수 있다 — 그걸 지연으로 세면 p95 가 거짓이 된다.
// - 최근 `WINDOW` 개만 들고 있는다. 경로가 바뀐(서버 경유 → 로컬 직결) 뒤의 숫자가 옛 숫자에
//   묻히지 않게 한다.

/** 이보다 긴 간격은 지연이 아니라 "출력 없는 입력 뒤의 무관한 출력"으로 본다. */
export const MAX_SAMPLE_MS = 5_000;
/** 통계에 쓰는 최근 표본 수. */
export const WINDOW = 50;

export interface EchoLatencyStats {
  p50: number;
  p95: number;
  count: number;
}

export interface EchoLatencyTracker {
  /** 사람이 친 바이트를 내보냈다. */
  noteInput(now: number): void;
  /** 출력 바이트가 도착했다. 표본이 하나 생겼으면 `true`. */
  noteOutput(now: number): boolean;
  /** 표본이 없으면 `null`. */
  stats(): EchoLatencyStats | null;
}

/** 정렬된 배열의 백분위(가장 가까운 순위). 표본이 적어도 실제로 관찰한 값만 돌려준다. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function createEchoLatencyTracker(): EchoLatencyTracker {
  let pendingSince: number | null = null;
  const samples: number[] = [];
  return {
    noteInput(now) {
      if (pendingSince === null) pendingSince = now;
    },
    noteOutput(now) {
      if (pendingSince === null) return false;
      const sample = now - pendingSince;
      pendingSince = null;
      if (sample < 0 || sample > MAX_SAMPLE_MS) return false;
      samples.push(sample);
      if (samples.length > WINDOW) samples.shift();
      return true;
    },
    stats() {
      if (samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), count: samples.length };
    },
  };
}
