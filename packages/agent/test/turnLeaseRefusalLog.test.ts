import { describe, it, expect } from 'vitest';
import { HarkroomAgentClient } from '../src/harkroom.js';

// S0: 러너가 턴 임대 발급 거절 사유를 한 줄 남긴다(원인 글 id·상태·서버 코드만).
describe('issueTurnLease refusal log', () => {
  const client = (status: number, body: string) =>
    new HarkroomAgentClient({ request: async () => ({ type: 'http.response', id: 'x', status, body }) } as never);
  const CAUSE = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it.each([
    [409, JSON.stringify({ error: { code: 'lease_used', message: 'this mention has already had a lease' } }), 'status=409 code=lease_used', 'lease_used'],
    [403, JSON.stringify({ error: { code: 'not_invoked', message: 'x' } }), 'status=403 code=not_invoked', null],
    [502, '', 'status=502 code=unknown', 'unreachable'],
    [0, '', 'status=0 code=unknown', 'unreachable'],
    [403, JSON.stringify({ error: { code: 'Weird Code; rm -rf' } }), 'status=403 code=unknown', null],
  ])('%s → logs the code; only 409 lease_used is told apart', async (status, body, tail, expected) => {
    const lines: string[] = [];
    expect(await client(status, body).issueTurnLease(CAUSE, (l) => lines.push(l))).toBe(expected);
    expect(lines).toEqual([`[secretLeases] 임대 발급 거절 cause=${CAUSE} ${tail}`]);
  });

  it('sends the thread claim holder with the request', async () => {
    const bodies: string[] = [];
    const c = new HarkroomAgentClient({ request: async (r: { body: string }) => { bodies.push(r.body); return { type: 'http.response', id: 'x', status: 403, body: '' }; } } as never);
    await c.issueTurnLease(CAUSE, () => {}, 'holder-1');
    await c.issueTurnLease(CAUSE, () => {});
    expect(JSON.parse(bodies[0]!)).toEqual({ causeMessageId: CAUSE, claimHolder: 'holder-1' });
    expect(JSON.parse(bodies[1]!)).toEqual({ causeMessageId: CAUSE });
  });

  it('a granted lease logs nothing and never echoes the token', async () => {
    const lines: string[] = [];
    const lease = { id: 'l1', token: 'secret-token-value', expiresAt: '2026-11-02T03:00:00.000Z' };
    expect(await client(200, JSON.stringify({ lease })).issueTurnLease(CAUSE, (l) => lines.push(l))).toEqual(lease);
    expect(lines).toEqual([]);
  });
});
