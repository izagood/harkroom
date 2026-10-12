// 빈 폴 뒤의 종료 요청(#129)을 어디서 읽나(2026-10-12 inbox 호출 설계 A).
// 새 서버는 빈 폴 응답에 `stopRequestedAt` 을 늘 싣는다 → 정의를 따로 읽지 않는다. 키가 없으면(옛 서버) 전처럼 읽는다.
import { describe, it, expect, vi } from 'vitest';
import { idleStopRequestedAt } from '../src/idleStop.js';

describe('idleStopRequestedAt', () => {
  it('키가 있고 null 이면 정의를 읽지 않고 null', async () => {
    const read = vi.fn(async () => ({ stopRequestedAt: '2099-01-01T00:00:00Z' }));
    expect(await idleStopRequestedAt({ stopRequestedAt: null }, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('키에 시각이 있으면 그 시각, 정의를 읽지 않는다', async () => {
    const read = vi.fn(async () => ({ stopRequestedAt: null }));
    expect(await idleStopRequestedAt({ stopRequestedAt: '2026-10-12T10:00:00.000Z' }, read)).toBe('2026-10-12T10:00:00.000Z');
    expect(read).not.toHaveBeenCalled();
  });

  it('키가 없으면(옛 서버) 정의를 읽어 그 값을 쓴다', async () => {
    const read = vi.fn(async () => ({ stopRequestedAt: '2026-10-12T10:00:00.000Z' }));
    expect(await idleStopRequestedAt({}, read)).toBe('2026-10-12T10:00:00.000Z');
    expect(read).toHaveBeenCalledTimes(1);
  });
});
