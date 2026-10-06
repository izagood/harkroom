// `pools.json` 의 `order` 를 데몬이 맞춘다(2026-10-02). 계정 추가 경로가 순서를 쓰지 않아, 새 계정이
// 화면이 다른 설정을 저장할 때까지 `order` 밖에 남았다(동점·사용량 모름일 때 맨 뒤로 갔다).
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsPort, type ClaudeLoginChild, type ClaudeLoginEvent } from '../src/claudeAccounts.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true };
  kill(): boolean { return true; }
}

async function setup(status: { loggedIn: boolean }, pools: unknown = { defaultPool: 'work', order: { work: ['lychee'] }, agents: {} }) {
  const root = mkdtempSync(join(tmpdir(), 'd-order-'));
  await mkdir(join(root, 'work', 'lychee'), { recursive: true });
  if (pools !== null) {
    await writeFile(join(root, 'pools.json'), typeof pools === 'string' ? pools : JSON.stringify(pools));
  }
  const children: FakeChild[] = [];
  const events: ClaudeLoginEvent[] = [];
  const port = createClaudeAccountsPort({
    root,
    runStatus: vi.fn(async () => status),
    spawnLogin: vi.fn(() => { const c = new FakeChild(); children.push(c); return c as unknown as ClaudeLoginChild; }),
    deleteKeychain: vi.fn(async () => undefined),
    killGraceMs: 0,
  });
  port.onLoginEvent((e) => events.push(e));
  const finish = async (code: number) => {
    children.at(-1)!.emit('exit', code, null);
    await vi.waitFor(() => expect(events.some((e) => e.done)).toBe(true));
  };
  const order = async () => JSON.parse(await readFile(join(root, 'pools.json'), 'utf8')).order;
  return { root, port, finish, order };
}

describe('계정 추가', () => {
  it('새로 만든 계정이 로그인에 성공하면 그 풀의 order 끝에 붙는다 — 다른 값은 그대로', async () => {
    const h = await setup({ loggedIn: true });
    await h.port.loginStart('work', 'acct-0a1b2c3d');
    await h.finish(0);
    expect(await h.order()).toEqual({ work: ['lychee', 'acct-0a1b2c3d'] });
    const cfg = JSON.parse(await readFile(join(h.root, 'pools.json'), 'utf8'));
    expect(cfg.defaultPool).toBe('work');
  });

  it('로그인이 끝나지 않으면 order 를 건드리지 않는다(디렉터리도 치운다)', async () => {
    const h = await setup({ loggedIn: false });
    await h.port.loginStart('work', 'acct-0a1b2c3d');
    await h.finish(1);
    expect(await h.order()).toEqual({ work: ['lychee'] });
  });

  it('다시 로그인은 자리를 그대로 둔다 — 끝으로 옮기지 않는다', async () => {
    const h = await setup({ loggedIn: true }, { defaultPool: 'work', order: { work: ['lychee', 'plum'] }, agents: {} });
    await mkdir(join(h.root, 'work', 'plum'), { recursive: true });
    await h.port.loginStart('work', 'lychee', { reauth: true });
    await h.finish(0);
    expect(await h.order()).toEqual({ work: ['lychee', 'plum'] });
  });
});

describe('move', () => {
  it('옮긴 풀의 order 끝에 붙이고, 다른 풀 order 에 같은 이름이 남아 있으면 뺀다', async () => {
    const h = await setup({ loggedIn: true }, { defaultPool: 'work', order: { work: ['lychee'], old: ['stray'] }, agents: {} });
    await mkdir(join(h.root, 'stray'), { recursive: true });
    await writeFile(join(h.root, 'stray', '.claude.json'), '{}'); // 계정 모양(잔여물)
    await h.port.move('stray', 'work');
    expect(await h.order()).toEqual({ work: ['lychee', 'stray'], old: [] });
  });
});

describe('reconcileOrder (데몬 기동 때)', () => {
  it('디스크에 있는데 order 에 없으면 끝에 붙이고, 없는 이름은 뺀다', async () => {
    const h = await setup({ loggedIn: true }, { defaultPool: 'work', order: { work: ['ghost', 'lychee'] }, agents: {} });
    await mkdir(join(h.root, 'work', 'acct-ddb9b523'), { recursive: true });
    expect(await h.port.reconcileOrder()).toEqual({ added: ['work/acct-ddb9b523'], removed: ['work/ghost'] });
    expect(await h.order()).toEqual({ work: ['lychee', 'acct-ddb9b523'] });
  });

  it('맞으면 파일을 다시 쓰지 않는다', async () => {
    const h = await setup({ loggedIn: true });
    const before = (await stat(join(h.root, 'pools.json'))).mtimeMs;
    expect(await h.port.reconcileOrder()).toEqual({ added: [], removed: [] });
    expect((await stat(join(h.root, 'pools.json'))).mtimeMs).toBe(before);
  });

  it('깨진 pools.json 은 덮지 않는다 — 사람이 손댄 다른 값이 사라진다', async () => {
    const h = await setup({ loggedIn: true }, '{ broken');
    await mkdir(join(h.root, 'work', 'acct-ddb9b523'), { recursive: true });
    await h.port.reconcileOrder();
    await h.port.loginStart('work', 'acct-0a1b2c3d');
    await h.finish(0);
    expect(await readFile(join(h.root, 'pools.json'), 'utf8')).toBe('{ broken');
  });

  it('평평한 구조(pools.json 없음)에서는 아무 파일도 만들지 않는다', async () => {
    const h = await setup({ loggedIn: true }, null);
    await h.port.reconcileOrder();
    await expect(stat(join(h.root, 'pools.json'))).rejects.toThrow();
  });
});
