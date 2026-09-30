// 원격 MCP OAuth 를 오퍼레이터가 든다(2026-09-30, harkroom 스레드 ebb97c7b).
//
// 가짜 인가 서버·MCP 를 한 http 서버로 세우고 명세의 전 과정(보호 자원 메타데이터 → 인가 서버
// 메타데이터 → 동적 등록 → PKCE → 콜백 → 코드 교환 → refresh)을 실제 소켓으로 돈다. 브라우저 자리는
// 테스트가 콜백 url 을 직접 부른다.
//
// 합격 기준(task_manager, 09-30): **한 번 인증하면 모든 풀 계정 턴에서 slack 이 된다. 계정을 바꾸거나
// 지웠다 다시 넣어도 유지된다.** 토큰이 계정 디렉터리 밖(오퍼레이터)에 있고, 러너 설정에 헤더로
// 구워지는 것이 그 기준의 기계적 형태다 — 아래 '합격 기준' 묶음이 그것을 잰다.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpOAuth, type McpOAuth } from '../src/mcpOAuth.js';
import { buildMcpConfig, rewriteMcpConfigTokens, writeAgentMcpConfig } from '../src/mcpConfig.js';

const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

interface Fake {
  origin: string;
  mcpUrl: string;
  calls: { register: number; refresh: number };
  /** 콜백에 쓰일 코드와 그 코드의 challenge. */
  challenges: Map<string, string>;
  refreshToken: string;
  /** refresh 를 거절하게 한다(invalid_grant). */
  revoke(): void;
  close(): Promise<void>;
}

async function fakeServer(opts: { dcr?: boolean } = {}): Promise<Fake> {
  const calls = { register: 0, refresh: 0 };
  const challenges = new Map<string, string>();
  let gen = 1;
  let revoked = false;
  const state = { refresh: 'R1' };
  let origin = '';
  const json = (res: import('node:http').ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(v));
  };
  const server: Server = createServer((req, res) => void (async () => {
    const u = new URL(req.url ?? '/', origin);
    if (u.pathname === '/mcp') {
      json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
      return;
    }
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['read', 'write'] });
      return;
    }
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        ...(opts.dcr === false ? {} : { registration_endpoint: `${origin}/register` }),
      });
      return;
    }
    if (u.pathname === '/register' && req.method === 'POST') {
      calls.register += 1;
      const b = JSON.parse(await body(req)) as { redirect_uris: string[] };
      json(res, 201, { client_id: 'dyn-1', redirect_uris: b.redirect_uris });
      return;
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(await body(req));
      if (f.get('grant_type') === 'authorization_code') {
        const want = challenges.get(f.get('code') ?? '');
        const got = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url');
        if (!want || want !== got || f.get('resource') !== `${origin}/mcp`) { json(res, 400, { error: 'invalid_grant' }); return; }
        json(res, 200, { access_token: 'A1', refresh_token: 'R1', expires_in: 3600, token_type: 'Bearer' });
        return;
      }
      if (f.get('grant_type') === 'refresh_token') {
        calls.refresh += 1;
        if (revoked || f.get('refresh_token') !== state.refresh) { json(res, 400, { error: 'invalid_grant' }); return; }
        gen += 1;
        state.refresh = `R${gen}`; // 회전한다 — 옛 refresh 토큰은 이제 거절된다
        json(res, 200, { access_token: `A${gen}`, refresh_token: state.refresh, expires_in: 3600 });
        return;
      }
    }
    res.writeHead(404).end();
  })());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin, mcpUrl: `${origin}/mcp`, calls, challenges,
    get refreshToken() { return state.refresh; },
    revoke: () => { revoked = true; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** 브라우저 자리: 인가 url 을 읽고 challenge 를 가짜 서버에 알린 뒤 콜백을 부른다. */
async function approve(fake: Fake, authUrl: string, code = 'C1', overrides: { state?: string } = {}): Promise<Response> {
  const u = new URL(authUrl);
  fake.challenges.set(code, u.searchParams.get('code_challenge')!);
  const cb = new URL(u.searchParams.get('redirect_uri')!);
  cb.searchParams.set('code', code);
  cb.searchParams.set('state', overrides.state ?? u.searchParams.get('state')!);
  // localhost 는 테스트 머신에서 ::1 로 풀릴 수 있다 — 오퍼레이터는 둘 다 연다.
  return fetch(cb.toString());
}

async function until(fn: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('시간 안에 조건이 서지 않았다');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir: string;
let fake: Fake;
let clock: number;
let oauth: McpOAuth;
const logs: string[] = [];
const tokens: Array<{ name: string; accessToken: string }> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-oauth-'));
  fake = await fakeServer();
  clock = Date.parse('2026-09-30T06:00:00Z');
  logs.length = 0;
  tokens.length = 0;
  oauth = createMcpOAuth({
    storePath: join(dir, 'secrets', 'mcp-oauth.json'),
    now: () => clock,
    log: (l) => logs.push(l),
    onToken: (name, rec) => { tokens.push({ name, accessToken: rec.accessToken }); },
  });
});
afterEach(async () => {
  oauth.close();
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

describe('인증 흐름', () => {
  it('보호 자원 메타데이터 → 동적 등록 → PKCE → 콜백 → 토큰. 인가 url 은 명세의 칸을 다 싣는다', async () => {
    const { authUrl } = await oauth.start('jira', { type: 'http', url: fake.mcpUrl });
    const q = new URL(authUrl).searchParams;
    expect(authUrl.startsWith(`${fake.origin}/authorize?`)).toBe(true);
    expect(q.get('client_id')).toBe('dyn-1');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('resource')).toBe(fake.mcpUrl);
    expect(q.get('scope')).toBe('read write');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(await oauth.status('jira', fake.mcpUrl)).toEqual({ state: 'pending' });

    const res = await approve(fake, authUrl);
    expect(res.status).toBe(200);
    await until(async () => (await oauth.status('jira', fake.mcpUrl)).state === 'ok');
    expect(fake.calls.register).toBe(1);
    expect(tokens).toEqual([{ name: 'jira', accessToken: 'A1' }]);
    expect((await oauth.tokensFor({ jira: { url: fake.mcpUrl } })).tokens).toEqual({ jira: 'A1' });
  });

  it('토큰 파일은 0600 이다 — 운영자 토큰과 같은 규율', async () => {
    const { authUrl } = await oauth.start('jira', { type: 'http', url: fake.mcpUrl });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('jira', fake.mcpUrl)).state === 'ok');
    expect((await stat(join(dir, 'secrets', 'mcp-oauth.json'))).mode & 0o777).toBe(0o600);
  });

  it('state 가 다르면 교환하지 않는다 — 흐름은 그대로 기다린다', async () => {
    const { authUrl } = await oauth.start('jira', { type: 'http', url: fake.mcpUrl });
    const res = await approve(fake, authUrl, 'C1', { state: 'forged' });
    expect(res.status).toBe(400);
    expect(await oauth.status('jira', fake.mcpUrl)).toEqual({ state: 'pending' });
  });

  it('정의의 clientId·callbackPort 를 쓴다 — 등록된 클라이언트만 받는 서버(slack)는 등록하지 않는다', async () => {
    const free = await new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
    const { authUrl } = await oauth.start('slack', { type: 'http', url: fake.mcpUrl, oauth: { clientId: 'preset-1', callbackPort: free } });
    const q = new URL(authUrl).searchParams;
    expect(q.get('client_id')).toBe('preset-1');
    expect(q.get('redirect_uri')).toBe(`http://localhost:${free}/callback`);
    expect(fake.calls.register).toBe(0);
  });

  it('콜백 포트를 누가 쓰고 있으면 기다리지 않고 말한다 — claude /mcp 가 같은 3118 을 쓴다', async () => {
    const squatter = createServer();
    const port = await new Promise<number>((r) => squatter.listen(0, '127.0.0.1', () => r((squatter.address() as { port: number }).port)));
    try {
      await expect(oauth.start('slack', { type: 'http', url: fake.mcpUrl, oauth: { clientId: 'preset-1', callbackPort: port } }))
        .rejects.toThrow(/콜백 포트 \d+ 를 다른 프로그램이 쓰고 있다/);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });

  it('다시 누르면 앞 흐름을 닫고 새로 연다 — 고정 포트가 앞 흐름에 묶여 있지 않다', async () => {
    const free = await new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
    const def = { type: 'http' as const, url: fake.mcpUrl, oauth: { clientId: 'preset-1', callbackPort: free } };
    await oauth.start('slack', def);
    const { authUrl } = await oauth.start('slack', def);
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');
  });

  it('동적 등록을 안 받고 clientId 도 없으면 이유를 말한다', async () => {
    await fake.close();
    fake = await fakeServer({ dcr: false });
    await expect(oauth.start('x', { type: 'http', url: fake.mcpUrl })).rejects.toThrow(/oauth\.clientId 가 필요하다/);
  });

  it('정의의 url 이 바뀌면 그 토큰은 이 서버의 것이 아니다', async () => {
    const { authUrl } = await oauth.start('jira', { type: 'http', url: fake.mcpUrl });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('jira', fake.mcpUrl)).state === 'ok');
    expect(await oauth.status('jira', `${fake.origin}/other`)).toEqual({ state: 'none' });
    expect((await oauth.tokensFor({ jira: { url: `${fake.origin}/other` } })).tokens).toEqual({});
  });
});

describe('refresh', () => {
  async function authed(): Promise<void> {
    const { authUrl } = await oauth.start('slack', { type: 'http', url: fake.mcpUrl });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');
  }

  it('만료가 가까우면 스폰 전에 refresh 하고, 회전한 refresh 토큰을 저장한다', async () => {
    await authed();
    clock += 3600_000 - 60_000; // 만료 1분 전
    expect((await oauth.tokensFor({ slack: { url: fake.mcpUrl } })).tokens).toEqual({ slack: 'A2' });
    clock += 3600_000 - 60_000;
    expect((await oauth.tokensFor({ slack: { url: fake.mcpUrl } })).tokens).toEqual({ slack: 'A3' });
    expect(fake.refreshToken).toBe('R3');
  });

  it('동시에 물어도 refresh 는 한 번이다 — 회전하는 서버에서 둘째 요청이 첫째 것을 무효로 만든다', async () => {
    await authed();
    clock += 3600_000;
    const [a, b] = await Promise.all([
      oauth.tokensFor({ slack: { url: fake.mcpUrl } }),
      oauth.tokensFor({ slack: { url: fake.mcpUrl } }),
    ]);
    expect(fake.calls.refresh).toBe(1);
    expect(a.tokens).toEqual({ slack: 'A2' });
    expect(b.tokens).toEqual({ slack: 'A2' });
  });

  it('refresh 가 거절되면 expired — 사람이 다시 인증해야 한다(refresh 만료)', async () => {
    await authed();
    fake.revoke();
    clock += 3600_000;
    const r = await oauth.tokensFor({ slack: { url: fake.mcpUrl } });
    expect(r).toEqual({ tokens: {}, expired: ['slack'] });
    expect(await oauth.status('slack', fake.mcpUrl)).toEqual({ state: 'expired' });
    // 다시 인증하면 돌아온다.
    await authed();
    expect(await oauth.status('slack', fake.mcpUrl)).toMatchObject({ state: 'ok' });
  });

  it('refreshDue 는 바뀐 토큰만 돌려준다 — 러너 설정 재작성의 재료', async () => {
    await authed();
    expect(await oauth.refreshDue()).toEqual({});
    clock += 3600_000;
    expect(await oauth.refreshDue()).toEqual({ slack: { url: fake.mcpUrl, accessToken: 'A2' } });
  });

  it('forget 은 토큰을 지운다', async () => {
    await authed();
    await oauth.forget('slack');
    expect(await oauth.status('slack', fake.mcpUrl)).toEqual({ state: 'none' });
  });
});

describe('합격 기준 — 한 번 인증하면 모든 풀 계정 턴에서 된다', () => {
  const BIN = '/Applications/Harkroom.app/Contents/MacOS/harkroom-operator';

  it('러너 설정에 Authorization 으로 굽고 oauth 를 뺀다 — 하네스가 계정 디렉터리의 토큰을 찾지 않는다', async () => {
    const def = { type: 'http' as const, url: fake.mcpUrl, oauth: { clientId: 'preset-1' } };
    const { authUrl } = await oauth.start('slack', { ...def, oauth: { clientId: 'preset-1' } });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');

    const auth = await oauth.tokensFor({ slack: { url: fake.mcpUrl } });
    const built = buildMcpConfig({ operatorBin: BIN, names: ['slack'], definitions: { slack: def }, ...auth });
    expect(built.mcpServers.slack).toEqual({ type: 'http', url: fake.mcpUrl, headers: { Authorization: 'Bearer A1' } });
    expect(built.needsAuth).toEqual([]);
  });

  it('두 에이전트(서로 다른 풀·계정)의 설정이 같은 토큰을 받고, refresh 뒤 둘 다 새 토큰으로 바뀐다 — 러너 재시작 없이', async () => {
    const def = { type: 'http' as const, url: fake.mcpUrl };
    const { authUrl } = await oauth.start('slack', def);
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');
    const mcpDir = join(dir, 'mcp');
    for (const agent of ['agent-on-lime', 'agent-on-lychee']) {
      const auth = await oauth.tokensFor({ slack: { url: fake.mcpUrl } });
      await writeAgentMcpConfig(mcpDir, agent, buildMcpConfig({ operatorBin: BIN, names: ['slack'], definitions: { slack: def }, ...auth }).mcpServers);
    }
    clock += 3600_000;
    const updates = await oauth.refreshDue();
    expect(await rewriteMcpConfigTokens(mcpDir, updates)).toBe(2);
    for (const agent of ['agent-on-lime', 'agent-on-lychee']) {
      const doc = JSON.parse(await readFile(join(mcpDir, `${agent}.json`), 'utf8')) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
      expect(doc.mcpServers.slack?.headers?.Authorization).toBe('Bearer A2');
      // 브릿지 항목은 건드리지 않는다.
      expect(doc.mcpServers.harkroom).toEqual({ type: 'stdio', command: BIN, args: ['mcp-bridge'] });
    }
  });

  it('토큰은 계정 디렉터리 밖에 있다 — 계정을 지우고 다시 넣어도(#941 은 그 Keychain 항목을 지운다) 그대로다', async () => {
    const { authUrl } = await oauth.start('slack', { type: 'http', url: fake.mcpUrl });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');
    // 계정 풀의 뿌리와 무관한 자리 — 오퍼레이터 secrets 에만 있다.
    const stored = JSON.parse(await readFile(join(dir, 'secrets', 'mcp-oauth.json'), 'utf8')) as Record<string, { accessToken: string }>;
    expect(stored.slack?.accessToken).toBe('A1');
    // 오퍼레이터를 다시 띄워도(새 인스턴스) 디스크에서 읽는다.
    const again = createMcpOAuth({ storePath: join(dir, 'secrets', 'mcp-oauth.json'), now: () => clock, log: () => {} });
    expect((await again.tokensFor({ slack: { url: fake.mcpUrl } })).tokens).toEqual({ slack: 'A1' });
  });

  it('토큰이 없으면 정의를 그대로 두고 "인증 필요" 로 적는다 — 배정은 거절하지 않는다', () => {
    const built = buildMcpConfig({
      operatorBin: BIN, names: ['slack', 'jira'],
      definitions: { slack: { type: 'http', url: 'https://slack.example.com/mcp', oauth: { clientId: 'p' } }, jira: { type: 'http', url: 'https://jira.example.com/mcp' } },
      tokens: {}, expired: ['jira'],
    });
    expect(built.missing).toEqual([]);
    expect(built.needsAuth).toEqual(['slack', 'jira']);
    expect(built.mcpServers.slack).toEqual({ type: 'http', url: 'https://slack.example.com/mcp', oauth: { clientId: 'p' } });
  });

  it('url 이 다른 같은 이름에는 남의 토큰을 넣지 않는다', async () => {
    const mcpDir = join(dir, 'mcp');
    await writeAgentMcpConfig(mcpDir, 'a', { slack: { type: 'http', url: 'https://other.example.com/mcp' } });
    expect(await rewriteMcpConfigTokens(mcpDir, { slack: { url: fake.mcpUrl, accessToken: 'A9' } })).toBe(0);
  });
});
