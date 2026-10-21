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
      { name: 'slack', source: 'operator', transport: 'http', target: 'https://mcp.example.com/mcp', args: [], envKeys: [], headerKeys: ['Authorization'], oauth: true, oauthClientId: 'c', oauthCallbackPort: 3118 },
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
    return {
      calls,
      oauth: {
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

  it('clientId 를 바꾸면 옛 토큰을 버린다 — 같은 clientId 로 다시 넣으면 건드리지 않는다(security F2)', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'OLD', callbackPort: 3118 } });
    f.calls.length = 0;
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'OLD', callbackPort: 3118 } });
    expect(f.calls).toEqual([]);
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'NEW', callbackPort: 3118 } });
    expect(f.calls).toEqual(['forget:slack']);
    const raw = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(raw.slack).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'NEW', callbackPort: 3118 } });
    const row = (await port.list()).servers.find((x) => x.name === 'slack');
    expect(row).toMatchObject({ oauthClientId: 'NEW' });
  });

  it('Client ID 를 비워 보내면 같은 URL 일 때만 지금 값을 유지한다 — 토큰도 건드리지 않는다(MCP 설정 v2 PR3)', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'OWN', callbackPort: 3118 } });
    f.calls.length = 0;
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { callbackPort: 3118 } });
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).slack.oauth).toEqual({ clientId: 'OWN', callbackPort: 3118 });
    // oauth 블록 자체를 빼고 보내도 같다.
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp' });
    expect(f.calls).toEqual([]);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).slack.oauth).toEqual({ clientId: 'OWN' });
    expect((await port.list()).servers.find((x) => x.name === 'slack')).toMatchObject({ oauthClientId: 'OWN' });
  });

  it('URL 이 바뀌면 비운 Client ID 를 유지하지 않는다 — 옛 클라이언트는 새 서버의 것이 아니다(security #1453 n4)', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'OWN', callbackPort: 3118 } });
    f.calls.length = 0;
    await port.set('slack', { type: 'http', url: 'https://other.example.com/mcp', oauth: { callbackPort: 3118 } });
    expect(f.calls).toEqual(['forget:slack']);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).slack).toEqual({ type: 'http', url: 'https://other.example.com/mcp', oauth: { callbackPort: 3118 } });
  });

  it('목록에 callbackPort 를 싣는다 — 앱이 편집할 때 손으로 넣은 포트를 지킨다', async () => {
    const { registryPath } = await fresh();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: fakeOAuth().oauth });
    await port.set('linear', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { callbackPort: 4555 } });
    await port.set('plain', { type: 'http', url: 'https://plain.example.com/mcp' });
    const rows = (await port.list()).servers;
    expect(rows.find((x) => x.name === 'linear')).toMatchObject({ oauthCallbackPort: 4555 });
    expect(rows.find((x) => x.name === 'plain')).not.toHaveProperty('oauthCallbackPort');
  });

  it('정의를 빼면(「이 맥에서 지우기」) 그 토큰도 지운다 — 정의가 없으면 아무것도 하지 않는다', async () => {
    const { registryPath } = await fresh();
    const f = fakeOAuth();
    const port = createLocalMcpPort({ registryPath, claudeConfigPath: null, oauth: f.oauth });
    await port.set('slack', { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'OWN' } });
    f.calls.length = 0;
    await port.remove('slack');
    expect(f.calls).toEqual(['forget:slack']);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).not.toHaveProperty('slack');
    f.calls.length = 0;
    await port.remove('slack');
    expect(f.calls).toEqual([]);
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

describe('operatorMcpSet 의 oauth(2026-10-21, 전용 Slack 앱)', () => {
  it('clientId 는 앞뒤 공백을 자르고, client secret 은 받지 않는다 — PKCE 공개 클라이언트만', () => {
    expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: ' C-1 ', callbackPort: 3118 } } }))
      .toEqual({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: 'C-1', callbackPort: 3118 } } });
    for (const clientSecret of ['S1', '', 7]) {
      expect(readOperatorMcpSetPayload({ name: 'slack', definition: { type: 'http', url: 'https://x', oauth: { clientId: 'C', clientSecret } } })).toMatchObject({ code: 'bad-payload' });
    }
  });
});
