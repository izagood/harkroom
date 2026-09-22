// 앱이 소켓으로 로컬 설정의 에이전트를 넣고 뺀다(스펙 2026-09-20 §3 능력). writer 는 오퍼레이터
// 하나이고, 바뀐 커뮤니티는 능력을 다시 낸다 — 서버가 그것을 봐야 배정이 409 가 아니다.
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalAgentsPort } from '../src/localAgents.js';
import { writeConfig } from '../src/config.js';
import type { OperatorSecrets } from '../src/secrets.js';

const secretsWith = (urls: string[]): OperatorSecrets => ({
  getToken: async (u) => (urls.includes(u) ? 'hkop_x' : null), setToken: async () => {}, clearToken: async () => {},
});

describe('localAgents', () => {
  it('넣으면 파일에 쓰이고 그 커뮤니티에 새 표가 통지된다; 등록 여부는 토큰으로 안다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-local-'));
    const configPath = join(dir, 'operator.json');
    const changed: { baseUrl: string; agents: Record<string, unknown> }[] = [];
    const port = createLocalAgentsPort({ configPath, secrets: secretsWith(['https://example.com']), dataDir: dir, onChanged: (b, a) => changed.push({ baseUrl: b, agents: a }), onRegistered: async () => {} });
    await port.set('https://example.com/', 'a-1', { workingDir: '~/x' });
    expect(changed).toEqual([{ baseUrl: 'https://example.com', agents: { 'a-1': { workingDir: '~/x' } } }]);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ communities: { 'https://example.com': { agents: { 'a-1': { workingDir: '~/x' } } } } });
    const list = await port.list();
    expect(list.communities).toEqual([{ baseUrl: 'https://example.com', registered: true, operatorId: null, agents: { 'a-1': { workingDir: '~/x' } } }]);
  });
  it('등록 전 커뮤니티에도 자리를 만든다 — register 가 토큰을 채우면 그대로 능력이 된다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-local-'));
    const port = createLocalAgentsPort({ configPath: join(dir, 'operator.json'), secrets: secretsWith([]), dataDir: dir, onChanged: () => {}, onRegistered: async () => {} });
    await port.set('https://new.example.com', 'a-2', {});
    expect((await port.list()).communities[0]).toEqual({ baseUrl: 'https://new.example.com', registered: false, operatorId: null, agents: { 'a-2': {} } });
  });
  it('빼면 다른 에이전트는 그대로고, 없는 것을 빼면 아무 일도 없다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-local-'));
    const configPath = join(dir, 'operator.json');
    await writeConfig(configPath, { communities: { 'https://example.com': { agents: { 'a-1': {}, 'a-2': { claudePool: 'p' } } } } });
    const changed: string[] = [];
    const port = createLocalAgentsPort({ configPath, secrets: secretsWith([]), dataDir: dir, onChanged: (b) => changed.push(b), onRegistered: async () => {} });
    await port.remove('https://example.com', 'a-1');
    await port.remove('https://example.com', 'nope');
    expect((await port.list()).communities[0]!.agents).toEqual({ 'a-2': { claudePool: 'p' } });
    expect(changed).toEqual(['https://example.com']);
  });
});

describe('localAgents.register — 앱이 넘긴 코드로 claim 하고 곧바로 붙는다', () => {
  it('claim → 토큰·설정 저장 → onRegistered(baseUrl)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'op-local-'));
    const fetchImpl = (async () => new Response(JSON.stringify({ operator: { id: 'op-9', name: 'mac' }, token: 'hkop_t' }), { status: 200 })) as unknown as typeof fetch;
    const registered: string[] = [];
    const tokens: Record<string, string> = {};
    const secrets: OperatorSecrets = { getToken: async (u) => tokens[u] ?? null, setToken: async (u, t) => { tokens[u] = t; }, clearToken: async () => {} };
    const port = createLocalAgentsPort({ configPath: join(dir, 'operator', 'operator.json'), secrets, dataDir: dir, fetchImpl, onChanged: () => {}, onRegistered: async (b) => { registered.push(b); } });
    const out = await port.register('https://example.com/', 'CODE', 'mac');
    expect(out).toEqual({ operatorId: 'op-9', name: 'mac', baseUrl: 'https://example.com' });
    expect(tokens['https://example.com']).toBe('hkop_t');
    expect(registered).toEqual(['https://example.com']);
    // 등록이 id 를 함께 적어 둔다 — 앱의 '이 기기' 기본값이 그것 하나를 근거로 선다.
    expect((await port.list()).communities[0]).toEqual({ baseUrl: 'https://example.com', registered: true, operatorId: 'op-9', agents: {} });
  });
});
