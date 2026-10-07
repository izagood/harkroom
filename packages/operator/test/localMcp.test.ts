import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOperatorMcpRemovePayload, readOperatorMcpSetPayload } from '@harkroom/shared/daemonProtocol';
import { createLocalMcpPort } from '../src/localMcp.js';

async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-'));
  return { dir, registryPath: join(dir, 'operator', 'mcp-servers.json'), claudePath: join(dir, '.claude.json') };
}

describe('localMcp 포트', () => {
  it('넣은 정의를 0600 파일에 쓰고, 목록은 env·headers 의 값을 싣지 않는다', async () => {
    const { registryPath } = await fresh();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer SECRET' }, oauth: { clientId: 'c', callbackPort: 3118 } });
    // stdio 는 사람이 손으로 적은 것 — 목록에는 보이되 env 값은 숨긴다.
    const table = JSON.parse(await readFile(registryPath, 'utf8'));
    table.timing = { command: 'timing-mcp', args: ['--x'], env: { TOKEN: 'SECRET2' } };
    await writeFile(registryPath, JSON.stringify(table));
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    const listed = await port.list();
    expect(JSON.stringify(listed)).not.toContain('SECRET');
    expect(listed.servers).toEqual([
      { name: 'slack', source: 'operator', transport: 'http', target: 'https://mcp.example.com/mcp', args: [], envKeys: [], headerKeys: ['Authorization'], oauth: true, oauthClientId: 'c' },
      { name: 'timing', source: 'operator', transport: 'stdio', target: 'timing-mcp', args: ['--x'], envKeys: ['TOKEN'], headerKeys: [], oauth: false },
    ]);
    const onDisk = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(onDisk.slack.headers.Authorization).toBe('Bearer SECRET');
  });

  it('~/.claude.json 정의도 보이고, 같은 이름이면 오퍼레이터 표가 이긴다 — claude 파일은 고치지 않는다', async () => {
    const { registryPath, claudePath } = await fresh();
    const claude = JSON.stringify({ mcpServers: { buddy: { command: 'buddy' }, slack: { type: 'http', url: 'https://old' } } });
    await writeFile(claudePath, claude);
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: claudePath });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' });
    const { servers } = await port.list();
    expect(servers.map((s) => [s.name, s.source, s.target])).toEqual([
      ['buddy', 'claude', 'buddy'], ['slack', 'operator', 'https://mcp.example.com/mcp'],
    ]);
    await port.remove('slack');
    expect((await port.list()).servers.find((s) => s.name === 'slack')?.source).toBe('claude');
    expect(await readFile(claudePath, 'utf8')).toBe(claude);
  });

  it('깨진 표는 빈 표로 읽고 덮어쓰지 않는다 — 던진다', async () => {
    const { dir, registryPath } = await fresh();
    await (await import('node:fs/promises')).mkdir(join(dir, 'operator'), { recursive: true });
    await writeFile(registryPath, '{ not json');
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null });
    await expect(port.set('slack', { type: 'http', url: 'https://x' })).rejects.toThrow();
    expect(await readFile(registryPath, 'utf8')).toBe('{ not json');
  });
});

describe('localMcp 포트 — 원격 MCP 인증 (2026-09-30)', () => {
  function fakeOAuth() {
    const calls: string[] = [];
    const secrets = new Map<string, string>();
    return {
      calls,
      secrets,
      oauth: {
        setClientSecret: async (name: string, v: string | null) => { if (v === null) secrets.delete(name); else secrets.set(name, v); },
        hasClientSecret: async (name: string) => secrets.has(name),
        start: async (name: string, def: { url: string }) => { calls.push(`start:${name}:${def.url}`); return { authUrl: 'https://auth.example.com/a' }; },
        status: async (name: string, url: string) => { calls.push(`status:${name}:${url}`); return { state: 'ok' as const }; },
        tokensFor: async () => ({ tokens: {}, expired: [] }),
        refreshDue: async () => ({}),
        reportRejected: async () => ({ action: 'ignored' as const, reason: 'unknown' as const }),
        forget: async (name: string) => { calls.push(`forget:${name}`); },
        close: () => {},
      },
    };
  }

  it('목록의 원격 항목에 인증 상태를 싣는다 — stdio 에는 없다', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' });
    const table = JSON.parse(await readFile(registryPath, 'utf8'));
    table.timing = { command: 'timing-mcp' };
    await writeFile(registryPath, JSON.stringify(table));
    const listed = await port.list();
    expect(listed.servers.find((s) => s.name === 'slack')?.auth).toEqual({ state: 'ok' });
    expect(listed.servers.find((s) => s.name === 'timing')?.auth).toBeUndefined();
  });

  it('인증은 이 머신의 정의에서 url 을 읽는다 — ~/.claude.json 에만 있는 원격 서버도 된다', async () => {
    const { registryPath, claudePath } = await fresh();
    await writeFile(claudePath, JSON.stringify({ mcpServers: { jira: { type: 'http', url: 'https://jira.example.com/mcp' } } }));
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: claudePath, oauth: f.oauth });
    expect(await port.authStart('jira')).toEqual({ authUrl: 'https://auth.example.com/a' });
    expect(f.calls).toEqual(['start:jira:https://jira.example.com/mcp']);
  });

  it('정의가 없거나 stdio 면 흐름을 열지 않는다', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await expect(port.authStart('nope')).rejects.toThrow(/정의가 이 머신에 없다/);
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' }); // 디렉터리를 만든다
    await writeFile(registryPath, JSON.stringify({ timing: { command: 'timing-mcp' } }));
    await expect(port.authStart('timing')).rejects.toThrow(/원격\(http·sse\) 정의가 아니다/);
    expect(f.calls).toEqual([]);
  });

  it('client secret 은 정의 파일에 넣지 않고 오퍼레이터 비밀로 간다 — 목록엔 있는지만, 정의를 빼면 함께 지운다(2026-10-07)', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    const leaky = { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'C-1', callbackPort: 3118, clientSecret: 'S-sekret' } };
    await port.set('slack', leaky as never, { clientSecret: 'S-sekret' });
    const raw = await readFile(registryPath, 'utf8');
    expect(raw).not.toContain('S-sekret');
    expect(JSON.parse(raw).slack).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'C-1', callbackPort: 3118 } });
    expect(f.secrets.get('slack')).toBe('S-sekret');
    const row = (await port.list()).servers.find((s) => s.name === 'slack');
    expect(row).toMatchObject({ oauthClientId: 'C-1', oauthClientSecret: true });
    expect(JSON.stringify(row)).not.toContain('S-sekret');
    // 안 보내면 그대로, null 이면 지운다.
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'C-1' } });
    expect(f.secrets.has('slack')).toBe(true);
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'C-1' } }, { clientSecret: null });
    expect(f.secrets.has('slack')).toBe(false);
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' }, { clientSecret: 'S2' });
    await port.remove('slack');
    expect(f.secrets.has('slack')).toBe(false);
  });

  it('정의를 빼면 그 토큰도 지운다', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' });
    await port.remove('slack');
    expect(f.calls).toContain('forget:slack');
  });
});

describe('operatorMcpSet/Remove 페이로드', () => {
  it('이름 문법과 예약어를 거절한다', () => {
    expect(readOperatorMcpSetPayload({ name: 'Slack', definition: { type: 'http', url: 'https://x' } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpSetPayload({ name: 'harkroom', definition: { type: 'http', url: 'https://x' } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpRemovePayload({ name: 'avcs' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpRemovePayload({ name: 'slack' })).toEqual({ name: 'slack' });
  });

  it('stdio 는 받지 않는다(#431) — 웹뷰가 실행할 프로그램을 고르는 옆문이 된다', () => {
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { command: 'x' } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { type: 'stdio', command: 'x' } })).toMatchObject({ code: 'bad-payload' });
  });

  it('http 는 http(s) url 이 있어야 하고, oauth·headers 는 모양을 잰다', () => {
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { type: 'http', url: ' https://x/mcp ', headers: {}, oauth: { clientId: 'c', callbackPort: 3118 } } }))
      .toEqual({ name: 'x', definition: { type: 'http', url: 'https://x/mcp', oauth: { clientId: 'c', callbackPort: 3118 } } });
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { type: 'http', url: 'ftp://x' } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { type: 'http', url: 'https://x', oauth: { callbackPort: 70000 } } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpSetPayload({ name: 'x', definition: { type: 'http', url: 'https://x', headers: { A: 1 } } })).toMatchObject({ code: 'bad-payload' });
  });
});

describe('operatorMcpSet 의 client secret(2026-10-07, 전용 Slack 앱)', () => {
  it('secret 은 정의에서 빼서 따로 돌려준다 — 빈 문자열은 지우기, 안 보내면 그대로', () => {
    const r = readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: ' C-1 ', callbackPort: 3118, clientSecret: 'S1' } } });
    expect(r).toEqual({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: 'C-1', callbackPort: 3118 } }, clientSecret: 'S1' });
    expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientSecret: '' } } })).toMatchObject({ clientSecret: null });
    expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: 'C' } } })).not.toHaveProperty('clientSecret');
    expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientSecret: 'a b' } } })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientSecret: 7 } } })).toMatchObject({ code: 'bad-payload' });
  });
});
