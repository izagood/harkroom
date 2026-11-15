import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPiLaunchEnv, PI_MANAGED_INSTALL_ROOT_ENV, resolvePiLaunch } from '../src/piLaunch.js';
import { buildTurnCommand } from '../src/turn.js';

// 설치기가 까는 꼴을 임시 폴더에 짓는다: <root>/agent/bin/pi(런처) · <root>/agent/install/current-version ·
// <root>/agent/install/releases/<v>/node_modules/.bin/pi · <root>/path/pi → ../agent/bin/pi(사람 PATH 의 링크).
let root: string;
const agent = () => join(root, 'agent');
const pathDir = () => join(root, 'path');
const releaseBin = (v: string) => join(agent(), 'install', 'releases', v, 'node_modules', '.bin', 'pi');

async function exe(p: string, body = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body);
  await chmod(p, 0o755);
}

async function install(opts: { version?: string | null; release?: boolean; bin?: boolean } = {}): Promise<void> {
  const v = opts.version === undefined ? '1.4.0' : opts.version;
  await exe(join(agent(), 'bin', 'pi'), '#!/bin/sh\necho launcher\n');
  await mkdir(join(agent(), 'install'), { recursive: true });
  if (v !== null) await writeFile(join(agent(), 'install', 'current-version'), `${v}\n`);
  if (v !== null && opts.release !== false) {
    await mkdir(join(agent(), 'install', 'releases', v, 'node_modules', '.bin'), { recursive: true });
    if (opts.bin !== false) await exe(releaseBin(v));
  }
  await mkdir(pathDir(), { recursive: true });
  await symlink(join('..', 'agent', 'bin', 'pi'), join(pathDir(), 'pi'));
}

const env = (extra: Record<string, string> = {}) => ({ PATH: pathDir(), HOME: join(root, 'home'), ...extra });

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'pi-launch-'))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('resolvePiLaunch — 런처 대신 release 실행 파일', () => {
  it('PATH 의 pi 가 `<agent>/bin/pi` 로 풀리면 current-version 의 판 실행 파일을 직접 부른다', async () => {
    await install();
    const got = resolvePiLaunch(env());
    expect(got.command).toBe(releaseBin('1.4.0'));
    expect(got.pathPrepend).toBeNull();
  });

  it('폴백 ① current-version 이 없으면 `pi`', async () => {
    await install({ version: null });
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
  });

  it('폴백 ② 그 판 폴더가 없으면 `pi`', async () => {
    await install({ release: false });
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
  });

  it('폴백 ③ 실행 파일이 없으면 `pi`(실행 권한이 없어도 같다)', async () => {
    await install({ bin: false });
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
    await writeFile(releaseBin('1.4.0'), '#!/bin/sh\n');
    await chmod(releaseBin('1.4.0'), 0o644);
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
  });

  it('판 문자가 런처 규칙 밖(`..`·`/`)이면 `pi` — 판 이름으로 폴더 밖을 가리키지 못한다', async () => {
    for (const v of ['..', '.', '../x', 'a b']) {
      await rm(root, { recursive: true, force: true });
      root = await realpath(await mkdtemp(join(tmpdir(), 'pi-launch-')));
      await install({ version: v, release: false });
      expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
    }
  });

  it('PATH 에 pi 가 없거나 런처 꼴(`…/bin/pi`)이 아니면 `pi`', async () => {
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
    await exe(join(pathDir(), 'pi'));
    expect(resolvePiLaunch(env())).toEqual({ command: 'pi', pathPrepend: null });
  });

  it('pi 전용 node 가 있으면 그 폴더를 PATH 앞에 붙인다(XDG_DATA_HOME 우선, 없으면 HOME/.local/share)', async () => {
    await install();
    await exe(join(root, 'home', '.local', 'share', 'pi-node', 'current', 'bin', 'node'));
    expect(resolvePiLaunch(env()).pathPrepend).toBe(join(root, 'home', '.local', 'share', 'pi-node', 'current', 'bin'));
    await exe(join(root, 'xdg', 'pi-node', 'current', 'bin', 'node'));
    expect(resolvePiLaunch(env({ XDG_DATA_HOME: join(root, 'xdg') })).pathPrepend).toBe(join(root, 'xdg', 'pi-node', 'current', 'bin'));
  });

  it('사람 설치 폴더를 읽기만 한다 — install/ 의 mtime·파일이 그대로다', async () => {
    await install();
    const before = (await stat(join(agent(), 'install'))).mtimeMs;
    resolvePiLaunch(env());
    expect((await stat(join(agent(), 'install'))).mtimeMs).toBe(before);
    expect(await readFile(join(agent(), 'install', 'current-version'), 'utf8')).toBe('1.4.0\n');
  });
});

describe('applyPiLaunchEnv', () => {
  it('런처가 싣는 관리 자리 이름을 걷고, node 폴더를 PATH 앞에 둔다', () => {
    const e = applyPiLaunchEnv({ PATH: '/usr/bin', [PI_MANAGED_INSTALL_ROOT_ENV]: '/x/install' }, { command: '/r/pi', pathPrepend: '/n/bin' });
    expect(e).toEqual({ PATH: '/n/bin:/usr/bin' });
  });
});

describe('buildTurnCommand — pi 띄우기', () => {
  const opts = (piLaunch?: { command: string; pathPrepend: string | null }) => ({
    harness: 'pi', mode: 'mention', sessionId: 'b2bc89d1-0000-4000-8000-000000000001', isFirstTurn: true,
    systemPrompt: '', systemPromptFile: null, promptCtx: '', stdinFile: null, model: null, effort: null,
    mentionPermission: 'auto', mcpConfigPath: '/state/mcp.json', extraMcpServers: {}, operatorBin: '/op',
    codexHome: '/state/codex', opencodeHome: '/state/oc', piHome: '/state/pi-home', claudeConfigDir: null,
    ...(piLaunch ? { piLaunch } : {}),
  }) as Parameters<typeof buildTurnCommand>[0];

  it('해석한 release 실행 파일로 띄우고 관리 자리 이름은 자식 env 에 없다', () => {
    const prev = process.env[PI_MANAGED_INSTALL_ROOT_ENV];
    process.env[PI_MANAGED_INSTALL_ROOT_ENV] = '/human/install';
    try {
      const plan = buildTurnCommand(opts({ command: '/a/install/releases/1.4.0/node_modules/.bin/pi', pathPrepend: '/n/bin' }));
      expect(plan.command).toBe('/a/install/releases/1.4.0/node_modules/.bin/pi');
      expect(plan.env[PI_MANAGED_INSTALL_ROOT_ENV]).toBeUndefined();
      expect(plan.env.PATH?.startsWith('/n/bin:')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env[PI_MANAGED_INSTALL_ROOT_ENV]; else process.env[PI_MANAGED_INSTALL_ROOT_ENV] = prev;
    }
  });

  it('폴백이면 지금처럼 `pi`', () => {
    expect(buildTurnCommand(opts({ command: 'pi', pathPrepend: null })).command).toBe('pi');
  });
});
