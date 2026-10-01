import { describe, it, expect } from 'vitest';
import { createSecretLeases } from '../src/secretLeases.js';

// 비밀 보관소 PR 3 — 러너의 턴 임대(R1). 스레드 bc98df3a.
function harness(issueResult: { id: string; token: string; expiresAt: string } | null | 'throw') {
  const log: string[] = [];
  let issued = 0;
  const leases = createSecretLeases({
    issue: async (cause) => {
      issued++;
      log.push(`issue:${cause}`);
      if (issueResult === 'throw') throw new Error('link down');
      return issueResult;
    },
    notifyLease: (cause, lease) => log.push(`lease:${cause}:${lease.id}`),
    notifyEnded: (cause) => log.push(`ended:${cause}`),
  });
  return { leases, log, issued: () => issued };
}

describe('secretLeases', () => {
  const L = { id: 'l1', token: 't1', expiresAt: '2026-10-01T00:35:00Z' };

  it('멘션마다 한 번만 받는다 — 계정 전환·재시도는 받은 임대를 다시 쓴다(R1)', async () => {
    const h = harness(L);
    await h.leases.acquire('m1');
    await h.leases.acquire('m1');
    await h.leases.acquire('m1');
    expect(h.issued()).toBe(1);
    expect(h.log).toEqual(['issue:m1', 'lease:m1:l1']);
    h.leases.release('m1');
    expect(h.log.at(-1)).toBe('ended:m1');
  });

  it('받지 못했으면(409·실패) 맡기지도 놓지도 않는다 — 비밀 없이 돈다(fail-closed)', async () => {
    for (const r of [null, 'throw'] as const) {
      const h = harness(r);
      await h.leases.acquire('m1');
      await h.leases.acquire('m1');
      expect(h.issued()).toBe(1);
      h.leases.release('m1');
      expect(h.log).toEqual(['issue:m1']);
    }
  });

  it('놓은 뒤 같은 멘션을 다시 집으면 다시 묻는다(서버가 409 로 거절한다)', async () => {
    const h = harness(L);
    await h.leases.acquire('m1');
    h.leases.release('m1');
    await h.leases.acquire('m1');
    expect(h.issued()).toBe(2);
  });
});
