import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { contentTypeFor, createTurnUploads, type TurnUploads } from '../src/turnUploads.js';
import { createForwarder } from '../src/forward.js';

// 미리보기 PR ③ — 오퍼레이터의 attachment.upload{path}. 스레드 31121b84.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const uploadCall = (args: Record<string, unknown>, cwd: string | undefined, id = 9): RunnerLinkRequest => ({
  type: 'mcp.request', id: 'link-1', ...(cwd ? { cwd } : {}),
  payload: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'attachment.upload', arguments: args } },
});
const resultOf = (res: RunnerLinkResponse | null) => {
  if (!res || res.type !== 'mcp.response') throw new Error('expected mcp.response');
  const msg = res.messages[0] as { id: number; result: { content: { text: string }[]; isError?: boolean } };
  return { id: msg.id, isError: msg.result.isError === true, body: JSON.parse(msg.result.content[0]!.text) };
};

describe('turnUploads', () => {
  let base: string;
  let workspace: string;
  let calls: RunnerLinkRequest[];
  let status: number;
  let up: TurnUploads;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hk-up-'));
    // 실제 모양과 같게 — `<상태 디렉터리>/workspaces/harkroom-<agent>-<hash>`.
    workspace = join(base, 'workspaces', 'harkroom-agent1-1234abcd');
    mkdirSync(workspace, { recursive: true });
    calls = [];
    status = 201;
    up = createTurnUploads({
      log: () => {},
      maxBytes: 1024,
      forward: async (_agentId, req) => {
        calls.push(req);
        return {
          type: 'http.response', id: req.id, status,
          body: status === 201
            ? JSON.stringify({ id: 'att-1', filename: 'shot.png', contentType: 'image/png', sizeBytes: PNG.length })
            : JSON.stringify({ error: { code: 'secret_in_body', message: 'refused' } }),
        };
      },
    });
  });

  it('leaves other tools to the server', async () => {
    const req: RunnerLinkRequest = {
      type: 'mcp.request', id: 'x', cwd: workspace,
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message.post', arguments: {} } },
    };
    expect(await up.maybeHandle('agent-1', req)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('uploads a workspace file as multipart through the forward path and returns the attachment id', async () => {
    writeFileSync(join(workspace, 'shot.png'), PNG);
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: 'shot.png' }, workspace)));

    expect(r.isError).toBe(false);
    expect(r.id).toBe(9);
    expect(r.body.attachmentId).toBe('att-1');
    expect(r.body.note).toContain('attachmentIds');
    const sent = calls[0]!;
    if (sent.type !== 'http.forward') throw new Error('expected http.forward');
    expect(sent.path).toBe('/uploads');
    expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const body = Buffer.from(sent.bodyBase64!, 'base64');
    expect(body.includes(PNG)).toBe(true);
    expect(body.toString('latin1')).toContain('filename="shot.png"');
    expect(body.toString('latin1')).toContain('Content-Type: image/png');
  });

  it('accepts an absolute path that is inside the workspace', async () => {
    mkdirSync(join(workspace, 'out'));
    writeFileSync(join(workspace, 'out', 'a.png'), PNG);
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: join(workspace, 'out', 'a.png') }, workspace)));
    expect(r.isError).toBe(false);
  });

  it('refuses a file outside the workspace', async () => {
    writeFileSync(join(base, 'secret.txt'), 'outside');
    for (const path of ['../../secret.txt', join(base, 'secret.txt')]) {
      const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path }, workspace)));
      expect(r.isError).toBe(true);
      expect(r.body.error.code).toBe('outside_workspace');
    }
    expect(calls).toHaveLength(0);
  });

  // 워크스페이스 안의 심링크가 밖을 가리키면 실제 대상으로 판정한다.
  it('refuses a symlink in the workspace that points outside', async () => {
    writeFileSync(join(base, 'id_rsa'), 'key');
    symlinkSync(join(base, 'id_rsa'), join(workspace, 'innocent.png'));
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: 'innocent.png' }, workspace)));
    expect(r.body.error.code).toBe('outside_workspace');
    expect(calls).toHaveLength(0);
  });

  // 기준 디렉터리 이름의 접두만 같은 형제(`…-evil`)는 안이 아니다.
  it('does not treat a sibling directory sharing the prefix as inside', async () => {
    const evil = `${workspace}-evil`;
    mkdirSync(evil);
    writeFileSync(join(evil, 'x.png'), PNG);
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: join(evil, 'x.png') }, workspace)));
    expect(r.body.error.code).toBe('outside_workspace');
  });

  // 못 잰 하네스가 브릿지를 워크스페이스가 아닌 곳(홈 등)에서 띄우면 그 아래 전부가 "안"이 되면 안 된다.
  it('refuses when the bridge runs outside a turn workspace (fail-closed)', async () => {
    writeFileSync(join(base, 'notes.txt'), 'x');
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: 'notes.txt' }, base)));
    expect(r.body.error.code).toBe('no_workspace');
    mkdirSync(join(base, 'repo'));
    writeFileSync(join(base, 'repo', 'a.png'), PNG);
    expect(resultOf(await up.maybeHandle('agent-1', uploadCall({ path: 'a.png' }, join(base, 'repo')))).body.error.code).toBe('no_workspace');
    expect(calls).toHaveLength(0);
  });

  it('refuses when the bridge did not report its workspace (old bridge)', async () => {
    writeFileSync(join(workspace, 'shot.png'), PNG);
    const r = resultOf(await up.maybeHandle('agent-1', uploadCall({ path: 'shot.png' }, undefined)));
    expect(r.body.error.code).toBe('no_workspace');
    expect(calls).toHaveLength(0);
  });

  it('refuses a directory, a missing file, and a file over the limit before reading it', async () => {
    mkdirSync(join(workspace, 'dir'));
    writeFileSync(join(workspace, 'big.bin'), Buffer.alloc(2048));
    expect(resultOf(await up.maybeHandle('a', uploadCall({ path: 'dir' }, workspace))).body.error.code).toBe('not_a_file');
    expect(resultOf(await up.maybeHandle('a', uploadCall({ path: 'nope.png' }, workspace))).body.error.code).toBe('not_found');
    expect(resultOf(await up.maybeHandle('a', uploadCall({ path: 'big.bin' }, workspace))).body.error.code).toBe('too_large');
    expect(resultOf(await up.maybeHandle('a', uploadCall({}, workspace))).body.error.code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  it('passes the server refusal code through (e.g. the secret leak guard)', async () => {
    status = 400;
    writeFileSync(join(workspace, 'notes.txt'), 'x');
    const r = resultOf(await up.maybeHandle('a', uploadCall({ path: 'notes.txt' }, workspace)));
    expect(r.isError).toBe(true);
    expect(r.body.error.code).toBe('secret_in_body');
  });

  it('uses a given filename, stripped of header-breaking characters', async () => {
    writeFileSync(join(workspace, 'tmp1'), PNG);
    await up.maybeHandle('a', uploadCall({ path: 'tmp1', filename: 'before\r\n"x".png' }, workspace));
    const sent = calls[0]!;
    if (sent.type !== 'http.forward') throw new Error('expected http.forward');
    const head = Buffer.from(sent.bodyBase64!, 'base64').toString('latin1');
    expect(head).toContain('filename="before___x_.png"');
    expect(head).toContain('Content-Type: image/png');
  });

  it('maps common extensions to types', () => {
    expect(contentTypeFor('a.HTML')).toBe('text/html');
    expect(contentTypeFor('a.pdf')).toBe('application/pdf');
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream');
  });
});

describe('forward with a binary body', () => {
  it('sends bodyBase64 as the decoded bytes', async () => {
    let seen: Buffer | null = null;
    const f = createForwarder({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = Buffer.from(init.body as Uint8Array);
        return new Response('{}', { status: 201 });
      }) as unknown as typeof fetch,
    });
    await f.forward({ baseUrl: 'https://server.example.com', token: 't', agentId: 'a' }, {
      type: 'http.forward', id: '1', method: 'POST', path: '/uploads', bodyBase64: PNG.toString('base64'), contentType: 'multipart/form-data; boundary=x',
    });
    expect(seen!.equals(PNG)).toBe(true);
  });
});

