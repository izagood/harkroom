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
    await port.set('slack', { type: 'http', url: 'https://mcp.slack.com/mcp', headers: { Authorization: 'Bearer SECRET' }, oauth: { clientId: 'c', callbackPort: 3118 } });
    // stdio 는 사람이 손으로 적은 것 — 목록에는 보이되 env 값은 숨긴다.
    const table = JSON.parse(await readFile(registryPath, 'utf8'));
    table.timing = { command: 'timing-mcp', args: ['--x'], env: { TOKEN: 'SECRET2' } };
    await writeFile(registryPath, JSON.stringify(table));
    expect((await stat(registryPath)).mode & 0o777).toBe(0o600);
    const listed = await port.list();
    expect(JSON.stringify(listed)).not.toContain('SECRET');
    expect(listed.servers).toEqual([
      { name: 'slack', source: 'operator', transport: 'http', target: 'https://mcp.slack.com/mcp', args: [], envKeys: [], headerKeys: ['Authorization'], oauth: true },
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
    await port.set('slack', { type: 'http', url: 'https://mcp.slack.com/mcp' });
    const { servers } = await port.list();
    expect(servers.map((s) => [s.name, s.source, s.target])).toEqual([
      ['buddy', 'claude', 'buddy'], ['slack', 'operator', 'https://mcp.slack.com/mcp'],
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
