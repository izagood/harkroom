/**
 * 턴 비밀 마운트(비밀 보관소 PR 3) — 하네스의 `secret.mount` 도구를 오퍼레이터가 받는다.
 * 계획·보안 검토: harkroom 스레드 bc98df3a.
 *
 * 흐름:
 *   러너가 멘션을 집으며 턴 임대를 받는다(`POST /agent/turn-leases`) → relay 소켓으로
 *   `secret.lease{cause, leaseId, token}` 를 맡긴다 → 하네스가 `secret.mount(name)` 을 부르면 브릿지의
 *   `mcp.request` 가 여기로 온다 → 오퍼레이터가 임대로 `POST /agent/secrets/reveal` 을 부르고 값을
 *   `<dataDir>/turn-secrets/<leaseId>/<secretId>`(디렉터리 0700, 파일 0600)에 쓴 뒤 **경로만** 돌려준다.
 *
 * 지키는 것:
 * - **값은 MCP 결과에 싣지 않는다.** MCP 결과는 모델 문맥·transcript·제공사로 간다. 이 모듈이 서버에서
 *   받은 값은 파일로만 나간다.
 * - **토큰은 이 프로세스 메모리에만 있다**(R2). 하네스 env 에도, 디스크에도 쓰지 않는다.
 * - **임대는 러너가 맡긴 것만 쓴다.** 브릿지는 임대를 맡길 수 없다(통지는 relay 소켓만 받는다). 브릿지
 *   요청의 cause 로 임대를 찾고, 없으면 거절한다 — 재기동한 러너는 임대를 못 받으므로(서버 409) 비밀 없이
 *   돈다(R1 fail-closed).
 * - **마운트 루트는 워크스페이스 밖**(오퍼레이터 데이터 디렉터리)이고, 파일 이름은 secret id 다 — 이름에서
 *   경로를 짓지 않는다(M5).
 * - 끝나면 지운다: 러너가 `secret.leaseEnded` 를 보내면 임대를 끝내고 디렉터리를 지운다. 러너가 죽거나
 *   통지를 못 보낸 경우는 만료 쓸기(1분 주기, 임대 TTL 35분)가, 오퍼레이터가 바뀐 경우는 기동 쓸기가 치운다.
 *   relay 소켓이 끊길 때 지우지 않는 이유: 러너는 다시 붙는다 — 그 사이 도는 턴의 파일을 빼앗지 않는다.
 *
 * 에이전트가 비밀을 만든다(서버 102, 스레드 1a08d0cf): `secret.generate`·`secret.import`·`secret.rotate` 도 여기서 받아 같은 임대로
 * `POST /agent/secrets`·`/agent/secrets/rotate` 를 부른다. **판정은 전부 서버다(security F1)** — 같은 uid 셸은 이 REST 를 직접
 * 부를 수 있으므로 여기의 검사는 난간이다. import 는 `turnUploads` 의 `readWorkspaceFile`(워크스페이스 판정·O_NOFOLLOW·크기)을
 * 그대로 쓰고(L1), 성공하면 원본을 지우고 값을 그 임대의 디렉터리에 써 둔다 — 러너의 D7 가리기가 그 값을 바늘로 쓴다(L3).
 *
 * 경계(H2): 같은 오퍼레이터의 셸 가능 에이전트끼리는 이 디렉터리·이 소켓을 서로 막지 못한다. grant 의
 * 경계는 오퍼레이터다. **같은 에이전트의 동시 턴 사이도 경계가 아니다**(security P1): 공개 채널 턴의 셸이
 * 진행 중인 비공개 채널 턴의 cause 를 넣은 브릿지를 직접 띄우면 그 턴의 임대로 마운트할 수 있고, 이미
 * 마운트된 파일은 같은 uid 라 그냥 읽힌다. OS 격리 없이는 막지 못한다 — access_log 에 그 임대의 채널이
 * 찍히므로 사후 추적만 된다.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse, SecretLeaseNotice } from '@harkroom/shared/runnerLink';
import { readWorkspaceFile } from './turnUploads.js';

export const SECRET_MOUNT_TOOL = 'secret.mount';
/** 에이전트가 비밀을 만든다(서버 102 · 스레드 1a08d0cf). 판정은 서버가 한다(security F1) — 여기는 값을 나르고 난간을 친다. */
export const SECRET_GENERATE_TOOL = 'secret.generate';
export const SECRET_IMPORT_TOOL = 'secret.import';
export const SECRET_ROTATE_TOOL = 'secret.rotate';
const TOOLS = new Set([SECRET_MOUNT_TOOL, SECRET_GENERATE_TOOL, SECRET_IMPORT_TOOL, SECRET_ROTATE_TOOL]);
/** 서버 D6 와 같다. 넘는 파일은 읽기 전에 거절한다. */
export const SECRET_IMPORT_MAX_BYTES = 64 * 1024;
const GENERATE_TYPES = new Set(['password', 'token_hex', 'token_base64url', 'ssh_ed25519']);
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface Lease {
  runnerId: string;
  agentId: string;
  cause: string;
  leaseId: string;
  token: string;
  expiresAtMs: number;
}

export interface TurnSecretsDeps {
  /** `<dataDir>/turn-secrets`. */
  root: string;
  /** 그 에이전트의 커뮤니티 서버로 REST 를 나른다(`community.forward`). */
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  log(line: string): void;
  now?: () => number;
}

export interface TurnSecrets {
  noteLease(runnerId: string, agentId: string, notice: SecretLeaseNotice): void;
  leaseEnded(runnerId: string, cause: string): Promise<void>;
  /** `secret.mount`·`generate`·`import`·`rotate` 호출이면 답하고, 아니면 null(그대로 서버로 넘긴다). */
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
  /**
   * 살아 있는 임대를 돌려준다(`turnMerge` 가 머지 판정에 같은 임대를 쓴다). 토큰이 그대로 나가지만 받는
   * 쪽도 이 프로세스 안이다 — 하네스로는 여전히 안 나간다.
   */
  lookup(runnerId: string, cause: string): { leaseId: string; token: string; agentId: string } | null;
  /** 만료된 임대의 디렉터리를 지운다. 주기적으로 부른다. */
  sweepExpired(): Promise<number>;
  /** 기동 때 한 번 — 앞 오퍼레이터가 남긴 디렉터리를 전부 지운다(그 임대는 이 프로세스가 모른다). */
  sweepAll(): Promise<number>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function secretToolOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as JsonRpcCall;
  if (p.method !== 'tools/call' || typeof p.params !== 'object' || p.params === null) return null;
  return typeof p.params.name === 'string' && TOOLS.has(p.params.name) ? p.params.name : null;
}

/** 텍스트로 볼 수 있는 값인가 — 올바른 UTF-8 이고 NUL 이 없다. 아니면 파일 비밀로 등록한다. */
function looksText(b: Buffer): boolean {
  return !b.includes(0) && Buffer.from(b.toString('utf8'), 'utf8').equals(b);
}

/** 서버 FILENAME 과 같은 모양으로 — 경로 성분·제어문자를 뺀다. */
function secretFilename(path: string): string {
  const n = basename(path).replace(/[\x00-\x1f\x7f\\]/g, '_').slice(0, 255);
  return n && n !== '.' && n !== '..' ? n : 'file';
}

type Args = Record<string, unknown>;
type Outcome = { ok: true; value: unknown } | { ok: false; value: unknown };
const refuse = (code: string, message: string): Outcome => ({ ok: false, value: { error: { code, message } } });

/** 도구 결과 하나(JSON 텍스트). 하네스는 이것을 여느 harkroom 도구 결과처럼 읽는다. */
function toolResult(id: string | number | undefined, value: unknown, isError: boolean): unknown {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) },
  };
}

export function createTurnSecrets(deps: TurnSecretsDeps): TurnSecrets {
  const now = deps.now ?? Date.now;
  /** `runnerId|cause` → 임대. 다른 러너의 브릿지는 이 임대를 못 쓴다. */
  const leases = new Map<string, Lease>();
  const keyOf = (runnerId: string, cause: string) => `${runnerId}|${cause}`;
  const dirOf = (leaseId: string) => join(deps.root, leaseId);

  const drop = async (lease: Lease, end: boolean): Promise<void> => {
    leases.delete(keyOf(lease.runnerId, lease.cause));
    await rm(dirOf(lease.leaseId), { recursive: true, force: true }).catch((e: unknown) => {
      deps.log(`turn-secrets: ${lease.leaseId} 디렉터리를 지우지 못했다 — ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!end) return;
    const res = await deps.forward(lease.agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST',
      path: `/agent/turn-leases/${encodeURIComponent(lease.leaseId)}/end`,
      body: JSON.stringify({ token: lease.token }), contentType: 'application/json',
    }).catch(() => null);
    // 끝내기가 실패해도 임대는 35분 뒤 스스로 만료된다 — 값은 이미 지웠다.
    if (res && res.type === 'http.response' && res.status !== 204 && res.status !== 404) {
      deps.log(`turn-secrets: 임대 ${lease.leaseId} 끝내기 응답 ${res.status}`);
    }
  };

  const mount = async (lease: Lease, name: string): Promise<{ ok: true; value: unknown } | { ok: false; value: unknown }> => {
    const res = await deps.forward(lease.agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/secrets/reveal',
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, name }), contentType: 'application/json',
    });
    if (res.type !== 'http.response') return { ok: false, value: { error: { code: 'unavailable', message: 'the server could not be reached' } } };
    let body: { secret?: { id: string; name: string; kind: 'text' | 'file'; filename: string | null; version: number }; valueBase64?: string; error?: { code?: string } } = {};
    try { body = res.body ? JSON.parse(res.body) : {}; } catch { /* 아래에서 오류로 */ }
    if (res.status !== 200 || !body.secret || typeof body.valueBase64 !== 'string') {
      // 서버의 거절 코드는 비밀이 아니다 — 무엇이 빠졌는지 에이전트가 사람에게 말할 수 있어야 한다.
      const code = body.error?.code ?? (res.status === 0 ? 'unavailable' : `http_${res.status}`);
      return { ok: false, value: { error: { code, message: `secret not mounted: ${code}` } } };
    }
    const dir = dirOf(lease.leaseId);
    // 루트도 0700 으로 박는다(P4) — recursive mkdir 의 mode 는 umask 를 탄다.
    await mkdir(deps.root, { recursive: true, mode: 0o700 });
    await chmod(deps.root, 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    // 파일 이름은 secret id 다 — 사람이 정한 이름·파일 이름으로 경로를 짓지 않는다(M5).
    const path = join(dir, body.secret.id);
    // **심링크를 따라가지 않는다**(P3). 같은 uid 셸이 이 자리에 심링크를 미리 두면 값이 그 대상(저장소 안
    // 파일 등)에 써져 실수로 커밋되는 길이 생긴다. 먼저 지우고(심링크면 링크만 지워진다) `wx` 로 새로 만든다 —
    // 그 사이에 다시 무언가가 생기면 EEXIST 로 실패한다(쓰지 않는 쪽이 맞다).
    await rm(path, { force: true });
    await writeFile(path, Buffer.from(body.valueBase64, 'base64'), { mode: 0o600, flag: 'wx' });
    await chmod(path, 0o600);
    body.valueBase64 = '';
    return {
      ok: true,
      value: {
        path,
        name: body.secret.name,
        kind: body.secret.kind,
        ...(body.secret.filename ? { filename: body.secret.filename } : {}),
        version: body.secret.version,
        note: 'The value is in this file only for this turn. Use it by path (e.g. `curl -H @file`, `$(<file)`); never print, echo, or copy its contents into messages, memory, files, or commits.',
      },
    };
  };

  /**
   * 서버 REST 를 임대와 함께 부른다. 거절 코드는 비밀이 아니다 — 그대로 전한다. 다만 leakGuard 의 `secret_in_body`(400)는
   * 들여오려는 값이 **이미 부여받은 비밀의 값**이라는 뜻이다(security n3) — 그 말로 바꿔 안내한다.
   */
  const post = async (lease: Lease, path: string, body: Args, importing: boolean): Promise<{ ok: true; json: Args } | { ok: false; out: Outcome }> => {
    const res = await deps.forward(lease.agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path,
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, ...body }), contentType: 'application/json',
    });
    if (res.type !== 'http.response' || res.status === 0) return { ok: false, out: refuse('unavailable', 'the server could not be reached') };
    let json: Args & { error?: { code?: string } } = {};
    try { json = res.body ? JSON.parse(res.body) : {}; } catch { /* 아래에서 오류로 */ }
    if (res.status === 200 || res.status === 201) return { ok: true, json };
    const code = json.error?.code ?? `http_${res.status}`;
    if (code === 'secret_in_body') {
      // 경로마다 문구를 가른다(security n5): 파일을 들여올 때는 그 값이 이미 가진 비밀이다. 아니면(generate) 설명에 값이 섞였다.
      return importing
        ? { ok: false, out: refuse('already_granted', 'this value is already a secret you were granted — use that secret by name (secret.list / secret.mount) instead of importing it. Delete the file; do not print it.') }
        : { ok: false, out: refuse('secret_in_body', 'the description contains the value of a secret you were granted — describe the secret without its value.') };
    }
    if (code === 'operator_required' || res.status === 404) {
      return { ok: false, out: refuse('unsupported', 'the harkroom server does not support agent-created secrets yet') };
    }
    return { ok: false, out: refuse(code, `secret not ${path.endsWith('/rotate') ? 'rotated' : 'created'}: ${code}`) };
  };

  /**
   * 들여온 값을 그 임대의 turn-secrets 자리에 마운트한 것처럼 써 둔다(security L3). 러너는 턴이 끝날 때 이 디렉터리의 값으로
   * 기록을 가린다(D7, `secretLeases.needles`) — 등록 전에 도구 출력으로 찍혔던 값도 함께 가려진다. 새 통지는 만들지 않는다.
   * 파일 이름은 이름에서 짓지 않는다(M5).
   */
  const remember = async (lease: Lease, value: Buffer): Promise<void> => {
    const dir = dirOf(lease.leaseId);
    await mkdir(deps.root, { recursive: true, mode: 0o700 });
    await chmod(deps.root, 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await writeFile(join(dir, `import-${randomUUID()}`), value, { mode: 0o600, flag: 'wx' });
  };

  /** `path` 를 읽어 import source 로. 워크스페이스 판정·심링크·64KB 는 `readWorkspaceFile`(L1, turnUploads 와 같은 길). */
  const readSource = async (cwd: string | undefined, agentId: string, path: unknown, kind: unknown):
    Promise<{ ok: true; path: string; value: Buffer; source: Args } | { ok: false; out: Outcome }> => {
    if (typeof path !== 'string' || !path.trim()) return { ok: false, out: refuse('bad_request', 'path is required') };
    if (kind !== undefined && kind !== 'text' && kind !== 'file') return { ok: false, out: refuse('bad_request', "kind must be 'text' or 'file'") };
    // 기준이 없으면 읽지 않는다 — 옛 브릿지는 cwd 를 싣지 않는다(fail-closed).
    if (!cwd) return { ok: false, out: refuse('no_workspace', 'this bridge does not report its workspace; update the harkroom app') };
    const read = await readWorkspaceFile(cwd, path, agentId, SECRET_IMPORT_MAX_BYTES);
    if (!read.ok) return { ok: false, out: refuse(read.code, read.message) };
    if (!read.bytes.length) return { ok: false, out: refuse('empty', 'the file is empty') };
    const k = kind ?? (looksText(read.bytes) ? 'text' : 'file');
    if (k === 'text' && !looksText(read.bytes)) return { ok: false, out: refuse('bad_request', "the file is not UTF-8 text; use kind 'file'") };
    return {
      ok: true, path: read.path, value: read.bytes,
      source: { import: { kind: k, ...(k === 'file' ? { filename: secretFilename(read.path) } : {}), valueBase64: read.bytes.toString('base64') } },
    };
  };

  /** 성공한 import 뒤: 가리기 자리에 기록하고(L3) 원본을 지운다 — 워크스페이스는 아무도 지우지 않는다. */
  const settleImport = async (lease: Lease, src: { path: string; value: Buffer }, keep: boolean): Promise<{ sourceDeleted: boolean }> => {
    await remember(lease, src.value).catch((e: unknown) => deps.log(`turn-secrets: 가리기 자리 기록 실패 — ${e instanceof Error ? e.message : String(e)}`));
    src.value.fill(0);
    if (keep) return { sourceDeleted: false };
    try { await rm(src.path, { force: true }); return { sourceDeleted: true }; } catch { return { sourceDeleted: false }; }
  };

  const NOTE = 'The value was never shown to you and must stay that way: use it only by path via secret.mount; never print, echo, or copy it into messages, memory, files, or commits.';

  const generate = async (lease: Lease, a: Args): Promise<Outcome> => {
    if (typeof a.type !== 'string' || !GENERATE_TYPES.has(a.type)) return refuse('bad_request', 'type must be one of password, token_hex, token_base64url, ssh_ed25519');
    if (a.mount !== undefined && typeof a.mount !== 'boolean') return refuse('bad_request', 'mount must be a boolean');
    const r = await post(lease, '/agent/secrets', {
      name: a.name, ...(typeof a.description === 'string' ? { description: a.description } : {}),
      ...(a.expiresInDays !== undefined ? { expiresInDays: a.expiresInDays } : {}),
      source: { generate: { type: a.type, ...(a.length !== undefined ? { length: a.length } : {}) } },
    }, false);
    if (!r.ok) return r.out;
    const secret = r.json.secret as { name: string; kind: string; version: number; expiresAt: string | null };
    const out: Args = { name: secret.name, kind: secret.kind, version: secret.version, expiresAt: secret.expiresAt, ...(r.json.publicKey ? { publicKey: r.json.publicKey } : {}) };
    if (a.mount === true) {
      const m = await mount(lease, secret.name);
      if (m.ok) out.path = (m.value as { path: string }).path;
      else out.mountError = (m.value as { error: unknown }).error;
    }
    return { ok: true, value: { ...out, note: NOTE } };
  };

  const importValue = async (lease: Lease, a: Args, cwd: string | undefined): Promise<Outcome> => {
    if (a.keepSource !== undefined && typeof a.keepSource !== 'boolean') return refuse('bad_request', 'keepSource must be a boolean');
    const src = await readSource(cwd, lease.agentId, a.path, a.kind);
    if (!src.ok) return src.out;
    const r = await post(lease, '/agent/secrets', {
      name: a.name, ...(typeof a.description === 'string' ? { description: a.description } : {}),
      ...(a.expiresInDays !== undefined ? { expiresInDays: a.expiresInDays } : {}),
      source: src.source,
    }, true);
    if (!r.ok) { src.value.fill(0); return r.out; }
    const secret = r.json.secret as { name: string; kind: string; version: number; expiresAt: string | null };
    const settled = await settleImport(lease, src, a.keepSource === true);
    // 원본을 남겼으면 평문 파일이 워크스페이스에 있다(security n6) — 다 쓰면 지우라고 같이 말한다.
    const note = settled.sourceDeleted ? NOTE : `${NOTE} The source file is still in the workspace (keepSource): delete it as soon as you are done and never commit it.`;
    return { ok: true, value: { name: secret.name, kind: secret.kind, version: secret.version, expiresAt: secret.expiresAt, ...settled, note } };
  };

  const rotateValue = async (lease: Lease, a: Args, cwd: string | undefined): Promise<Outcome> => {
    const hasGen = a.generate !== undefined;
    const hasPath = a.path !== undefined;
    if (hasGen === hasPath) return refuse('bad_request', 'give exactly one of generate:{type,length?} or path');
    if (hasGen) {
      const g = a.generate as Args | null;
      if (!g || typeof g !== 'object' || typeof g.type !== 'string' || !GENERATE_TYPES.has(g.type)) {
        return refuse('bad_request', 'generate.type must be one of password, token_hex, token_base64url, ssh_ed25519');
      }
      const r = await post(lease, '/agent/secrets/rotate', { name: a.name, source: { generate: { type: g.type, ...(g.length !== undefined ? { length: g.length } : {}) } } }, false);
      if (!r.ok) return r.out;
      const secret = r.json.secret as { name: string; version: number };
      return { ok: true, value: { name: secret.name, version: secret.version, ...(r.json.publicKey ? { publicKey: r.json.publicKey } : {}), note: NOTE } };
    }
    const src = await readSource(cwd, lease.agentId, a.path, undefined);
    if (!src.ok) return src.out;
    const r = await post(lease, '/agent/secrets/rotate', { name: a.name, source: src.source }, true);
    if (!r.ok) { src.value.fill(0); return r.out; }
    const secret = r.json.secret as { name: string; version: number };
    const settled = await settleImport(lease, src, false);
    return { ok: true, value: { name: secret.name, version: secret.version, ...settled, note: NOTE } };
  };

  return {
    noteLease(runnerId, agentId, notice) {
      const expiresAtMs = Date.parse(notice.expiresAt);
      if (!Number.isFinite(expiresAtMs)) return;
      leases.set(keyOf(runnerId, notice.cause), {
        runnerId, agentId, cause: notice.cause, leaseId: notice.leaseId, token: notice.token, expiresAtMs,
      });
    },

    lookup(runnerId, cause) {
      const lease = leases.get(keyOf(runnerId, cause));
      if (!lease || lease.expiresAtMs <= now()) return null;
      return { leaseId: lease.leaseId, token: lease.token, agentId: lease.agentId };
    },

    async leaseEnded(runnerId, cause) {
      const lease = leases.get(keyOf(runnerId, cause));
      if (lease) await drop(lease, true);
    },

    async maybeHandle(runnerId, agentId, req) {
      const tool = req.type === 'mcp.request' ? secretToolOf(req.payload) : null;
      if (req.type !== 'mcp.request' || !tool) return null;
      const call = req.payload as JsonRpcCall;
      const args = (typeof call.params?.arguments === 'object' && call.params.arguments !== null ? call.params.arguments : {}) as Args;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse =>
        ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });
      if (typeof args.name !== 'string' || !NAME.test(args.name)) {
        return reply({ error: { code: 'bad_request', message: tool === SECRET_MOUNT_TOOL ? 'name must be a secret name from secret.list' : 'name must match [a-z0-9][a-z0-9_-]{0,63}' } }, true);
      }
      const lease = req.cause ? leases.get(keyOf(runnerId, req.cause)) : undefined;
      if (!lease || lease.agentId !== agentId || lease.expiresAtMs <= now()) {
        return reply({ error: { code: 'no_lease', message: 'secrets are not available in this turn' } }, true);
      }
      try {
        const r = tool === SECRET_MOUNT_TOOL ? await mount(lease, args.name)
          : tool === SECRET_GENERATE_TOOL ? await generate(lease, args)
          : tool === SECRET_IMPORT_TOOL ? await importValue(lease, args, req.cwd)
          : await rotateValue(lease, args, req.cwd);
        return reply(r.value, !r.ok);
      } catch (e) {
        deps.log(`turn-secrets: ${tool} 실패 — ${e instanceof Error ? e.message : String(e)}`);
        return tool === SECRET_MOUNT_TOOL
          ? reply({ error: { code: 'mount_failed', message: 'the secret could not be written to the turn directory' } }, true)
          : reply({ error: { code: 'failed', message: `${tool} failed in the operator` } }, true);
      }
    },

    async sweepExpired() {
      let n = 0;
      for (const lease of [...leases.values()]) {
        if (lease.expiresAtMs <= now()) { await drop(lease, false); n++; }
      }
      return n;
    },

    async sweepAll() {
      leases.clear();
      const names = await readdir(deps.root).catch(() => [] as string[]);
      for (const n of names) await rm(join(deps.root, n), { recursive: true, force: true }).catch(() => {});
      return names.length;
    },
  };
}
