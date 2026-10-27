/**
 * 격리 C안 P3 — 기계에 하나로 남는 `usage.json` 에 writer 가 여럿일 때(커뮤니티마다 오퍼레이터 프로세스).
 * 잠금(`fileLock.ts`)·합치기(`mergeUsageEntries`)·폴러의 `sharedFile` 스위치, 그리고 **꺼져 있으면 지금 그대로**.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClaudeUsageEntry } from '@harkroom/shared/claudeUsage';

import { createClaudeUsagePoller, mergeUsageEntries } from '../src/claudeUsagePoller.js';
import { withFileLock } from '../src/fileLock.js';

const T0 = Date.parse('2026-10-27T07:00:00Z');
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'usage-shared-'));
  dirs.push(d);
  return d;
}

const entry = (pool: string, account: string, readAtMs: number | null, pct = 10): ClaudeUsageEntry => ({
  pool, account, signIn: null,
  session: { usedPercent: pct, resetsAtMs: null }, weekly: null, modelWeekly: [], readAtMs,
});

describe('withFileLock', () => {
  it('동시에 부른 둘이 겹치지 않는다', async () => {
    const lock = join(await tmp(), 'x.lock');
    const log: string[] = [];
    const job = (name: string) => withFileLock(lock, async () => {
      log.push(`${name}:in`);
      await new Promise((r) => setTimeout(r, 30));
      log.push(`${name}:out`);
    }, { retryMs: 5 });
    await Promise.all([job('a'), job('b')]);
    expect([['a:in', 'a:out', 'b:in', 'b:out'], ['b:in', 'b:out', 'a:in', 'a:out']]).toContainEqual(log);
  });

  it('주인이 죽은 잠금은 치우고 잡는다', async () => {
    const lock = join(await tmp(), 'x.lock');
    await writeFile(lock, `424242 ${Date.now()}\n`);
    expect(await withFileLock(lock, async () => 'ok', { isAlive: () => false })).toBe('ok');
  });

  it('살아 있는 주인의 잠금은 기다리다 시한이 되면 던진다(그 쓰기는 건너뛴다)', async () => {
    const lock = join(await tmp(), 'x.lock');
    await writeFile(lock, `${process.pid} ${Date.now()}\n`);
    await expect(withFileLock(lock, async () => 'never', { timeoutMs: 60, retryMs: 10 })).rejects.toThrow(/잠금/);
  });

  it('fn 이 던져도 잠금을 놓는다', async () => {
    const lock = join(await tmp(), 'x.lock');
    await expect(withFileLock(lock, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('mergeUsageEntries', () => {
  it('같은 계정은 더 최근에 잰 값, 모르는 계정은 남기고, 사라진 것을 본 계정만 뺀다', () => {
    const onDisk = [entry('work', 'aria', T0 + 5, 70), entry('home', 'zed', T0), entry('work', 'gone', T0)];
    const mine = [entry('work', 'aria', T0, 40), entry('work', 'bex', T0)];
    const out = mergeUsageEntries(onDisk, mine, new Set(['work\u0000gone']));
    const by = Object.fromEntries(out.map((e) => [`${e.pool}/${e.account}`, e]));
    expect(Object.keys(by).sort()).toEqual(['home/zed', 'work/aria', 'work/bex']);
    expect(by['work/aria']?.session?.usedPercent).toBe(70);
  });
});

describe('claudeUsagePoller sharedFile', () => {
  async function pollsRoot(): Promise<string> {
    const root = await tmp();
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work', order: {}, agents: {} }));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    return root;
  }
  const make = (root: string, sharedFile?: boolean) => createClaudeUsagePoller({
    root, now: () => T0, readSignIn: async () => null,
    measure: async () => ({ fetchedAtMs: T0, session: { usedPercent: 40, resetsAtMs: null }, weekly: null }),
    ...(sharedFile === undefined ? {} : { sharedFile }),
  });
  const foreign = { version: 1, writtenAtMs: T0, accounts: [entry('other', 'zed', T0)] };
  const accountsOnDisk = async (root: string) =>
    (JSON.parse(await readFile(join(root, 'usage.json'), 'utf8')) as { accounts: ClaudeUsageEntry[] }).accounts.map((a) => `${a.pool}/${a.account}`).sort();

  it('꺼져 있으면(기본) 지금처럼 메모리의 값으로 파일 전체를 바꾼다 — 남의 칸은 사라지고 잠금 파일도 없다', async () => {
    const root = await pollsRoot();
    await writeFile(join(root, 'usage.json'), JSON.stringify(foreign));
    await make(root).tick();
    expect(await accountsOnDisk(root)).toEqual(['work/aria']);
    await expect(stat(join(root, 'usage.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('켜져 있으면 다른 프로세스가 쓴 칸을 지우지 않고 합친다', async () => {
    const root = await pollsRoot();
    await writeFile(join(root, 'usage.json'), JSON.stringify(foreign));
    await make(root, true).tick();
    expect(await accountsOnDisk(root)).toEqual(['other/zed', 'work/aria']);
    await expect(stat(join(root, 'usage.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
