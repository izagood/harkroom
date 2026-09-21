// 하네스 MCP 설정은 **오퍼레이터가** 쓴다(스펙 2026-09-20 §6). 서버는 이름만 알고, 정의와
// 토큰은 이 머신에 있다 — `<appDataDir>/operator/mcp-servers.json` 이 첫째, 그 다음이
// claude 의 `~/.claude.json` 이다. 러너는 완성된 파일의 경로만 받는다.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpConfig, claudeConfigPath, readLocalMcpDefinitions, writeAgentMcpConfig } from '../src/mcpConfig.js';

const BIN = '/opt/harkroom/harkroom-operator';

describe('buildMcpConfig', () => {
  it('harkroom(stdio, mcp-bridge) + avcs 는 항상, 이름은 정의에서 찾아 합친다', () => {
    const out = buildMcpConfig({ operatorBin: BIN, names: ['github'], definitions: { github: { command: 'gh-mcp', args: ['serve'], env: { GH_TOKEN: 'x' } } } });
    expect(out.missing).toEqual([]);
    expect(out.mcpServers.harkroom).toEqual({ type: 'stdio', command: BIN, args: ['mcp-bridge'] });
    expect(out.mcpServers.avcs).toEqual({ type: 'stdio', command: 'avcs', args: ['mcp'] });
    expect(out.mcpServers.github).toEqual({ type: 'stdio', command: 'gh-mcp', args: ['serve'], env: { GH_TOKEN: 'x' } });
  });
  it('정의가 없는 이름은 missing 으로 돌려준다 — 조용히 빼지 않는다', () => {
    const out = buildMcpConfig({ operatorBin: BIN, names: ['github', 'slack'], definitions: { github: { command: 'x' } } });
    expect(out.missing).toEqual(['slack']);
  });
  it('harkroom·avcs 라는 이름은 정의로 덮어쓰지 못한다 — 브릿지가 사라지면 에이전트가 답할 길이 없다', () => {
    const out = buildMcpConfig({ operatorBin: BIN, names: ['harkroom'], definitions: { harkroom: { command: 'evil' } } });
    expect(out.mcpServers.harkroom).toMatchObject({ command: BIN });
    expect(out.missing).toEqual([]);
  });
});

describe('readLocalMcpDefinitions', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('오퍼레이터 레지스트리가 claude 설정보다 앞선다; 둘 다 없으면 빈 표', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hk-mcp-'));
    expect(await readLocalMcpDefinitions({ registryPath: join(dir, 'none.json'), claudeConfigPath: join(dir, 'none2.json') })).toEqual({});
    await writeFile(join(dir, 'mcp-servers.json'), JSON.stringify({ github: { command: 'ours' } }));
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'theirs' }, slack: { type: 'stdio', command: 'slack-mcp' } } }));
    const defs = await readLocalMcpDefinitions({ registryPath: join(dir, 'mcp-servers.json'), claudeConfigPath: join(dir, '.claude.json') });
    expect(defs.github).toEqual({ command: 'ours' });
    expect(defs.slack).toEqual({ type: 'stdio', command: 'slack-mcp' });
  });
  it('깨진 JSON 은 던진다 — 반쯤 읽은 표로 에이전트를 띄우지 않는다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hk-mcp-'));
    await writeFile(join(dir, 'mcp-servers.json'), '{ nope');
    await expect(readLocalMcpDefinitions({ registryPath: join(dir, 'mcp-servers.json'), claudeConfigPath: null })).rejects.toThrow(/mcp-servers\.json/);
  });
});

describe('claudeConfigPath', () => {
  it('CLAUDE_CONFIG_DIR 이 있으면 그 아래, 없으면 홈의 .claude.json', () => {
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/u')).toBe('/cfg/.claude.json');
    expect(claudeConfigPath({}, '/home/u')).toBe('/home/u/.claude.json');
  });
});

describe('writeAgentMcpConfig', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it('에이전트별 파일을 0600 으로 쓰고 경로를 돌려준다 — env 에 토큰이 실릴 수 있다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'hk-mcp-'));
    const path = await writeAgentMcpConfig(join(dir, 'mcp'), 'a-1', { harkroom: { type: 'stdio', command: BIN, args: ['mcp-bridge'] } });
    expect(path).toBe(join(dir, 'mcp', 'a-1.json'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ mcpServers: { harkroom: { type: 'stdio', command: BIN, args: ['mcp-bridge'] } } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
