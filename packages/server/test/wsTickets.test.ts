import { describe, it, expect } from 'vitest';
import { createTicketStore } from '../src/ws/tickets.js';

const holder = (accountId: string, tokenHash = `hash-of-${accountId}`) => ({ accountId, tokenHash });

describe('ws ticket store', () => {
  // 티켓은 계정만이 아니라 **발급에 쓰인 토큰의 해시**까지 들고 있어야 한다. 소켓이 나중에
  // 자기 자격증명을 재검증할 근거가 그것뿐이다 — 계정 단위로 보면 다른 세션이 살아 있을 때
  // 폐기된 토큰의 소켓을 구분해 끊을 수 없다.
  it('resolves a freshly issued ticket to the account and the issuing credential', () => {
    const store = createTicketStore();
    const ticket = store.issue(holder('acct-1', 'hash-1'));

    expect(store.consume(ticket)).toEqual({ accountId: 'acct-1', tokenHash: 'hash-1' });
  });

  // 티켓은 URL에 실린다. 재사용이 가능하면 로그에 남은 값이 그대로 다시 쓰이므로,
  // '짧게 산다'는 성질만으로는 부족하고 한 번 쓰면 죽어야 한다.
  it('refuses a ticket that was already used', () => {
    const store = createTicketStore();
    const ticket = store.issue(holder('acct-1'));
    store.consume(ticket);

    expect(store.consume(ticket)).toBeNull();
  });

  it('refuses a ticket past its lifetime', async () => {
    const store = createTicketStore({ ttlMs: 20 });
    const ticket = store.issue(holder('acct-1'));
    await new Promise((r) => setTimeout(r, 40));

    expect(store.consume(ticket)).toBeNull();
  });

  it('refuses a value that was never issued', () => {
    const store = createTicketStore();

    expect(store.consume('murt_fabricated')).toBeNull();
  });

  it('issues distinct tickets for the same account', () => {
    const store = createTicketStore();

    expect(store.issue(holder('acct-1'))).not.toBe(store.issue(holder('acct-1')));
  });

  // 받아만 두고 연결하지 않은 티켓이 쌓이면 메모리가 샌다.
  it('drops expired tickets instead of holding them forever', async () => {
    const store = createTicketStore({ ttlMs: 20 });
    for (let i = 0; i < 5; i += 1) store.issue(holder('acct-1'));
    await new Promise((r) => setTimeout(r, 40));
    store.issue(holder('acct-2'));

    expect(store.size()).toBe(1);
  });
});
