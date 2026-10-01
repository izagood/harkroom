import { describe, it, expect, beforeEach } from 'vitest';
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
