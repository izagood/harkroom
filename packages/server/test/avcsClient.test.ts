import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeAvcs } from './helpers/fakeAvcsServer.js';
import { httpAvcsClient } from '../src/avcs/client.js';

let fake: Awaited<ReturnType<typeof startFakeAvcs>>;
beforeAll(async () => { fake = await startFakeAvcs(); });
afterAll(async () => fake.close());

describe('avcs client', () => {
  it('fetchSince returns pushed entries with increasing logIndex', async () => {
    fake.push('r1', { oid: 'oid-a', type: 'intent', actorKeyId: 'k1', intentOid: 'oid-a', summary: 'add feature' });
    fake.push('r1', { oid: 'oid-b', type: 'operation', actorKeyId: 'k1', intentOid: 'oid-a', summary: 'put_file src/x' });
    const client = httpAvcsClient(fake.url);
    const { entries, next } = await client.fetchSince('r1', 0);
    expect(entries.map((e) => e.oid)).toEqual(['oid-a', 'oid-b']);
    expect(next).toBe(2);
    const empty = await client.fetchSince('r1', next);
    expect(empty.entries).toEqual([]);
  });

  it('waitForChange returns true when data exists past cursor, false on timeout', async () => {
    const client = httpAvcsClient(fake.url);
    expect(await client.waitForChange('r1', 0, 1000)).toBe(true);
    expect(await client.waitForChange('r1', 99, 300)).toBe(false);
  });

  it('waitForChange wakes when push arrives during long-poll', async () => {
    const client = httpAvcsClient(fake.url);
    const promise = client.waitForChange('r2', 0, 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fake.push('r2', { oid: 'oid-c', type: 'intent', actorKeyId: 'k1', intentOid: 'oid-c', summary: 'test' });
    expect(await promise).toBe(true);
  });
});
