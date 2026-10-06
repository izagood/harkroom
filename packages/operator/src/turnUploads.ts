/**
 * 턴 파일 올리기(미리보기 PR ③) — 하네스의 `attachment.upload{path}` 를 오퍼레이터가 받는다.
 * 설계: harkroom 스레드 31121b84(jaebin 승인 "브릿지 로컬 attachment.upload{path} + message.post.attachmentIds").
 *
 * 왜 경로로 받는가: 스크린샷·PNG 같은 바이너리는 모델이 base64 를 **출력 토큰으로** 써야 인자로 실을 수
 * 있다 — 사실상 못 올린다. 파일은 이미 디스크에 있으니 경로를 받아 오퍼레이터가 읽어 `/uploads` 에 올리고
 * 첨부 id 만 돌려준다. 그 id 를 `message.post.attachmentIds`·`artifact.publish.attachmentId` 에 넣는다.
 *
 * 왜 오퍼레이터인가(브릿지가 아니라): `secret.mount` 와 같은 자리다 — 브릿지는 JSON 을 해석하지 않는다는
 * 원칙을 지키고, 서버로 가는 REST 는 이미 오퍼레이터가 `community.forward` 로 나른다(인증 = 배정).
 *
 * 지키는 것:
 * - **경로는 턴 워크스페이스 아래만.** 기준은 브릿지가 실어 온 `cwd`(하네스가 브릿지를 띄운 자리 —
 *   claude 는 턴 워크스페이스임을 실측했다, 2026-10-02). 경로와 기준을 **둘 다 realpath** 로 풀어 비교한다 —
 *   워크스페이스 안의 심링크가 `~/.ssh` 를 가리켜도 실제 대상이 밖이면 거절한다. `cwd` 가 없으면(옛 브릿지)
 *   올리지 않는다(fail-closed).
 * - 경계(H2, `turnSecrets.ts` 와 같다): 같은 uid 의 셸 가능 에이전트는 이 제한 없이도 파일을 읽는다. 이 제한은
 *   셸 없는 하네스와 **실수·프롬프트 주입으로 엉뚱한 파일을 채팅에 올리는 것**을 막는 난간이다.
 * - 크기는 서버 업로드 한도(기본 25MB)보다 앞에서 자른다 — 다 읽고 거절하면 메모리만 쓴다.
 * - 비밀 누출 검사는 서버 `/uploads` 가 에이전트 업로드에 이미 한다(D5). 여기서 다시 하지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';

export const ATTACHMENT_UPLOAD_TOOL = 'attachment.upload';

/** 서버 기본 업로드 한도와 같다(`ATTACHMENT_MAX_BYTES` 25MB). 서버가 더 작으면 서버가 413 으로 답한다. */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 확장자 → 타입. 서버는 클라이언트 타입을 믿지 않고 내려줄 때 무력화하지만(nosniff·attachment),
 * 화면이 그림·미리보기를 고르는 데 쓰므로 바르게 붙인다. 모르는 것은 octet-stream.
 */
const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  '.log': 'text/plain', '.zip': 'application/zip',
};

export function contentTypeFor(filename: string): string {
  return TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export interface TurnUploadsDeps {
  /** 그 에이전트의 커뮤니티 서버로 REST 를 나른다(`community.forward`). */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  log(line: string): void;
  maxBytes?: number;
}

export interface TurnUploads {
  /** `attachment.upload` 호출이면 답하고, 아니면 null(그대로 서버로 넘긴다). */
  maybeHandle(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function isUploadCall(payload: unknown): payload is JsonRpcCall {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null && p.params.name === ATTACHMENT_UPLOAD_TOOL;
}

function toolResult(id: string | number | undefined, value: unknown, isError: boolean): unknown {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) },
  };
}

/** 업로드 파일명 — 헤더에 들어가므로 따옴표·제어문자·경로 성분을 뺀다(서버 `displayName` 이 한 번 더 좁힌다). */
function safeFilename(raw: string): string {
  const name = basename(raw).replace(/["\\\r\n\x00-\x1f\x7f]/g, '_').trim();
  return name.slice(0, 255) || 'file';
}

function multipart(filename: string, contentType: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----harkroom-upload-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    body: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

type Resolved = { ok: true; path: string } | { ok: false; code: string; message: string };

/**
 * 기준 디렉터리가 **이 에이전트의 턴 워크스페이스**인가 —
 * `<상태 루트>/(<id>|<handle>-<id>)[/<instance>]/workspaces/harkroom-<…>`
 * (`agent/stateDir.ts` 의 `resolveAgentStateDir`·`workspaceBaseDir`, `agent/workspace.ts` 의 `workspaceName`).
 *
 * 왜 보나: 기준은 브릿지가 실어 온 cwd 다. claude 는 턴 워크스페이스임을 실측했지만 못 잰 하네스가 브릿지를
 * 홈 디렉터리 같은 곳에서 띄우면, 이 검사 없이는 **그 아래 전부**가 "안"이 된다. 모양이 아니면 올리지 않는다
 * (fail-closed). 에이전트에 따로 작업 디렉터리를 정해 둔 경우도 여기서 거절된다 — 파일을 턴 워크스페이스로
 * 복사하면 된다.
 *
 * `agentId` 는 브릿지가 실은 값이 아니라 **링크가 인증한 값**이다(security #1052 후속). 그래서 다른 에이전트의
 * 턴 워크스페이스를 cwd 로 대도 거절된다. 상태 뿌리 이름은 지금 모양(`<id>`)과 옛 모양(`<handle>-<id>`, 이미
 * 있으면 그대로 쓴다 — `resolveAgentStateDir` 의 `adopted`) 둘이고, 그 아래 인스턴스 한 단계가 있을 수 있다.
 */
export function isAgentTurnWorkspace(root: string, agentId: string): boolean {
  if (!agentId || !basename(root).startsWith('harkroom-')) return false;
  const base = dirname(root);
  if (basename(base) !== 'workspaces') return false;
  const owns = (name: string) => name === agentId || name.endsWith(`-${agentId}`);
  const stateDir = dirname(base);
  // `<id>/workspaces` 또는 `<id>/<instance>/workspaces`.
  return owns(basename(stateDir)) || owns(basename(dirname(stateDir)));
}

/** `path` 를 `cwd` 아래의 실제 파일로 푼다. 둘 다 realpath 로 — 심링크로 밖을 가리키면 거절한다. */
export async function resolveInsideWorkspace(cwd: string, path: string, agentId: string): Promise<Resolved> {
  let root: string;
  try { root = await realpath(cwd); } catch {
    return { ok: false, code: 'no_workspace', message: 'the turn workspace could not be resolved' };
  }
  if (!isAgentTurnWorkspace(root, agentId)) {
    return { ok: false, code: 'no_workspace', message: 'this harness does not run in your harkroom turn workspace; uploads are disabled here' };
  }
  let target: string;
  try { target = await realpath(isAbsolute(path) ? path : resolve(root, path)); } catch {
    return { ok: false, code: 'not_found', message: `no such file: ${path}` };
  }
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return { ok: false, code: 'outside_workspace', message: 'the file must be inside this turn workspace — copy it there first' };
  }
  return { ok: true, path: target };
}

export type WorkspaceRead = { ok: true; path: string; bytes: Buffer } | { ok: false; code: string; message: string };

/**
 * 턴 워크스페이스 안의 일반 파일 하나를 읽는다 — `attachment.upload` 와 `secret.import`(security L1)가 같이 쓴다.
 * 경로는 `resolveInsideWorkspace` 로 판정하고, 판정한 경로를 **심링크를 따라가지 않고** 연다(O_NOFOLLOW) — realpath 와
 * 열기 사이에 그 자리가 밖을 가리키는 심링크로 바뀌면 열기가 실패한다. 크기·종류도 연 핸들에서 본다(경로를 다시 보지 않는다).
 * 남는 틈: 중간 디렉터리를 바꿔치기하는 것은 막지 못한다 — 같은 uid 경계(H2) 안의 일이다.
 */
export async function readWorkspaceFile(cwd: string, path: string, agentId: string, maxBytes: number): Promise<WorkspaceRead> {
  const resolved = await resolveInsideWorkspace(cwd, path, agentId);
  if (!resolved.ok) return resolved;
  const limit = maxBytes >= 1024 * 1024 ? `${Math.floor(maxBytes / 1024 / 1024)}MB` : `${Math.floor(maxBytes / 1024)}KB`;
  let handle: FileHandle;
  try { handle = await open(resolved.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch {
    return { ok: false, code: 'read_failed', message: `could not open ${path}` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, code: 'not_a_file', message: `not a regular file: ${path}` };
    if (info.size > maxBytes) return { ok: false, code: 'too_large', message: `the file exceeds ${limit}` };
    const bytes = await handle.readFile();
    // 열고 나서 자란 파일 — 한도를 다시 본다.
    if (bytes.length > maxBytes) return { ok: false, code: 'too_large', message: `the file exceeds ${limit}` };
    return { ok: true, path: resolved.path, bytes };
  } catch {
    return { ok: false, code: 'read_failed', message: `could not read ${path}` };
  } finally {
    await handle.close().catch(() => {});
  }
}

export function createTurnUploads(deps: TurnUploadsDeps): TurnUploads {
  const maxBytes = deps.maxBytes ?? UPLOAD_MAX_BYTES;
  return {
    async maybeHandle(agentId, req) {
      if (req.type !== 'mcp.request' || !isUploadCall(req.payload)) return null;
      const call = req.payload;
      const args = (call.params?.arguments ?? {}) as { path?: unknown; filename?: unknown };
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse =>
        ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });
      const fail = (code: string, message: string) => reply({ error: { code, message } }, true);

      if (typeof args.path !== 'string' || !args.path.trim()) return fail('bad_request', 'path is required');
      if (args.filename !== undefined && (typeof args.filename !== 'string' || !args.filename.trim())) {
        return fail('bad_request', 'filename must be a non-empty string');
      }
      // 기준이 없으면 올리지 않는다 — 옛 브릿지는 cwd 를 싣지 않는다.
      if (!req.cwd) return fail('no_workspace', 'this bridge does not report its workspace; update the harkroom app');

      const read = await readWorkspaceFile(req.cwd, args.path, agentId, maxBytes);
      if (!read.ok) return fail(read.code, read.message);
      const bytes = read.bytes;

      const filename = safeFilename(typeof args.filename === 'string' ? args.filename : read.path);
      const contentType = contentTypeFor(filename);
      const form = multipart(filename, contentType, bytes);
      const res = await deps.forward(agentId, {
        type: 'http.forward', id: randomUUID(), method: 'POST', path: '/uploads',
        bodyBase64: form.body.toString('base64'), contentType: form.contentType,
      });
      if (res.type !== 'http.response' || res.status === 0) return fail('unavailable', 'the server could not be reached');
      let body: { id?: string; filename?: string; contentType?: string; sizeBytes?: number; error?: { code?: string; message?: string } } = {};
      try { body = res.body ? JSON.parse(res.body) : {}; } catch { /* 아래에서 오류로 */ }
      if (res.status !== 201 || typeof body.id !== 'string') {
        const code = body.error?.code ?? `http_${res.status}`;
        deps.log(`turn-uploads: 업로드 거절 ${res.status} ${code}`);
        return fail(code, body.error?.message ?? `upload refused (${res.status})`);
      }
      return reply({
        attachmentId: body.id, filename: body.filename, contentType: body.contentType, sizeBytes: body.sizeBytes,
        note: 'Not posted yet. Attach it with message.post { attachmentIds: [id] }, or use it as artifact.publish { attachmentId } for an html page.',
      }, false);
    },
  };
}
