import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryCache, HINT_TTL_MS, MEMORY_CACHE_FILE, type MemorySource } from '../src/memoryCache.js';

/** 서버 흉내. 호출 수를 세고, `down` 이면 던진다. */
function fakeSource(init: { core: string | null; slugs: string[]; rev?: string }) {
  const state = { ...init, down: false, lists: 0, gets: 0 };
  const source: MemorySource = {
    async listMemory() {
      state.lists++;
      if (state.down) throw new Error('server down');
      const slugs = state.core === null ? state.slugs : ['core', ...state.slugs];
      return state.rev === undefined ? { slugs } : { slugs, rev: state.rev };
    },
    async getMemoryValue() {
      state.gets++;
      if (state.down) throw new Error('server down');
      return state.core;
    },
  };
  return { state, source };
}

let stateDir: string;
let file: string;
let clock: number;
const now = () => new Date(clock);
const silent = () => {};

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'memcache-'));
  file = join(stateDir, MEMORY_CACHE_FILE);
  clock = Date.parse('2026-09-28T00:00:00Z');
});

describe('memoryCache', () => {
  it('first read fetches and persists a 0600 snapshot', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: ['mem/a'], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    expect(await cache.read()).toEqual({ core: 'C', slugs: ['mem/a'] });
    expect([state.lists, state.gets]).toEqual([1, 1]);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved).toMatchObject({ rev: 'r1', core: 'C', slugs: ['mem/a'] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  // 핵심: 배치 판본이 사본과 같으면 왕복 0회.
  it('matching batch rev serves the snapshot with zero round trips', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    cache.noteRev('r1');
    expect(await cache.read()).toEqual({ core: 'C', slugs: [] });
    expect([state.lists, state.gets]).toEqual([1, 1]);
  });

  // 힌트는 한 번만 쓴다 — 같은 배치의 다음 턴은 앞 턴이 memory.set 했을 수 있다.
  it('batch hint is one-shot: the next read revalidates with memory.list', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    cache.noteRev('r1');
    await cache.read();
    state.core = 'C2'; state.rev = 'r2';
    expect(await cache.read()).toEqual({ core: 'C2', slugs: [] });
    expect([state.lists, state.gets]).toEqual([2, 2]);
  });

  it('stale batch hint (queued turn) is ignored', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    cache.noteRev('r1');
    clock += HINT_TTL_MS + 1;
    state.core = 'C2'; state.rev = 'r2';
    expect((await cache.read()).core).toBe('C2');
  });

  it('same rev from memory.list skips re-fetching core', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    await cache.read();
    expect([state.lists, state.gets]).toEqual([2, 1]);
  });

  it('changed rev fetches the new core (edits still land next turn)', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    cache.noteRev('r2');
    state.core = 'C2'; state.rev = 'r2'; state.slugs = ['mem/new'];
    expect(await cache.read()).toEqual({ core: 'C2', slugs: ['mem/new'] });
  });

  // 치명적이던 쪽: 서버를 못 읽어도 기억 없이 돌지 않는다.
  it('server failure falls back to the snapshot, marked stale', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: ['mem/a'], rev: 'r1' });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    state.down = true;
    expect(await cache.read()).toEqual({
      core: 'C', slugs: ['mem/a'], stale: { fetchedAt: '2026-09-28T00:00:00.000Z' },
    });
  });

  // 러너가 다시 떠도 첫 턴부터 폴백이 있다.
  it('a fresh runner falls back to the snapshot left on disk', async () => {
    const first = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    await createMemoryCache({ stateDir, source: first.source, now, log: silent }).read();
    const second = fakeSource({ core: 'X', slugs: [], rev: 'r9' });
    second.state.down = true;
    const restarted = createMemoryCache({ stateDir, source: second.source, now, log: silent });
    expect((await restarted.read()).core).toBe('C');
  });

  // #139 의 규칙은 그대로다: 사본도 없으면 "비었다"로 삼키지 않고 던진다.
  it('failure with no snapshot throws (never reads as an empty store)', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    state.down = true;
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await expect(cache.read()).rejects.toThrow('server down');
  });

  it('a corrupt snapshot file counts as no snapshot', async () => {
    await writeFile(file, '{not json');
    const { state, source } = fakeSource({ core: 'C', slugs: [], rev: 'r1' });
    state.down = true;
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await expect(cache.read()).rejects.toThrow();
  });

  it('목록의 요약(entries)을 사본에 담아 폴백에서도 돌려준다', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: ['mem/a'], rev: 'r1' });
    const list = source.listMemory.bind(source);
    source.listMemory = async () => ({ ...(await list()), entries: [{ slug: 'core', description: null }, { slug: 'mem/a', description: '요약', kind: 'journal' }] });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    const read = await cache.read();
    expect(read.descriptions).toEqual({ 'mem/a': '요약' });
    expect(read.kinds).toEqual({ 'mem/a': 'journal' });
    state.down = true;
    expect((await cache.read()).descriptions).toEqual({ 'mem/a': '요약' });
  });

  // 옛 서버(rev 없음): 매번 받아 오지만 폴백 사본은 남는다.
  it('without server rev it always fetches but still keeps a fallback', async () => {
    const { state, source } = fakeSource({ core: 'C', slugs: [] });
    const cache = createMemoryCache({ stateDir, source, now, log: silent });
    await cache.read();
    cache.noteRev(undefined);
    await cache.read();
    expect(state.gets).toBe(2);
    state.down = true;
    expect((await cache.read()).stale).toBeDefined();
  });
});
