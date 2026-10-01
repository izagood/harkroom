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
 * 경계(H2): 같은 오퍼레이터의 셸 가능 에이전트끼리는 이 디렉터리·이 소켓을 서로 막지 못한다. grant 의
 * 경계는 오퍼레이터다.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse, SecretLeaseNotice } from '@harkroom/shared/runnerLink';

export const SECRET_MOUNT_TOOL = 'secret.mount';

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
  /** `secret.mount` 호출이면 답하고, 아니면 null(그대로 서버로 넘긴다). */
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
  /** 만료된 임대의 디렉터리를 지운다. 주기적으로 부른다. */
  sweepExpired(): Promise<number>;
  /** 기동 때 한 번 — 앞 오퍼레이터가 남긴 디렉터리를 전부 지운다(그 임대는 이 프로세스가 모른다). */
  sweepAll(): Promise<number>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function isMountCall(payload: unknown): payload is JsonRpcCall {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null && p.params.name === SECRET_MOUNT_TOOL;
}

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
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    // 파일 이름은 secret id 다 — 사람이 정한 이름·파일 이름으로 경로를 짓지 않는다(M5).
    const path = join(dir, body.secret.id);
    await writeFile(path, Buffer.from(body.valueBase64, 'base64'), { mode: 0o600 });
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

  return {
    noteLease(runnerId, agentId, notice) {
      const expiresAtMs = Date.parse(notice.expiresAt);
      if (!Number.isFinite(expiresAtMs)) return;
      leases.set(keyOf(runnerId, notice.cause), {
        runnerId, agentId, cause: notice.cause, leaseId: notice.leaseId, token: notice.token, expiresAtMs,
      });
    },

    async leaseEnded(runnerId, cause) {
      const lease = leases.get(keyOf(runnerId, cause));
      if (lease) await drop(lease, true);
    },

    async maybeHandle(runnerId, agentId, req) {
      if (req.type !== 'mcp.request' || !isMountCall(req.payload)) return null;
      const call = req.payload;
      const name = (call.params?.arguments as { name?: unknown } | undefined)?.name;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse =>
        ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
        return reply({ error: { code: 'bad_request', message: 'name must be a secret name from secret.list' } }, true);
      }
      const lease = req.cause ? leases.get(keyOf(runnerId, req.cause)) : undefined;
      if (!lease || lease.agentId !== agentId || lease.expiresAtMs <= now()) {
        return reply({ error: { code: 'no_lease', message: 'secrets are not available in this turn' } }, true);
      }
      try {
        const r = await mount(lease, name);
        return reply(r.value, !r.ok);
      } catch (e) {
        deps.log(`turn-secrets: 마운트 실패 — ${e instanceof Error ? e.message : String(e)}`);
        return reply({ error: { code: 'mount_failed', message: 'the secret could not be written to the turn directory' } }, true);
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
