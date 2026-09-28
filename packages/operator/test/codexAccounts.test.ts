import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { CodexLoginEvent } from '@harkroom/shared/daemonProtocol';

import { codexStatusFromDisk, createCodexAccountsPort, type CodexLoginChild } from '../src/codexAccounts.js';

const roots: string[] = [];
const temp = async (): Promise<string> => {
  const p = await mkdtemp(join(tmpdir(), 'codex-acct-'));
  roots.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

/** 가짜 id_token — 서명은 보지 않으므로 페이로드만 맞으면 된다. 값은 전부 가짜다. */
const idToken = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

const writeAuth = async (home: string, email: string, plan = 'plus'): Promise<void> => {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }),
      access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH',
    },
  }), 'utf8');
};

class FakeChild extends EventEmitter implements CodexLoginChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number): boolean { this.killed.push(signal); return true; }
  override on(ev: string, cb: (...a: never[]) => void): this { return super.on(ev, cb as never); }
}

describe('codexStatusFromDisk', () => {
  it('id_token 페이로드에서 이메일·플랜만 읽고 토큰은 싣지 않는다', async () => {
    const home = await temp();
    await writeAuth(home, 'a@example.com', 'pro');
    const s = await codexStatusFromDisk(home);
    expect(s).toMatchObject({ loggedIn: true, authMode: 'chatgpt', email: 'a@example.com', plan: 'pro' });
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('auth.json 이 없거나 깨졌으면 미로그인이다(던지지 않는다)', async () => {
    const home = await temp();
    expect(await codexStatusFromDisk(home)).toEqual({ loggedIn: false });
    await writeFile(join(home, 'auth.json'), '{broken', 'utf8');
    expect(await codexStatusFromDisk(home)).toEqual({ loggedIn: false });
  });

  it('API 키 로그인은 apikey 로 보인다', async () => {
    const home = await temp();
    await writeFile(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }), 'utf8');
    expect(await codexStatusFromDisk(home)).toMatchObject({ loggedIn: true, authMode: 'apikey' });
  });
});

describe('createCodexAccountsPort', () => {
  const setup = async () => {
    const root = await temp();
    const systemHome = await temp();
    const children: FakeChild[] = [];
    const port = createCodexAccountsPort({
      root, systemHome, killGraceMs: 10,
      spawnLogin: () => { const c = new FakeChild(); children.push(c); return c; },
    });
    return { root, systemHome, port, children };
  };

  it('목록: 시스템 기본 + 계정들, 활성은 로그인된 계정만 가리킨다', async () => {
    const { root, systemHome, port } = await setup();
    await writeAuth(systemHome, 'sys@example.com');
    await writeAuth(join(root, 'work'), 'work@example.com');
    await mkdir(join(root, 'empty'));
    const snap = await port.list();
    expect(snap.system.email).toBe('sys@example.com');
    expect(snap.accounts.map((a) => [a.name, a.status.loggedIn])).toEqual([['empty', false], ['work', true]]);
    expect(snap.active).toBeNull();

    await port.activate('work');
    expect((await port.list()).active).toBe('work');
    expect(JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))).toEqual({ active: 'work' });

    await expect(port.activate('empty')).rejects.toThrow(/로그인되지 않은/);
    await port.activate(null);
    expect((await port.list()).active).toBeNull();
  });

  it('활성 계정을 지우면 시스템 기본으로 돌아간다', async () => {
    const { root, port } = await setup();
    await writeAuth(join(root, 'work'), 'work@example.com');
    await port.activate('work');
    await port.removeAccount('work');
    expect(await stat(join(root, 'work')).then(() => true, () => false)).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'active.json'), 'utf8'))).toEqual({ active: null });
    await expect(port.removeAccount('work')).rejects.toThrow(/계정이 없다/);
  });

  it('문법 밖 이름은 경로가 되기 전에 거절한다', async () => {
    const { port } = await setup();
    await expect(port.loginStart('../x')).rejects.toThrow(/문법/);
    await expect(port.removeAccount('A')).rejects.toThrow(/문법/);
  });

  it('로그인: 잘린 청크를 모아 URL 을 한 번 내고, 끝나면 다시 잰 상태를 낸다', async () => {
    const { root, port, children } = await setup();
    const events: CodexLoginEvent[] = [];
    port.onLoginEvent((e) => events.push(e));
    const { loginId } = await port.loginStart('work');
    const child = children[0]!;
    child.stderr.emit('data', Buffer.from('Starting local login server.\nhttps://auth.openai.com/oauth/auth'));
    expect(events).toEqual([]);
    child.stderr.emit('data', Buffer.from('orize?x=1\n'));
    expect(events).toEqual([{ loginId, url: 'https://auth.openai.com/oauth/authorize?x=1' }]);

    // 콜백 포트가 하나라 동시에 둘은 안 된다
    await expect(port.loginStart('other')).rejects.toThrow(/진행 중/);

    await writeAuth(join(root, 'work'), 'work@example.com');
    child.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 20));
    expect(events[1]).toMatchObject({ loginId, done: true, status: { loggedIn: true, email: 'work@example.com' } });
  });

  it('취소는 SIGTERM 을 보내고, 로그인 없이 끝나면 error 를 싣는다', async () => {
    const { port, children } = await setup();
    const events: CodexLoginEvent[] = [];
    port.onLoginEvent((e) => events.push(e));
    const { loginId } = await port.loginStart('work');
    await port.loginCancel(loginId);
    expect(children[0]!.killed).toEqual(['SIGTERM']);
    children[0]!.emit('exit', null, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(events.at(-1)).toMatchObject({ loginId, done: true, status: { loggedIn: false } });
    expect(events.at(-1)!.error).toBeTruthy();
  });
});
