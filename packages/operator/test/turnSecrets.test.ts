import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, lstatSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { isRunnerLinkNotice } from '@harkroom/shared/runnerLink';
import { createTurnSecrets, type TurnSecrets } from '../src/turnSecrets.js';

// 비밀 보관소 PR 3 — 오퍼레이터의 secret.mount. 스레드 bc98df3a.
const VALUE = `ghp_${'c'.repeat(36)}`;
const SECRET_ID = '11111111-2222-4333-8444-555555555555';

const mountCall = (name: unknown, cause: string | undefined = 'cause-1', id = 7): RunnerLinkRequest => ({
  type: 'mcp.request', id: 'link-1', cause,
  payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'secret.mount', arguments: { name } } },
});
const resultOf = (res: RunnerLinkResponse | null) => {
  if (!res || res.type !== 'mcp.response') throw new Error('expected mcp.response');
  const msg = res.messages[0] as { id: number; result: { content: { text: string }[]; isError?: boolean } };
  return { id: msg.id, isError: msg.result.isError === true, body: JSON.parse(msg.result.content[0]!.text) };
};

describe('turnSecrets', () => {
  let root: string;
  let calls: RunnerLinkRequest[];
  let revealStatus: number;
  let ts: TurnSecrets;
  let clock: number;

  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'hk-ts-')), 'turn-secrets');
    calls = [];
    revealStatus = 200;
    clock = Date.parse('2026-10-01T00:00:00Z');
    ts = createTurnSecrets({
      root, log: () => {}, now: () => clock,
      forward: async (_agentId, req) => {
        calls.push(req);
        if (req.type !== 'http.forward') throw new Error('unexpected');
        if (req.path === '/agent/secrets/reveal') {
          return revealStatus === 200
            ? { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ secret: { id: SECRET_ID, name: 'gh', kind: 'text', filename: null, version: 3 }, valueBase64: Buffer.from(VALUE).toString('base64') }) }
            : { type: 'http.response', id: req.id, status: revealStatus, body: JSON.stringify({ error: { code: 'wrong_channel', message: 'x' } }) };
        }
        return { type: 'http.response', id: req.id, status: 204, body: '' };
      },
    });
  });
  const lease = (runnerId = 'r1', agentId = 'a1', cause = 'cause-1') =>
    ts.noteLease(runnerId, agentId, { type: 'secret.lease', cause, leaseId: 'lease-1', token: 'tok-1', expiresAt: new Date(clock + 35 * 60_000).toISOString() });

  it('같은 부름에 새 임대가 오면(다시 주기, 157) 앞 러너의 옛 임대와 마운트 폴더를 버린다', async () => {
    lease('r-old');
    const r = resultOf(await ts.maybeHandle('r-old', 'a1', mountCall('gh')));
    expect(existsSync(join(root, 'lease-1'))).toBe(true);
    expect(r.isError).toBe(false);
    ts.noteLease('r-new', 'a1', { type: 'secret.lease', cause: 'cause-1', leaseId: 'lease-2', token: 'tok-2', expiresAt: new Date(clock + 35 * 60_000).toISOString() });
    // 옛 마운트 폴더는 비동기로 지운다 — 고정 20ms 대기는 느린 CI 에서 흔들렸다. 시한 안에서 지워질 때까지 본다(안 지워지면 실패).
    await vi.waitFor(() => expect(existsSync(join(root, 'lease-1'))).toBe(false), { timeout: 2_000, interval: 10 });
    expect(ts.lookup('r-old', 'cause-1')).toBeNull();
    expect(ts.lookup('r-new', 'cause-1')).toMatchObject({ leaseId: 'lease-2' });
    // 다른 에이전트·다른 부름의 임대는 건드리지 않는다.
    lease('r-x', 'a2', 'cause-1');
    lease('r-y', 'a1', 'cause-2');
    ts.noteLease('r-z', 'a1', { type: 'secret.lease', cause: 'cause-1', leaseId: 'lease-3', token: 'tok-3', expiresAt: new Date(clock + 35 * 60_000).toISOString() });
    expect(ts.lookup('r-x', 'cause-1')).not.toBeNull();
    expect(ts.lookup('r-y', 'cause-2')).not.toBeNull();
  });

  it('secret.mount 가 아닌 요청은 건드리지 않는다', async () => {
    expect(await ts.maybeHandle('r1', 'a1', { type: 'mcp.request', id: 'x', payload: { method: 'tools/call', params: { name: 'message.post' } } })).toBeNull();
    expect(await ts.maybeHandle('r1', 'a1', { type: 'http.forward', id: 'x', method: 'GET', path: '/agent/config' })).toBeNull();
  });

  it('임대가 없으면 no_lease — 서버에 묻지도 않는다(재기동 뒤 fail-closed)', async () => {
    const r = resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh')));
    expect(r).toMatchObject({ id: 7, isError: true, body: { error: { code: 'no_lease' } } });
    expect(calls).toHaveLength(0);
  });

  it('값은 0600 파일로만 — 결과에는 경로뿐이고 값이 없다. 디렉터리는 0700, 파일 이름은 secret id', async () => {
    lease();
    const res = await ts.maybeHandle('r1', 'a1', mountCall('gh'));
    const r = resultOf(res);
    expect(r.isError).toBe(false);
    expect(JSON.stringify(res)).not.toContain(VALUE);
    expect(JSON.stringify(res)).not.toContain(Buffer.from(VALUE).toString('base64'));
    expect(r.body.path).toBe(join(root, 'lease-1', SECRET_ID));
    expect(readFileSync(r.body.path, 'utf8')).toBe(VALUE);
    expect(statSync(r.body.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'lease-1')).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    // 서버에 낸 것은 임대 id·토큰·이름뿐이다.
    expect(calls[0]).toMatchObject({ path: '/agent/secrets/reveal' });
    expect(JSON.parse((calls[0] as { body: string }).body)).toEqual({ leaseId: 'lease-1', token: 'tok-1', name: 'gh' });
  });

  it('P3: 자리에 미리 둔 심링크를 따라가지 않는다 — 대상은 그대로, 값은 새 파일에', async () => {
    lease();
    const target = join(root, '..', 'decoy.txt');
    writeFileSync(target, 'untouched');
    mkdirSync(join(root, 'lease-1'), { recursive: true });
    symlinkSync(target, join(root, 'lease-1', SECRET_ID));
    const r = resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh')));
    expect(r.isError).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
    expect(lstatSync(r.body.path).isSymbolicLink()).toBe(false);
    expect(readFileSync(r.body.path, 'utf8')).toBe(VALUE);
  });

  it('다른 러너·다른 cause·cause 없는 브릿지는 그 임대를 못 쓴다', async () => {
    lease();
    expect(resultOf(await ts.maybeHandle('r2', 'a1', mountCall('gh'))).body.error.code).toBe('no_lease');
    expect(resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh', 'cause-2'))).body.error.code).toBe('no_lease');
    const { cause: _c, ...noCause } = mountCall('gh') as Extract<RunnerLinkRequest, { type: 'mcp.request' }>;
    expect(resultOf(await ts.maybeHandle('r1', 'a1', noCause)).body.error.code).toBe('no_lease');
    expect(resultOf(await ts.maybeHandle('r1', 'a2', mountCall('gh'))).body.error.code).toBe('no_lease');
    expect(calls).toHaveLength(0);
  });

  it('이름이 이름 모양이 아니면 거절(경로 조각 차단)', async () => {
    lease();
    expect(resultOf(await ts.maybeHandle('r1', 'a1', mountCall('../x'))).body.error.code).toBe('bad_request');
  });

  it('서버 거절 코드는 그대로 전한다', async () => {
    lease();
    revealStatus = 403;
    expect(resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh'))).body.error.code).toBe('wrong_channel');
  });

  it('끝나면 임대를 끝내고 디렉터리를 지운다 — 그 뒤 마운트는 no_lease', async () => {
    lease();
    const path = resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh'))).body.path as string;
    await ts.leaseEnded('r1', 'cause-1');
    expect(existsSync(path)).toBe(false);
    const end = calls.find((c) => c.type === 'http.forward' && c.path.endsWith('/end'));
    expect(end).toMatchObject({ path: '/agent/turn-leases/lease-1/end' });
    expect(resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh'))).body.error.code).toBe('no_lease');
  });

  it('만료 쓸기와 기동 쓸기', async () => {
    lease();
    const path = resultOf(await ts.maybeHandle('r1', 'a1', mountCall('gh'))).body.path as string;
    expect(await ts.sweepExpired()).toBe(0);
    clock += 36 * 60_000;
    expect(await ts.sweepExpired()).toBe(1);
    expect(existsSync(path)).toBe(false);
    mkdirSync(join(root, 'orphan'), { recursive: true });
    writeFileSync(join(root, 'orphan', 'x'), 'left by a previous operator');
    expect(await ts.sweepAll()).toBe(1);
    expect(existsSync(join(root, 'orphan'))).toBe(false);
  });

  it('통지 모양 — secret.lease·secret.leaseEnded 만 받는다', () => {
    expect(isRunnerLinkNotice({ type: 'secret.lease', cause: 'c', leaseId: 'l', token: 't', expiresAt: 'e' })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'secret.lease', cause: 'c', leaseId: 'l' })).toBe(false);
    expect(isRunnerLinkNotice({ type: 'secret.leaseEnded', cause: 'c' })).toBe(true);
  });
});

describe('turnSecrets 임대 늘리기(C-1)', () => {
  it('박동을 받으면 쥔 토큰으로 서버에 늘리기를 묻고, 서버가 준 만료 시각을 적는다. 거절·임대 없음·끝난 뒤엔 그대로', async () => {
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const calls: { path: string; body: string }[] = [];
    let renew: { status: number; body: string } = { status: 200, body: JSON.stringify({ expiresAt: '2026-10-01T00:45:00.000Z' }) };
    const ts = createTurnSecrets({
      root: join(mkdtempSync(join(tmpdir(), 'hk-ts-')), 'turn-secrets'), log: () => {}, now: () => clock,
      forward: async (_a, req) => {
        if (req.type !== 'http.forward') throw new Error('unexpected');
        calls.push({ path: req.path, body: req.body ?? '' });
        if (req.path.endsWith('/renew')) return { type: 'http.response', id: req.id, status: renew.status, body: renew.body };
        return { type: 'http.response', id: req.id, status: 204, body: '' };
      },
    });
    // 임대가 없으면 서버에 묻지 않는다.
    await ts.leaseHeartbeat('r1', 'cause-1');
    expect(calls).toHaveLength(0);

    ts.noteLease('r1', 'a1', { type: 'secret.lease', cause: 'cause-1', leaseId: 'lease-1', token: 'tok-1', expiresAt: '2026-10-01T00:35:00.000Z' });
    // 다른 러너의 박동은 이 임대를 늘리지 못한다.
    await ts.leaseHeartbeat('r2', 'cause-1');
    expect(calls).toHaveLength(0);

    await ts.leaseHeartbeat('r1', 'cause-1');
    expect(calls).toEqual([{ path: '/agent/turn-leases/lease-1/renew', body: JSON.stringify({ token: 'tok-1' }) }]);
    // 35분을 넘겨도 서버가 늘려 준 45분까지는 살아 있다.
    clock = Date.parse('2026-10-01T00:40:00Z');
    expect(ts.lookup('r1', 'cause-1')).toMatchObject({ leaseId: 'lease-1' });

    // 서버가 거절(끝남·만료·옛 서버 404)하면 고치지 않는다 — 45분에 끝난다.
    renew = { status: 404, body: '' };
    await ts.leaseHeartbeat('r1', 'cause-1');
    clock = Date.parse('2026-10-01T00:45:00Z');
    expect(ts.lookup('r1', 'cause-1')).toBeNull();
    // 만료된 임대는 서버에 묻지도 않는다.
    const n = calls.length;
    await ts.leaseHeartbeat('r1', 'cause-1');
    expect(calls).toHaveLength(n);
  });

  it('박동 통지는 relay 통지로 읽힌다(cause 가 있어야 한다)', () => {
    expect(isRunnerLinkNotice({ type: 'secret.leaseHeartbeat', cause: 'c1' })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'secret.leaseHeartbeat' })).toBe(false);
    expect(isRunnerLinkNotice({ type: 'secret.leaseHeartbeat', cause: '' })).toBe(false);
  });
});
