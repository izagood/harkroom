/**
 * 계정 풀의 파일시스템 연산.
 *
 * **`claude auth status` 를 주입한다.** 실제 `claude` 를 부르면 이 테스트가 그 머신의 로그인
 * 상태에 달리고, CI 에는 로그인이 없다 — 그러면 "미로그인" 경로만 초록이 된다. 우리가 재는
 * 것은 **디렉터리 구조를 어떻게 읽고 쓰는가**이고 그것은 상태와 무관하다.
 *
 * 진짜 프로세스로 재야 하는 것(로그인 수명)은 `claudeLogin.test.ts` 로 나눠 둔다 —
 * `runners.test.ts` 가 실물과 가짜를 나눈 것과 같은 이유다.
 */
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsPort } from '../src/claudeAccounts.js';

const LOGGED_IN = { loggedIn: true, email: 'a@b.c', orgName: 'Org', subscriptionType: 'team' };
const LOGGED_OUT = { loggedIn: false };

function port(root: string, status: unknown = LOGGED_IN) {
  return createClaudeAccountsPort({ root, runStatus: vi.fn(async () => status) });
}

async function tmp(prefix = 'd-acc-'): Promise<string> {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('list', () => {
  it('pools.json 이 없으면 flat 모드로 뿌리의 계정을 준다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'lime'), { recursive: true });
    const snap = await port(root).list();
    expect(snap.mode).toBe('flat');
    expect(snap.pools).toHaveLength(1);
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['lime']);
  });

  it('pools.json 이 있으면 pools 모드로 풀별 계정을 준다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'work', 'lime'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const snap = await port(root).list();
    expect(snap.mode).toBe('pools');
    expect(snap.defaultPool).toBe('work');
    expect(snap.pools.map((p) => p.name)).toEqual(['work']);
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['lime']);
  });

  it('로그인 상태를 계정마다 실어 준다 — 비밀값은 없다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'lime'), { recursive: true });
    const snap = await port(root, LOGGED_IN).list();
    expect(snap.pools[0]!.accounts[0]!.status).toMatchObject({ loggedIn: true, email: 'a@b.c' });
  });

  it('미로그인 계정도 목록에 남는다 — 사람이 로그인해야 하는 대상이다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'lime'), { recursive: true });
    const snap = await port(root, LOGGED_OUT).list();
    expect(snap.pools[0]!.accounts[0]!.status.loggedIn).toBe(false);
  });

  it('풀 모드에서 뿌리에 남은 평평한 계정을 strays 로 보고한다', async () => {
    // 사용자가 풀을 만든 순간 평평한 계정은 계정 목록에서 사라진다. 조용히 사라지면
    // "계정이 없어졌다"가 되므로 따로 보고해 UI 가 이전을 안내할 수 있게 한다.
    const root = await tmp();
    await mkdir(join(root, 'work', 'lime'), { recursive: true });
    await mkdir(join(root, 'leftover'), { recursive: true });
    await writeFile(join(root, 'leftover', '.credentials.json'), '{}');
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const snap = await port(root).list();
    expect(snap.strays).toEqual(['leftover']);
    expect(snap.pools.map((p) => p.name)).toEqual(['work']);
  });

  it('flat 모드에서는 strays 가 비어 있다 — 그때는 그것들이 계정이다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'lime'), { recursive: true });
    await writeFile(join(root, 'lime', '.credentials.json'), '{}');
    expect((await port(root).list()).strays).toEqual([]);
  });

  it('빈 풀도 목록에 나온다 — 사용자가 방금 만들었을 수 있다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const snap = await port(root).list();
    expect(snap.pools.map((p) => p.name)).toEqual(['work']);
    expect(snap.pools[0]!.accounts).toEqual([]);
  });

  it('뿌리가 없으면 빈 스냅샷이다 — 오류가 아니다', async () => {
    const snap = await port('/nonexistent/murmur/pool').list();
    expect(snap.pools).toEqual([]);
    expect(snap.mode).toBe('flat');
  });

  it('에이전트 배정을 그대로 실어 준다 — UI 가 어느 에이전트가 어느 풀인지 그린다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({
      defaultPool: 'work', agents: { a1: 'work' },
    }));
    expect((await port(root).list()).agents).toEqual({ a1: 'work' });
  });
});

describe('configure', () => {
  it('pools.json 을 쓰고 없는 풀 디렉터리를 만든다 — 이것이 풀 생성 경로다', async () => {
    // 별도 createPool 을 두지 않는다. 설정에 이름이 나타나면 그 풀이 생긴다.
    const root = await tmp();
    await port(root).configure({ defaultPool: 'work', order: { work: [] }, agents: {} });
    expect(JSON.parse(await readFile(join(root, 'pools.json'), 'utf8')).defaultPool).toBe('work');
    expect((await port(root).list()).pools.map((p) => p.name)).toEqual(['work']);
  });

  it('배정에만 나오는 풀도 만든다', async () => {
    const root = await tmp();
    await port(root).configure({ defaultPool: null, order: {}, agents: { a1: 'personal' } });
    expect((await port(root).list()).pools.map((p) => p.name)).toEqual(['personal']);
  });

  it('이름 문법을 다시 잰다 — 웹뷰를 신뢰하지 않는다', async () => {
    // 이 이름이 경로 세그먼트가 되고, 데몬은 웹뷰를 신뢰하는 자리가 아니다.
    const root = await tmp();
    await expect(port(root).configure({ defaultPool: '../escape', order: {}, agents: {} }))
      .rejects.toThrow();
    await expect(port(root).configure({ defaultPool: null, order: { '../x': [] }, agents: {} }))
      .rejects.toThrow();
    await expect(port(root).configure({ defaultPool: null, order: {}, agents: { a1: '../x' } }))
      .rejects.toThrow();
  });

  it('겹쳐 쓰기가 온전하다 — 반쪽 JSON 이 남지 않는다', async () => {
    // 쓰다 죽으면 반쪽 JSON 이 남고, 그것을 읽은 러너는 빈 설정으로 떨어진다.
    const root = await tmp();
    const p = port(root);
    await Promise.all([
      p.configure({ defaultPool: 'aa', order: {}, agents: {} }),
      p.configure({ defaultPool: 'bb', order: {}, agents: {} }),
    ]);
    const cfg = JSON.parse(await readFile(join(root, 'pools.json'), 'utf8'));
    expect(['aa', 'bb']).toContain(cfg.defaultPool);
  });
});

describe('removeAccount · removePool', () => {
  async function poolsRoot(): Promise<string> {
    const root = await tmp();
    await mkdir(join(root, 'work', 'lime'), { recursive: true });
    await mkdir(join(root, 'work', 'plum'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    return root;
  }

  it('계정 디렉터리를 지운다', async () => {
    const root = await poolsRoot();
    await port(root).removeAccount('work', 'lime');
    expect((await port(root).list()).pools[0]!.accounts.map((a) => a.name)).toEqual(['plum']);
  });

  it('풀 디렉터리를 지운다', async () => {
    const root = await poolsRoot();
    await port(root).removePool('work');
    expect((await port(root).list()).pools).toEqual([]);
  });

  it('뿌리 밖을 지우려는 이름을 거절한다', async () => {
    // 파괴적 연산이다. 이름 문법이 이미 막지만, 그 방어가 여기 있다는 사실을 고정한다.
    const root = await poolsRoot();
    await expect(port(root).removePool('..')).rejects.toThrow();
    await expect(port(root).removeAccount('..', 'x')).rejects.toThrow();
    await expect(port(root).removeAccount('work', '..')).rejects.toThrow();
  });

  it('없는 것을 지우려 하면 거절한다 — 조용히 성공하지 않는다', async () => {
    // 조용히 성공하면 UI 가 "지웠다"를 그리는데 실제로는 다른 것이 남아 있을 수 있다.
    const root = await poolsRoot();
    await expect(port(root).removeAccount('work', 'ghost')).rejects.toThrow();
    await expect(port(root).removePool('ghost')).rejects.toThrow();
  });
});

describe('move', () => {
  it('평평한 계정을 풀 안으로 옮기고 상태를 다시 잰다', async () => {
    // 실측: 자격증명 파일이 디렉터리와 함께 움직이므로 로그인이 유지된다. 그러나 무조건
    // 성공한다고 말하지 않는다 — 옮긴 뒤 다시 재서 사실을 돌려준다.
    const root = await tmp();
    await mkdir(join(root, 'leftover'), { recursive: true });
    await writeFile(join(root, 'leftover', '.credentials.json'), '{}');
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));

    const res = await port(root, LOGGED_IN).move('leftover', 'work');
    expect(res.loggedIn).toBe(true);
    const snap = await port(root).list();
    expect(snap.strays).toEqual([]);
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['leftover']);
  });

  it('옮긴 뒤 미로그인이면 그 사실을 돌려준다 — 되돌리지 않는다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'leftover'), { recursive: true });
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const res = await port(root, LOGGED_OUT).move('leftover', 'work');
    expect(res.loggedIn).toBe(false);
    // 옮긴 것은 그대로다 — 되돌리면 사용자가 이전을 또 해야 한다.
    expect((await port(root).list()).pools[0]!.accounts.map((a) => a.name)).toEqual(['leftover']);
  });

  it('대상 이름이 이미 있으면 거절한다 — 덮어쓰지 않는다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'lime'), { recursive: true });
    await mkdir(join(root, 'work', 'lime'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    await expect(port(root).move('lime', 'work')).rejects.toThrow();
  });

  it('없는 풀로 옮기려 하면 거절한다', async () => {
    const root = await tmp();
    await mkdir(join(root, 'leftover'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({}));
    await expect(port(root).move('leftover', 'ghost')).rejects.toThrow();
  });

  it('이름 문법을 잰다', async () => {
    const root = await tmp();
    await writeFile(join(root, 'pools.json'), JSON.stringify({}));
    await expect(port(root).move('..', 'work')).rejects.toThrow();
    await expect(port(root).move('lime', '..')).rejects.toThrow();
  });
});
