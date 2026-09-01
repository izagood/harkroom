import { describe, it, expect } from 'vitest';
import { createTicketStore } from '../src/ws/tickets.js';

describe('ws ticket store', () => {
  // 소켓 수명을 자격증명에 묶으려면, 티켓이 계정만이 아니라 '어떤 자격증명으로 받았는지'까지
  // 운반해야 한다.
  it('resolves a freshly issued ticket to its account and credential', () => {
    const store = createTicketStore();
    const ticket = store.issue('acct-1', 'hash-1');

    expect(store.consume(ticket)).toEqual({ accountId: 'acct-1', credentialHash: 'hash-1' });
  });

  // 티켓은 URL에 실린다. 재사용이 가능하면 로그에 남은 값이 그대로 다시 쓰이므로,
  // '짧게 산다'는 성질만으로는 부족하고 한 번 쓰면 죽어야 한다.
  it('refuses a ticket that was already used', () => {
    const store = createTicketStore();
    const ticket = store.issue('acct-1', 'hash-1');
    store.consume(ticket);

    expect(store.consume(ticket)).toBeNull();
  });

  it('refuses a ticket past its lifetime', async () => {
    const store = createTicketStore({ ttlMs: 20 });
    const ticket = store.issue('acct-1', 'hash-1');
    await new Promise((r) => setTimeout(r, 40));

    expect(store.consume(ticket)).toBeNull();
  });

  it('refuses a value that was never issued', () => {
    const store = createTicketStore();

    expect(store.consume('murt_fabricated')).toBeNull();
  });

  it('issues distinct tickets for the same account', () => {
    const store = createTicketStore();

    expect(store.issue('acct-1', 'hash-1')).not.toBe(store.issue('acct-1', 'hash-1'));
  });

  // 받아만 두고 연결하지 않은 티켓이 쌓이면 메모리가 샌다.
  it('drops expired tickets instead of holding them forever', async () => {
    const store = createTicketStore({ ttlMs: 20 });
    for (let i = 0; i < 5; i += 1) store.issue('acct-1', 'hash-1');
    await new Promise((r) => setTimeout(r, 40));
    store.issue('acct-2', 'hash-2');

    expect(store.size()).toBe(1);
  });
});
