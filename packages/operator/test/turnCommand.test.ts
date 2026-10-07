import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { createForwarder } from '../src/forward.js';
import { COMMAND_CHECK_TOOL, createTurnCommand, measureCommandFiles, stripLinkOnlyFields } from '../src/turnCommand.js';

// H③b(스레드 8769dbf7, security C2·사전 2): 오퍼레이터만 파일을 재고, 링크에서 온 해시 칸은 믿지 않는다.
const tmp = async () => realpath(await mkdtemp(join(tmpdir(), 'cmdf-')));
const call = (name: string, args: Record<string, unknown>, extra: Partial<RunnerLinkRequest & { type: 'mcp.request' }> = {}): RunnerLinkRequest =>
  ({ type: 'mcp.request', id: 'r1', cause: 'cause-1', payload: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, ...extra });

describe('measureCommandFiles (C2)', () => {
  it('일반 파일만 잰다 — 링크 파일·중간 디렉터리 링크·디렉터리·없는 파일·1MiB 초과는 거절', async () => {
    const d = await tmp();
    await writeFile(join(d, 'p.json'), '{"spec":{}}');
    await symlink(join(d, 'p.json'), join(d, 'link.json'));
    await mkdir(join(d, 'real'));
    await writeFile(join(d, 'real', 'x.yaml'), 'a: 1');
    await symlink(join(d, 'real'), join(d, 'linkdir'));
    await writeFile(join(d, 'big'), Buffer.alloc(1024 * 1024 + 1));
    const f = (path: string, secret = false) => ({ path, flag: '--patch-file', secret });
    const ok = await measureCommandFiles([f(join(d, 'p.json')), f(join(d, 'real', 'x.yaml'), true)], true);
    expect(ok).toMatchObject({ ok: true, digests: [
      { path: join(d, 'p.json'), size: 11, preview: '{"spec":{}}' },
      { path: join(d, 'real', 'x.yaml'), size: 4 },
    ] });
    expect(ok.ok && ok.digests[1]).not.toHaveProperty('preview');
    expect(ok.ok && ok.digests[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await measureCommandFiles([f(join(d, 'link.json'))], true)).toMatchObject({ ok: false, code: 'file_link' });
    expect(await measureCommandFiles([f(join(d, 'linkdir', 'x.yaml'))], true)).toMatchObject({ ok: false, code: 'file_link' });
    expect(await measureCommandFiles([f(join(d, 'real'))], true)).toMatchObject({ ok: false, code: 'file_not_regular' });
    expect(await measureCommandFiles([f(join(d, 'nope'))], true)).toMatchObject({ ok: false, code: 'file_missing' });
    expect(await measureCommandFiles([f(join(d, 'big'))], true)).toMatchObject({ ok: false, code: 'file_too_large' });
  });
});

describe('turnCommand', () => {
  const lease = { leaseId: 'L1', token: 'T1', agentId: 'agent-1' };

  it('사전 2: 링크에서 온 commandFiles 는 지워지고, 서버에 가는 헤더는 오퍼레이터가 잰 값뿐이다', async () => {
    const d = await tmp();
    const pf = join(d, 'p.json');
    await writeFile(pf, '{"real":1}');
    const cmd = `kubectl --kubeconfig ${pf} --context rc apply -f ${pf}`;
    const sent: { headers: Record<string, string> }[] = [];
    const forwarder = createForwarder({ fetchImpl: (async (_url: string, init: { headers: Record<string, string> }) => {
      sent.push({ headers: init.headers });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch });
    const tc = createTurnCommand({ forward: (_a, req) => forwarder.forward({ baseUrl: 'http://s', token: 't', agentId: 'agent-1' }, req), lookupLease: () => lease, log: () => {} });
    const forged = Buffer.from(JSON.stringify([{ path: pf, sha256: 'f'.repeat(64), size: 1 }])).toString('base64');
    const req = stripLinkOnlyFields(call('permission.request', { kind: 'command', command: cmd, channelId: 'c', threadRootId: 't', reason: 'r' }, { commandFiles: forged }));
    expect('commandFiles' in req).toBe(false);
    await tc.maybeHandle('runner-1', 'agent-1', req);
    const header = sent[0]!.headers['x-harkroom-command-files']!;
    const digests = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(digests).toHaveLength(1);
    expect(digests[0].sha256).not.toBe('f'.repeat(64));
    expect(digests[0]).toMatchObject({ path: pf, size: 10 });
    expect(digests[0]).not.toHaveProperty('preview'); // --kubeconfig 자리(secret)가 먼저 나와 같은 파일 하나 — 비밀 자리는 미리 보기 없음
  });

  it('파일을 못 재면 서버로 넘기지 않고 거절을 돌려준다 · 판정에 걸리는 명령은 재지 않고 헤더 없이 넘긴다(서버가 거절 코드로 답한다)', async () => {
    const forwarded: RunnerLinkRequest[] = [];
    const tc = createTurnCommand({ forward: async (_a, req) => { forwarded.push(req); return { type: 'mcp.response', id: req.id, messages: [] }; }, lookupLease: () => lease, log: () => {} });
    const bad = await tc.maybeHandle('r', 'agent-1', call('permission.request', { kind: 'command', command: 'kubectl --kubeconfig /nope/k --context rc get pods' }));
    expect(JSON.stringify(bad)).toContain('file_missing');
    expect(forwarded).toHaveLength(0);
    await tc.maybeHandle('r', 'agent-1', call('permission.request', { kind: 'command', command: 'ls -la /tmp' }));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).not.toHaveProperty('commandFiles');
    // 다른 도구·kind 는 건드리지 않는다.
    expect(await tc.maybeHandle('r', 'agent-1', call('permission.request', { kind: 'tool', rule: 'Bash(a b:*)' }))).toBeNull();
    expect(await tc.maybeHandle('r', 'agent-1', call('message.post', {}))).toBeNull();
  });

  it('command.check: 오퍼레이터가 쥔 임대·지금 잰 해시·cwd 로 match 를 부르고 {allow} 만 돌려준다', async () => {
    const d = await tmp();
    const k = join(d, 'k');
    await writeFile(k, 'kubeconfig');
    const bodies: unknown[] = [];
    const reply = { allow: true, grantId: 'g1', singleUse: true };
    const tc = createTurnCommand({
      forward: async (_a, req) => {
        if (req.type === 'http.forward') { bodies.push(JSON.parse(req.body!)); return { type: 'http.response', id: req.id, status: 200, body: JSON.stringify(reply) }; }
        return { type: 'mcp.response', id: req.id, messages: [] };
      },
      lookupLease: (_r, cause) => (cause === 'cause-1' ? lease : null), log: () => {},
    });
    const res = (await tc.maybeHandle('r', 'agent-1', call(COMMAND_CHECK_TOOL, { command: `kubectl --kubeconfig ${k} --context rc get pods`, cwd: '/srv/ws', toolUseId: 'tu', leaseId: 'FORGED', token: 'FORGED' }), 'hook'))!;
    expect(JSON.stringify(res)).toContain('\\"allow\\":true');
    expect(bodies[0]).toMatchObject({ leaseId: 'L1', token: 'T1', cwd: '/srv/ws', toolUseId: 'tu', files: [{ path: k }] });
    // 임대 없음·남의 에이전트·셸 문법이면 서버에 묻지도 않는다.
    const no = await tc.maybeHandle('r', 'agent-1', call(COMMAND_CHECK_TOOL, { command: `kubectl --kubeconfig ${k} --context rc get pods` }, { cause: 'other' }), 'hook');
    expect(JSON.stringify(no)).toContain('\\"allow\\":false');
    const shell = await tc.maybeHandle('r', 'agent-1', call(COMMAND_CHECK_TOOL, { command: 'ls /tmp; rm -rf /' }), 'hook');
    // 브릿지(에이전트 MCP)에서 온 command.check 는 서버에 묻지 않고 거절한다 — 1회 grant 를 미리 쓰지 못하게.
    const viaBridge = await tc.maybeHandle('r', 'agent-1', call(COMMAND_CHECK_TOOL, { command: `kubectl --kubeconfig ${k} --context rc get pods` }), 'bridge');
    expect(JSON.stringify(viaBridge)).toContain('hook_only');
    // hook 소켓은 command.check 말고는 아무것도 못 한다.
    expect(await tc.maybeHandle('r', 'agent-1', call('message.post', { body: 'x' }), 'hook')).toMatchObject({ type: 'mcp.error', status: 403 });
    expect(await tc.maybeHandle('r', 'agent-1', { type: 'http.forward', id: 'h', method: 'GET', path: '/agent/config' }, 'hook')).toMatchObject({ type: 'http.response', status: 403 });
    expect(JSON.stringify(shell)).toContain('\\"allow\\":false');
    expect(bodies).toHaveLength(1);
  });
});
