import { describe, it, expect } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';

describe('Lifecycle', () => {
  it('wakes in-flight long-polls when drain begins', async () => {
    const lifecycle = new Lifecycle();
    let woken = false;
    lifecycle.onDrain(() => { woken = true; });
    expect(woken).toBe(false);
    await lifecycle.beginDrain();
    expect(woken).toBe(true);
  });

  // drain이 시작된 뒤 도착한 poll은 park하면 안 된다 — 종료 중인 서버가 25초를 붙잡고 있으면
  // 그게 곧 절단이다. 등록 시점에 이미 draining이면 waker를 즉시 실행해 park를 건너뛰게 한다.
  it('runs a waker registered after drain has begun immediately', async () => {
    const lifecycle = new Lifecycle();
    await lifecycle.beginDrain();
    let woken = false;
    lifecycle.onDrain(() => { woken = true; });
    expect(woken).toBe(true);
    expect(lifecycle.isDraining()).toBe(true);
  });

  it('beginDrain waits until in-flight polls release', async () => {
    const lifecycle = new Lifecycle();
    const release = lifecycle.enterPoll();
    let resolved = false;
    const drained = lifecycle.beginDrain(5_000).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    release();
    await drained;
    expect(resolved).toBe(true);
  });

  it('beginDrain gives up after the grace window when a poll never releases', async () => {
    const lifecycle = new Lifecycle();
    lifecycle.enterPoll();
    const started = Date.now();
    await lifecycle.beginDrain(80);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
