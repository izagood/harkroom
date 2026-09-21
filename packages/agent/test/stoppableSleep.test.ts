// 종료 신호가 폴 루프의 backoff 기다림을 깨운다(실측 2026-09-21 — 오퍼레이터가 없을 때 러너가
// SIGTERM 에 안 내려갔다). 깨우는 것은 기다림이지 턴이 아니다.
import { describe, it, expect } from 'vitest';
import { createStoppableSleep } from '../src/stoppableSleep.js';

describe('createStoppableSleep', () => {
  it('wake 가 오면 남은 시간을 기다리지 않고 끝난다', async () => {
    const s = createStoppableSleep();
    const t0 = Date.now();
    const p = s.sleep(60_000);
    setTimeout(() => s.wake(), 20);
    await p;
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it('기다리는 것이 없으면 wake 는 아무 일도 안 한다; 다음 sleep 은 정상으로 잔다', async () => {
    const s = createStoppableSleep();
    s.wake();
    const t0 = Date.now();
    await s.sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
