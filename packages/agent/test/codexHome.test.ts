import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAuthSource, codexSessionsDir, ensureCodexHome, sourceCodexHome, syncCodexAuth } from '../src/codexHome.js';

const roots: string[] = [];
const temp = async (prefix: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ensureCodexHome', () => {
  it('개인 auth 만 링크하고 config·sessions 는 러너 상태에 격리한다', async () => {
    const state = await temp('harkroom-state-');
    const source = await temp('codex-source-');
    await writeFile(join(source, 'auth.json'), '{"token":"secret"}', 'utf8');
    await writeFile(join(source, 'config.toml'), '[mcp_servers.personal]', 'utf8');

    const home = await ensureCodexHome(join(state, 'codex-home'), source);
    expect((await lstat(join(home, 'auth.json'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, 'auth.json'))).toBe(join(source, 'auth.json'));
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toContain('secret');
    expect(await lstat(join(home, 'config.toml')).then(() => true, () => false)).toBe(false);
    expect(codexSessionsDir(home)).toBe(join(home, 'sessions'));
  });

  it('개인 auth 가 없으면 Codex 자체 로그인용 빈 홈만 만든다', async () => {
    const state = await temp('harkroom-state-');
    const source = await temp('codex-source-');
    const home = await ensureCodexHome(join(state, 'codex-home'), source);
    expect(await lstat(home).then((s) => s.isDirectory())).toBe(true);
    expect(await lstat(join(home, 'auth.json')).then(() => true, () => false)).toBe(false);
  });

  it('Harkroom 홈에 직접 로그인한 auth 파일은 덮어쓰지 않는다', async () => {
    const state = await temp('harkroom-state-');
    const source = await temp('codex-source-');
    await writeFile(join(source, 'auth.json'), 'source', 'utf8');
    const home = join(state, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), 'harkroom-login', 'utf8');

    await expect(ensureCodexHome(home, source)).resolves.toBe(home);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('harkroom-login');
  });

  it('기존 auth 심볼릭 링크가 다른 파일을 가리키면 조용히 교체하지 않고 실패한다', async () => {
    const state = await temp('harkroom-state-');
    const source = await temp('codex-source-');
    const other = await temp('codex-other-');
    await writeFile(join(source, 'auth.json'), 'source', 'utf8');
    await writeFile(join(other, 'auth.json'), 'other', 'utf8');
    const home = join(state, 'codex-home');
    await mkdir(home, { recursive: true });
    await symlink(join(other, 'auth.json'), join(home, 'auth.json'));

    await expect(ensureCodexHome(home, source)).rejects.toThrow(/예상과 다르다/);
  });
});

it('sourceCodexHome 은 러너가 받은 CODEX_HOME 을 존중한다', () => {
  expect(sourceCodexHome({ CODEX_HOME: '/tmp/custom-codex' })).toBe('/tmp/custom-codex');
});

describe('여러 codex 계정 — 활성 계정으로 링크를 돌린다', () => {
  const setup = async () => {
    const state = await temp('harkroom-state-');
    const system = await temp('codex-system-');
    const accounts = await temp('codex-accounts-');
    await writeFile(join(system, 'auth.json'), 'system', 'utf8');
    for (const name of ['work', 'personal']) {
      await mkdir(join(accounts, name), { recursive: true });
      await writeFile(join(accounts, name, 'auth.json'), name, 'utf8');
    }
    const env = { CODEX_HOME: system, HARKROOM_CODEX_ACCOUNTS_DIR: accounts } as NodeJS.ProcessEnv;
    return { home: join(state, 'codex-home'), system, accounts, env };
  };
  const activate = (accounts: string, active: string | null) =>
    writeFile(join(accounts, 'active.json'), JSON.stringify({ active }), 'utf8');

  it('active.json 이 없으면 시스템 기본 로그인이다', async () => {
    const { system, env } = await setup();
    expect(await codexAuthSource(env)).toEqual({ home: system, account: null });
  });

  it('활성 계정이 바뀌면 다음 sync 에서 링크가 그 계정으로 돈다 — 파일은 건드리지 않는다', async () => {
    const { home, accounts, env } = await setup();
    expect((await syncCodexAuth(home, env)).account).toBeNull();
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('system');

    await activate(accounts, 'work');
    expect((await syncCodexAuth(home, env)).account).toBe('work');
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('work');

    await activate(accounts, 'personal');
    await syncCodexAuth(home, env);
    expect(await readlink(join(home, 'auth.json'))).toBe(join(accounts, 'personal', 'auth.json'));

    await activate(accounts, null);
    await syncCodexAuth(home, env);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('system');
    // 계정 파일은 그대로다
    expect(await readFile(join(accounts, 'work', 'auth.json'), 'utf8')).toBe('work');
  });

  it('로그인이 없는 계정·깨진 active.json·문법 밖 이름은 시스템 기본으로 떨어진다', async () => {
    const { system, accounts, env } = await setup();
    await mkdir(join(accounts, 'empty'), { recursive: true });
    await activate(accounts, 'empty');
    expect((await codexAuthSource(env)).home).toBe(system);
    await writeFile(join(accounts, 'active.json'), '{not json', 'utf8');
    expect((await codexAuthSource(env)).home).toBe(system);
    await activate(accounts, '../work');
    expect((await codexAuthSource(env)).home).toBe(system);
  });

  it('모르는 자리를 가리키는 링크는 여전히 돌리지 않는다', async () => {
    const { home, accounts, env } = await setup();
    const other = await temp('codex-other-');
    await writeFile(join(other, 'auth.json'), 'other', 'utf8');
    await mkdir(home, { recursive: true });
    await symlink(join(other, 'auth.json'), join(home, 'auth.json'));
    await activate(accounts, 'work');
    await expect(syncCodexAuth(home, env)).rejects.toThrow(/예상과 다르다/);
  });

  it('러너 홈에 직접 로그인한 실제 파일은 활성 계정이 있어도 보존한다', async () => {
    const { home, accounts, env } = await setup();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), 'direct', 'utf8');
    await activate(accounts, 'work');
    await syncCodexAuth(home, env);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('direct');
  });
});
