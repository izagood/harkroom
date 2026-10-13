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
  /** 토큰 엔드포인트가 받은 `grant_type:client_id:client_secret|-`. */
  secretsSeen: string[];
  refreshToken: string;
  /** refresh 를 거절하게 한다(invalid_grant). */
  revoke(): void;
  close(): Promise<void>;
}

async function fakeServer(opts: { dcr?: boolean } = {}): Promise<Fake> {
  const calls = { register: 0, refresh: 0 };
  const challenges = new Map<string, string>();
  const secretsSeen: string[] = [];
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
      secretsSeen.push(`${f.get('grant_type')}:${f.get('client_id')}:${f.get('client_secret') ?? '-'}`);
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
    origin, mcpUrl: `${origin}/mcp`, calls, challenges, secretsSeen,
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

describe('MCP 서버 거절 보고(reportRejected, 2026-10-01)', () => {
  async function authed(): Promise<void> {
    const { authUrl } = await oauth.start('slack', { type: 'http', url: fake.mcpUrl });
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl)).state === 'ok');
  }
  const after = () => clock + 1;

  it('보고를 받으면 만료 전이어도 곧바로 refresh 한다 — 새 토큰을 돌려주고 상태는 ok 다', async () => {
    await authed();
    clock += 60_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' }))
      .toEqual({ action: 'refreshed', url: fake.mcpUrl, accessToken: 'A2' });
    expect(fake.calls.refresh).toBe(1);
    expect(await oauth.status('slack', fake.mcpUrl)).toMatchObject({ state: 'ok' });
    expect((await oauth.tokensFor({ slack: { url: fake.mcpUrl } })).tokens).toEqual({ slack: 'A2' });
    // 로그에 토큰 값이 없다.
    expect(logs.join('\n')).not.toMatch(/A1|A2|R1|R2/);
  });

  it('거절로 당겨 받은 토큰이 다시 거절되면 rejected — 시각과 보고한 에이전트를 남긴다', async () => {
    await authed();
    clock += 60_000;
    await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' });
    clock += 60_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-b' })).toEqual({ action: 'rejected' });
    expect(fake.calls.refresh).toBe(1);
    expect(await oauth.status('slack', fake.mcpUrl)).toEqual({ state: 'rejected', at: clock, agentId: 'agent-b' });
    // 구워 봐야 또 401 이다 — "인증 필요"로 낸다.
    expect(await oauth.tokensFor({ slack: { url: fake.mcpUrl } })).toEqual({ tokens: {}, expired: ['slack'] });
    // 시간 refresh 도 돌리지 않는다. 다시 인증하면 표시가 지워진다.
    clock += 3600_000;
    expect(await oauth.refreshDue()).toEqual({});
    await authed();
    expect(await oauth.status('slack', fake.mcpUrl)).toMatchObject({ state: 'ok' });
  });

  it('지금 토큰을 받기 전에 뜬 턴의 보고는 옛 토큰의 것이다 — 아무것도 하지 않는다', async () => {
    await authed();
    const before = clock - 1;
    clock += 60_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: before, agentId: 'agent-a' })).toEqual({ action: 'ignored', reason: 'stale' });
    // 거절로 새 토큰을 받은 뒤, 그 전에 뜬 다른 턴이 늦게 보고해도 rejected 로 읽지 않는다.
    const turnOnOld = clock;
    clock += 1_000;
    await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' });
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: turnOnOld, agentId: 'agent-b' })).toEqual({ action: 'ignored', reason: 'stale' });
    expect(await oauth.status('slack', fake.mcpUrl)).toMatchObject({ state: 'ok' });
  });

  it('보고가 refresh 를 당기는 것은 이름마다 쿨다운에 한 번이다 — 거짓 보고로 토큰을 계속 돌리지 못한다', async () => {
    // 쿨다운이 토큰 수명보다 길어야 "플래그가 지워진 뒤의 보고"를 잴 수 있다 — 이 인스턴스만 2시간.
    oauth.close();
    oauth = createMcpOAuth({ storePath: join(dir, 'secrets', 'mcp-oauth.json'), now: () => clock, log: (l) => logs.push(l), rejectCooldownMs: 2 * 3600_000 });
    await authed();
    clock += 60_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' })).toMatchObject({ action: 'refreshed', accessToken: 'A2' });
    // 시간 refresh 가 새 토큰을 주면 "거절로 당긴 토큰" 표시는 지워진다 — 그래도 쿨다운은 남는다.
    clock += 3600_000;
    expect(await oauth.refreshDue()).toEqual({ slack: { url: fake.mcpUrl, accessToken: 'A3' } });
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' })).toEqual({ action: 'ignored', reason: 'cooldown' });
    clock += 3600_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' })).toMatchObject({ action: 'refreshed', accessToken: 'A4' });
    expect(fake.calls.refresh).toBe(3);
  });

  it('저장소에 없는 이름·이미 ok 가 아닌 것은 버린다 — refresh 를 부르지 않는다', async () => {
    await authed();
    expect(await oauth.reportRejected('jira', { turnStartedAtMs: after(), agentId: 'agent-a' })).toEqual({ action: 'ignored', reason: 'unknown' });
    // prototype 의 키는 기록이 아니다(security 검토 #990).
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(await oauth.reportRejected(name, { turnStartedAtMs: after(), agentId: 'agent-a' })).toEqual({ action: 'ignored', reason: 'unknown' });
      expect(await oauth.status(name, fake.mcpUrl)).toEqual({ state: 'none' });
    }
    expect(await oauth.tokensFor({ constructor: { url: fake.mcpUrl }, toString: { url: fake.mcpUrl } })).toEqual({ tokens: {}, expired: [] });
    fake.revoke();
    clock += 60_000;
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after(), agentId: 'agent-a' })).toEqual({ action: 'expired' });
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: after() + 6 * 60_000, agentId: 'agent-a' })).toEqual({ action: 'ignored', reason: 'not_ok' });
    expect(fake.calls.refresh).toBe(1);
  });
});

describe('전용 클라이언트로 갈아타기(2026-10-07, 전용 Slack 앱)', () => {
  const def = (clientId: string) => ({ type: 'http' as const, url: fake.mcpUrl, oauth: { clientId } });
  async function authedWith(clientId: string): Promise<void> {
    const { authUrl } = await oauth.start('slack', def(clientId));
    await approve(fake, authUrl);
    await until(async () => (await oauth.status('slack', fake.mcpUrl, clientId)).state === 'ok');
  }

  it('정의의 clientId 가 바뀌면 들고 있던 토큰은 굽지 않고 "인증 필요" — 다시 인증하면 새 클라이언트로 돈다', async () => {
    await authedWith('OLD');
    expect((await oauth.tokensFor({ slack: { url: fake.mcpUrl, clientId: 'OLD' } })).tokens).toEqual({ slack: 'A1' });
    expect(await oauth.status('slack', fake.mcpUrl, 'NEW')).toEqual({ state: 'none' });
    expect(await oauth.tokensFor({ slack: { url: fake.mcpUrl, clientId: 'NEW' } })).toEqual({ tokens: {}, expired: ['slack'] });
    await authedWith('NEW');
    expect(fake.secretsSeen.at(-1)).toBe('authorization_code:NEW:-');
    expect((await oauth.tokensFor({ slack: { url: fake.mcpUrl, clientId: 'NEW' } })).tokens).toEqual({ slack: 'A1' });
  });

  it('secret 이 없으면 PKCE 만으로 교환·refresh 한다 — client_secret 을 싣지 않는다', async () => {
    await authedWith('PUB');
    clock += 3600_000;
    await oauth.refreshDue();
    expect(fake.secretsSeen).toEqual(['authorization_code:PUB:-', 'refresh_token:PUB:-']);
  });

  it('secret 이 있으면 교환·refresh 에 싣는다 — 인증 뒤에 넣어도 다음 refresh 부터. 비밀 파일은 0600, 로그에 값이 없다', async () => {
    await oauth.setClientSecret('slack', 'CONF', 'S-one');
    expect(await oauth.hasClientSecret('slack', 'CONF')).toBe(true);
    expect(await oauth.hasClientSecret('slack', 'OTHER')).toBe(false);
    await authedWith('CONF');
    await oauth.setClientSecret('slack', 'CONF', 'S-two');
    clock += 3600_000;
    await oauth.refreshDue();
    expect(fake.secretsSeen).toEqual(['authorization_code:CONF:S-one', 'refresh_token:CONF:S-two']);
    const path = join(dir, 'secrets', 'mcp-oauth-clients.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(logs.join('\n')).not.toMatch(/S-one|S-two/);
    await oauth.setClientSecret('slack', null, null);
    expect(await oauth.hasClientSecret('slack')).toBe(false);
    expect(await oauth.hasClientSecret('constructor')).toBe(false);
  });

  it('secret 은 clientId 에 묶인다 — 다른 clientId 로는 교환에도 refresh 에도 싣지 않는다(security F1)', async () => {
    await oauth.setClientSecret('slack', 'NEW', 'S-new');
    // 아직 옛 클라이언트로 든 토큰의 refresh 에 새 앱 secret 이 실리지 않는다.
    await authedWith('OLD');
    clock += 3600_000;
    await oauth.refreshDue();
    // 다른 clientId 로 시작해도 싣지 않는다.
    await authedWith('THIRD');
    expect(fake.secretsSeen).toEqual(['authorization_code:OLD:-', 'refresh_token:OLD:-', 'authorization_code:THIRD:-']);
    await expect(oauth.setClientSecret('slack', null, 'S')).rejects.toThrow(/clientId 와 함께만/);
  });

  it('정의의 clientId 가 바뀌면 1분 refresh·거절 보고가 옛 토큰을 돌리지 않는다(security F2)', async () => {
    let current: string | undefined = 'OLD';
    oauth.close();
    oauth = createMcpOAuth({
      storePath: join(dir, 'secrets', 'mcp-oauth.json'), now: () => clock, log: (l) => logs.push(l),
      currentClientId: async () => current,
    });
    await authedWith('OLD');
    current = 'NEW';
    clock += 3600_000;
    const before = fake.calls.refresh;
    expect(await oauth.refreshDue()).toEqual({});
    expect(await oauth.reportRejected('slack', { turnStartedAtMs: clock + 1, agentId: 'a' })).toEqual({ action: 'ignored', reason: 'client_changed' });
    expect(fake.calls.refresh).toBe(before);
    // 정의가 다시 같아지면 평소대로 돈다.
    current = 'OLD';
    expect(await oauth.refreshDue()).toEqual({ slack: { url: fake.mcpUrl, accessToken: 'A2' } });
  });

  it('client secret 파일이 깨져도 오류 문구에 내용이 섞이지 않는다(security n1)', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dir, 'secrets'), { recursive: true });
    await writeFile(join(dir, 'secrets', 'mcp-oauth-clients.json'), 'S-leaky-prefix{');
    await expect(oauth.hasClientSecret('slack')).rejects.toThrow('client secret 파일을 읽지 못했다(형식이 깨졌다)');
    await expect(oauth.hasClientSecret('slack')).rejects.not.toThrow(/S-leaky/);
  });

  it('refresh 토큰이 끝나면(Slack PKCE 앱은 30일) expired — 다시 인증 필요가 보이고 로그에 이유가 남는다', async () => {
    await authedWith('PUB');
    fake.revoke();
    clock += 3600_000;
    expect(await oauth.tokensFor({ slack: { url: fake.mcpUrl, clientId: 'PUB' } })).toEqual({ tokens: {}, expired: ['slack'] });
    expect(await oauth.status('slack', fake.mcpUrl, 'PUB')).toEqual({ state: 'expired' });
    expect(logs.join('\n')).toMatch(/30일/);
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
