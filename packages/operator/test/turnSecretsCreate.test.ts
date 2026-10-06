import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createTurnSecrets, SECRET_IMPORT_MAX_BYTES, type TurnSecrets } from '../src/turnSecrets.js';

// 에이전트가 비밀을 만든다 PR 2 — 오퍼레이터의 secret.generate·import·rotate. 스레드 1a08d0cf(security L1·L3·n3).
const AGENT = '4527ba9a-ac07-4aba-b347-bddd972fb969';
const OTHER = 'fe7719ae-7d8c-412b-9e4d-a5d595a16fb8';
// 실제 토큰 모양의 리터럴을 저장소에 두지 않는다 — 런타임에 조립한다.
const VALUE = `imp_${'k'.repeat(30)}`;
const MOUNT_ID = '11111111-2222-4333-8444-555555555555';

const call = (tool: string, args: Record<string, unknown>, cwd?: string, cause = 'cause-1'): RunnerLinkRequest => ({
  type: 'mcp.request', id: 'link-1', cause, ...(cwd ? { cwd } : {}),
  payload: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: tool, arguments: args } },
});
const resultOf = (res: RunnerLinkResponse | null) => {
  if (!res || res.type !== 'mcp.response') throw new Error('expected mcp.response');
  const msg = res.messages[0] as { id: number; result: { content: { text: string }[]; isError?: boolean } };
  return { isError: msg.result.isError === true, text: msg.result.content[0]!.text, body: JSON.parse(msg.result.content[0]!.text) };
};

describe('turnSecrets — 에이전트가 만든다', () => {
  let base: string;
  let root: string;
  let workspace: string;
  let calls: { path: string; body: Record<string, any> }[];
  let reply: { status: number; body: unknown };
  let ts: TurnSecrets;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hk-tsc-'));
    root = join(base, 'operator', 'turn-secrets');
    workspace = join(base, AGENT, 'workspaces', `harkroom-${AGENT}-1234abcd`);
    mkdirSync(workspace, { recursive: true });
    calls = [];
    reply = { status: 201, body: { secret: { name: 'db', kind: 'text', version: 1, expiresAt: '2027-01-01T00:00:00.000Z' }, publicKey: null } };
    ts = createTurnSecrets({
      root, log: () => {},
      forward: async (_agentId, req) => {
        if (req.type !== 'http.forward') throw new Error('unexpected');
        calls.push({ path: req.path, body: JSON.parse(req.body ?? '{}') });
        if (req.path === '/agent/secrets/reveal') {
          return { type: 'http.response', id: req.id, status: 200, body: JSON.stringify({ secret: { id: MOUNT_ID, name: 'db', kind: 'text', filename: null, version: 1 }, valueBase64: Buffer.from(VALUE).toString('base64') }) };
        }
        return { type: 'http.response', id: req.id, status: reply.status, body: JSON.stringify(reply.body) };
      },
    });
    ts.noteLease('r1', AGENT, { type: 'secret.lease', cause: 'cause-1', leaseId: 'lease-1', token: 'tok-1', expiresAt: new Date(Date.now() + 35 * 60_000).toISOString() });
  });
  const run = (tool: string, args: Record<string, unknown>, cwd: string | undefined = workspace) =>
    ts.maybeHandle('r1', AGENT, call(tool, args, cwd)).then(resultOf);
  const leaseFiles = () => (existsSync(join(root, 'lease-1')) ? readdirSync(join(root, 'lease-1')) : []);

  it('임대가 없으면 no_lease — 서버에 묻지 않는다', async () => {
    const r = resultOf(await ts.maybeHandle('r1', AGENT, call('secret.generate', { name: 'db', type: 'password' }, workspace, 'other-cause')));
    expect(r.body.error.code).toBe('no_lease');
    expect(calls).toHaveLength(0);
  });

  it('generate: 임대를 붙여 /agent/secrets 로 — 결과에는 값이 없다', async () => {
    const r = await run('secret.generate', { name: 'db', type: 'password', length: 40, description: 'staging' });
    expect(r.isError).toBe(false);
    expect(calls).toEqual([{ path: '/agent/secrets', body: { leaseId: 'lease-1', token: 'tok-1', name: 'db', description: 'staging', source: { generate: { type: 'password', length: 40 } } } }]);
    expect(r.body).toMatchObject({ name: 'db', kind: 'text', version: 1 });
    expect(r.body.path).toBeUndefined();
  });

  it('generate mount:true 는 같은 임대로 reveal 해 경로만 준다', async () => {
    const r = await run('secret.generate', { name: 'db', type: 'token_hex', mount: true });
    expect(calls.map((c) => c.path)).toEqual(['/agent/secrets', '/agent/secrets/reveal']);
    expect(r.body.path).toBe(join(root, 'lease-1', MOUNT_ID));
    expect(r.text).not.toContain(VALUE);
  });

  it('import: 워크스페이스 파일을 읽어 보내고, 원본을 지우고, 값을 가리기 자리에 둔다(L3)', async () => {
    writeFileSync(join(workspace, 'tok.txt'), `${VALUE}\n`);
    const r = await run('secret.import', { name: 'db', path: 'tok.txt' });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ name: 'db', sourceDeleted: true });
    expect(r.text).not.toContain(VALUE);
    expect(calls[0]!.body.source).toEqual({ import: { kind: 'text', valueBase64: Buffer.from(`${VALUE}\n`).toString('base64') } });
    expect(existsSync(join(workspace, 'tok.txt'))).toBe(false);
    const files = leaseFiles();
    expect(files).toHaveLength(1);
    expect(readFileSync(join(root, 'lease-1', files[0]!), 'utf8')).toBe(`${VALUE}\n`);
    expect(statSync(join(root, 'lease-1', files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'lease-1')).mode & 0o777).toBe(0o700);
  });

  it('import keepSource:true 면 원본을 남긴다 · 이진 파일은 file 종류와 파일 이름으로', async () => {
    writeFileSync(join(workspace, 'key.bin'), Buffer.from([1, 0, 2, 255]));
    const r = await run('secret.import', { name: 'db', path: 'key.bin', keepSource: true });
    expect(r.body.sourceDeleted).toBe(false);
    expect(existsSync(join(workspace, 'key.bin'))).toBe(true);
    expect(calls[0]!.body.source.import).toMatchObject({ kind: 'file', filename: 'key.bin' });
  });

  it('L1: 워크스페이스 밖·심링크·64KB 넘는 파일·남의 워크스페이스·cwd 없는 브릿지는 읽지 않는다', async () => {
    const outside = join(base, 'outside.txt');
    writeFileSync(outside, VALUE);
    expect((await run('secret.import', { name: 'db', path: outside })).body.error.code).toBe('outside_workspace');
    symlinkSync(outside, join(workspace, 'link.txt'));
    expect((await run('secret.import', { name: 'db', path: 'link.txt' })).body.error.code).toBe('outside_workspace');
    // turn-secrets(오퍼레이터 dataDir)도 워크스페이스 밖이다 — 마운트된 남의 값을 경로로 들여오지 못한다.
    mkdirSync(join(root, 'lease-x'), { recursive: true });
    writeFileSync(join(root, 'lease-x', 'v'), VALUE);
    expect((await run('secret.import', { name: 'db', path: join(root, 'lease-x', 'v') })).body.error.code).toBe('outside_workspace');
    writeFileSync(join(workspace, 'big'), Buffer.alloc(SECRET_IMPORT_MAX_BYTES + 1, 97));
    expect((await run('secret.import', { name: 'db', path: 'big' })).body.error.code).toBe('too_large');
    const theirs = join(base, OTHER, 'workspaces', `harkroom-${OTHER}-1`);
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'f'), VALUE);
    expect((await run('secret.import', { name: 'db', path: 'f' }, theirs)).body.error.code).toBe('no_workspace');
    expect((await ts.maybeHandle('r1', AGENT, call('secret.import', { name: 'db', path: 'f' })).then(resultOf)).body.error.code).toBe('no_workspace');
    expect(calls).toHaveLength(0);
    expect(existsSync(outside)).toBe(true);
  });

  it('n3: 이미 부여받은 값이면(leakGuard 400 secret_in_body) "이미 가진 비밀" 로 안내하고 아무것도 지우지 않는다', async () => {
    writeFileSync(join(workspace, 'tok.txt'), VALUE);
    reply = { status: 400, body: { error: { code: 'secret_in_body', message: 'refused' } } };
    const r = await run('secret.import', { name: 'db', path: 'tok.txt' });
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('already_granted');
    expect(r.body.error.message).toMatch(/already a secret you were granted/);
    expect(existsSync(join(workspace, 'tok.txt'))).toBe(true);
    expect(leaseFiles()).toHaveLength(0);
  });

  it('서버 거절 코드는 그대로 전한다(value_is_mounted·adopted_by_owner…)', async () => {
    reply = { status: 409, body: { error: { code: 'value_is_mounted', message: 'x' } } };
    writeFileSync(join(workspace, 'tok.txt'), VALUE);
    expect((await run('secret.import', { name: 'db', path: 'tok.txt' })).body.error.code).toBe('value_is_mounted');
    reply = { status: 409, body: { error: { code: 'adopted_by_owner', message: 'x' } } };
    expect((await run('secret.rotate', { name: 'db', generate: { type: 'password' } })).body.error.code).toBe('adopted_by_owner');
  });

  it('rotate: generate 와 path 중 하나만 — path 면 import 와 같은 길(원본 지움·가리기 자리)', async () => {
    expect((await run('secret.rotate', { name: 'db' })).body.error.code).toBe('bad_request');
    expect((await run('secret.rotate', { name: 'db', generate: { type: 'password' }, path: 'x' })).body.error.code).toBe('bad_request');
    reply = { status: 200, body: { secret: { name: 'db', kind: 'text', version: 2 }, publicKey: null } };
    writeFileSync(join(workspace, 'new.txt'), VALUE);
    const r = await run('secret.rotate', { name: 'db', path: 'new.txt' });
    expect(r.body).toMatchObject({ name: 'db', version: 2, sourceDeleted: true });
    expect(calls.at(-1)!.path).toBe('/agent/secrets/rotate');
    expect(leaseFiles()).toHaveLength(1);
  });

  it('이름·종류 모양이 아니면 서버에 묻지 않는다', async () => {
    expect((await run('secret.generate', { name: '../x', type: 'password' })).body.error.code).toBe('bad_request');
    expect((await run('secret.generate', { name: 'db', type: 'rsa' })).body.error.code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });
});
