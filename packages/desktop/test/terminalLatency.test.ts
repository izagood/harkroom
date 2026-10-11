// 입력 → 첫 출력 지연 계기(PR-0, 스레드 8d233406). 경로를 바꾼 전후를 실물 앱에서 비교하는
// 숫자라서, 숫자가 거짓이 되는 자리(기다리는 동안 더 친 키·무관한 늦은 출력·창 크기)를 고정한다.
import { describe, expect, it } from 'vitest';
import { createEchoLatencyTracker, MAX_SAMPLE_MS, WINDOW } from '../src/lib/terminalLatency';

describe('createEchoLatencyTracker', () => {
  it('친 순간부터 다음 출력까지를 표본 하나로 센다', () => {
    const t = createEchoLatencyTracker();
    expect(t.stats()).toBeNull();
    t.noteInput(1000);
    expect(t.noteOutput(1700)).toBe(true);
    expect(t.stats()).toEqual({ p50: 700, p95: 700, count: 1 });
  });

  it('입력 없이 온 출력은 표본이 아니다 — 에이전트가 혼자 그리는 화면이다', () => {
    const t = createEchoLatencyTracker();
    expect(t.noteOutput(500)).toBe(false);
    expect(t.stats()).toBeNull();
  });

  it('반응을 기다리는 동안 더 친 키는 시작 시각을 늦추지 않는다 — 가장 오래 기다린 키가 체감이다', () => {
    const t = createEchoLatencyTracker();
    t.noteInput(0);
    t.noteInput(300);
    t.noteOutput(800);
    expect(t.stats()?.p50).toBe(800);
  });

  it('표본 하나에 출력 하나 — 같은 반응의 뒷조각은 다시 세지 않는다', () => {
    const t = createEchoLatencyTracker();
    t.noteInput(0);
    expect(t.noteOutput(100)).toBe(true);
    expect(t.noteOutput(120)).toBe(false);
    expect(t.stats()?.count).toBe(1);
  });

  it(`${MAX_SAMPLE_MS}ms 를 넘으면 버린다 — 반응 없는 키 뒤의 무관한 출력이다`, () => {
    const t = createEchoLatencyTracker();
    t.noteInput(0);
    expect(t.noteOutput(MAX_SAMPLE_MS + 1)).toBe(false);
    expect(t.stats()).toBeNull();
  });

  it('p50·p95 는 관찰한 값 가운데서 고른다', () => {
    const t = createEchoLatencyTracker();
    for (let i = 1; i <= 20; i += 1) { t.noteInput(0); t.noteOutput(i * 10); }
    expect(t.stats()).toEqual({ p50: 100, p95: 190, count: 20 });
  });

  it(`최근 ${WINDOW}개만 본다 — 경로를 바꾼 뒤의 숫자가 옛 숫자에 묻히지 않는다`, () => {
    const t = createEchoLatencyTracker();
    for (let i = 0; i < WINDOW; i += 1) { t.noteInput(0); t.noteOutput(700); }
    for (let i = 0; i < WINDOW; i += 1) { t.noteInput(0); t.noteOutput(5); }
    expect(t.stats()).toEqual({ p50: 5, p95: 5, count: WINDOW });
  });
});
