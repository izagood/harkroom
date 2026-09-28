// 앱 없는 머신의 길(스펙 2026-09-20 §3·단계 6). `register` 는 등록 코드를 토큰으로 바꿔 이
// 머신에 남기고 설정에 커뮤니티 자리를 만든다. `run` 은 앱이 넘기던 인자를 데이터
// 디렉터리 하나에서 스스로 조립한다 — 앱과 **같은 규칙**(`daemonEndpointPaths`)으로, 앱이
// 나중에 같은 머신에 떠도 같은 소켓을 보게.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDataDir, parseCliArgs, register, runArgs } from '../src/cli.js';
import { fileSecrets } from '../src/secrets.js';

describe('parseCliArgs', () => {
  it('register <baseUrl> <code> [--name n] / run [--data-dir d] / mcp-bridge / 나머지는 앱의 daemon 인자', () => {
    expect(parseCliArgs(['register', 'https://example.com/', 'ABCD-1234', '--name', 'lab'])).toEqual({ command: 'register', baseUrl: 'https://example.com', code: 'ABCD-1234', name: 'lab' });
    expect(parseCliArgs(['run', '--data-dir', '/data'])).toEqual({ command: 'run', dataDir: '/data' });
    expect(parseCliArgs(['run'])).toEqual({ command: 'run', dataDir: undefined });
    expect(parseCliArgs(['mcp-bridge'])).toEqual({ command: 'mcp-bridge' });
    expect(parseCliArgs(['--socket', '/x.sock'])).toEqual({ command: 'daemon', argv: ['--socket', '/x.sock'] });
  });
  it('register 에 URL 이나 코드가 없으면 던진다 — 반쯤 등록된 상태를 만들지 않는다', () => {
    expect(() => parseCliArgs(['register', 'https://example.com'])).toThrow(/register <baseUrl> <code>/);
    expect(() => parseCliArgs(['register', 'not a url', 'CODE'])).toThrow(/baseUrl/);
  });
});

describe('defaultDataDir — 앱과 같은 자리', () => {
  it('macOS 는 ~/Library/Application Support/app.harkroom.desktop, 리눅스는 XDG_DATA_HOME 아래', () => {
    expect(defaultDataDir('darwin', {}, '/Users/u')).toBe('/Users/u/Library/Application Support/app.harkroom.desktop');
    expect(defaultDataDir('linux', {}, '/home/u')).toBe('/home/u/.local/share/app.harkroom.desktop');
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/xdg' }, '/home/u')).toBe('/xdg/app.harkroom.desktop');
  });
  it('HARKROOM_DATA_DIR 이 있으면 그것이 이긴다', () => {
    expect(defaultDataDir('darwin', { HARKROOM_DATA_DIR: '/srv/hk' }, '/Users/u')).toBe('/srv/hk');
  });
});

describe('runArgs — 앱이 넘기던 인자를 데이터 디렉터리에서 조립한다', () => {
  it('소켓·토큰·pid 는 daemonEndpointPaths 규칙 그대로, launch-nonce 는 없다', () => {
    const args = runArgs('/data', '/opt/harkroom/harkroom-operator', '0.3.0');
    expect(args).toEqual({
      socket: '/data/operator/operator-v1.sock',
      token: '/data/operator/operator-v1.token',
      pidRecord: '/data/operator/operator-v1.pid',
      entryPath: '/opt/harkroom/harkroom-operator',
      appVersion: '0.3.0',
      unknown: [],
    });
  });
});

describe('runArgs — 소켓 경로 상한', () => {
  it('데이터 디렉터리가 길어 소켓 경로가 상한을 넘으면 뜨기 전에 사유와 함께 던진다', () => {
    const long = '/tmp/' + 'a'.repeat(120);
    expect(() => runArgs(long, '/opt/harkroom/harkroom-operator')).toThrow(/소켓 경로가 너무 길다[\s\S]*HARKROOM_DATA_DIR/);
  });
});

describe('register', () => {
  it('claim 으로 토큰을 받아 secrets 에 두고, 설정에 커뮤니티 자리를 만든다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cli-'));
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ operator: { id: 'op-1', name: 'lab' }, token: 'hkop_secret' }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await register({ baseUrl: 'https://example.com', code: 'ABCD-1234', name: 'lab' }, { dataDir: dir, fetchImpl });
    expect(out).toEqual({ operatorId: 'op-1', name: 'lab', baseUrl: 'https://example.com' });
    expect(calls).toEqual([{ url: 'https://example.com/operators/claim', body: { code: 'ABCD-1234', name: 'lab' } }]);
    expect(await fileSecrets(join(dir, 'operator', 'secrets')).getToken('https://example.com')).toBe('hkop_secret');
    const cfg = JSON.parse(await readFile(join(dir, 'operator', 'operator.json'), 'utf8'));
    // 오퍼레이터 id 도 함께 적힌다 — 앱이 `GET /operators` 에서 **이 기기**를 고르는 근거다.
    expect(cfg.communities['https://example.com']).toEqual({ agents: {}, operatorId: 'op-1' });
  });
  it('이미 있는 커뮤니티의 로컬 설정(agents)은 건드리지 않는다 — 토큰만 새로', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cli-'));
    const { writeConfig } = await import('../src/config.js');
    await writeConfig(join(dir, 'operator', 'operator.json'), { communities: { 'https://example.com': { agents: { 'a-1': { workingDir: '~/x' } } } } });
    const fetchImpl = (async () => new Response(JSON.stringify({ operator: { id: 'op-2', name: 'lab' }, token: 'hkop_new' }), { status: 200 })) as unknown as typeof fetch;
    await register({ baseUrl: 'https://example.com', code: 'C', name: 'lab' }, { dataDir: dir, fetchImpl });
    const cfg = JSON.parse(await readFile(join(dir, 'operator', 'operator.json'), 'utf8'));
    expect(cfg.communities['https://example.com'].agents).toEqual({ 'a-1': { workingDir: '~/x' } });
  });
  it('서버가 거절하면(코드 만료 등) 던지고 아무것도 쓰지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cli-'));
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'invalid_code', message: '등록 코드가 없거나 만료됐다' } }), { status: 401 })) as unknown as typeof fetch;
    await expect(register({ baseUrl: 'https://example.com', code: 'OLD', name: 'lab' }, { dataDir: dir, fetchImpl })).rejects.toThrow(/등록 코드가 없거나 만료됐다/);
    expect(await fileSecrets(join(dir, 'operator', 'secrets')).getToken('https://example.com')).toBeNull();
  });
  it('이름을 안 주면 호스트 이름이다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-cli-'));
    let sent: { name?: string } = {};
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ operator: { id: 'op-3', name: sent.name }, token: 'hkop_x' }), { status: 200 });
    }) as unknown as typeof fetch;
    await register({ baseUrl: 'https://example.com', code: 'C' }, { dataDir: dir, fetchImpl, hostname: () => 'lab-mac' });
    expect(sent.name).toBe('lab-mac');
  });
});
