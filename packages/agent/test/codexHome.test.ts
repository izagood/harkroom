import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexSessionsDir, ensureCodexHome, sourceCodexHome } from '../src/codexHome.js';

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
    const state = await temp('murmur-state-');
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
    const state = await temp('murmur-state-');
    const source = await temp('codex-source-');
    const home = await ensureCodexHome(join(state, 'codex-home'), source);
    expect(await lstat(home).then((s) => s.isDirectory())).toBe(true);
    expect(await lstat(join(home, 'auth.json')).then(() => true, () => false)).toBe(false);
  });

  it('Murmur 홈에 직접 로그인한 auth 파일은 덮어쓰지 않는다', async () => {
    const state = await temp('murmur-state-');
    const source = await temp('codex-source-');
    await writeFile(join(source, 'auth.json'), 'source', 'utf8');
    const home = join(state, 'codex-home');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'auth.json'), 'murmur-login', 'utf8');

    await expect(ensureCodexHome(home, source)).resolves.toBe(home);
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('murmur-login');
  });

  it('기존 auth 심볼릭 링크가 다른 파일을 가리키면 조용히 교체하지 않고 실패한다', async () => {
    const state = await temp('murmur-state-');
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
