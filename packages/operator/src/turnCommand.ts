/**
 * 「정확한 명령」 승인의 오퍼레이터 쪽(권한 요청 H③b, 스레드 8769dbf7, security F1·C1·C2·사전 2).
 *
 * 두 가지를 받는다 — 둘 다 브릿지 소켓으로 온 `mcp.request{tools/call}` 이다.
 *
 * 1. `permission.request`(kind=command) — 서버로 넘기기 전에 그 명령이 읽는 파일(shared `validateExactCommand.files`)을 **이 프로세스가**
 *    재서(`measureCommandFiles`) `mcp.request.commandFiles` 에 싣는다. forwarder 가 그것을 `COMMAND_FILES_HEADER` 로 옮긴다. 링크에서
 *    들어온 `commandFiles` 는 `run.ts` 가 **언제나 먼저 지운다**(`stripLinkOnlyFields`) — 브릿지·에이전트가 그 칸을 미리 채워 와도 서버에
 *    닿는 값은 이 프로세스가 잰 것뿐이다. 파일을 못 재면 서버로 넘기지 않고 거절을 돌려준다.
 * 2. `command.check` — PreToolUse hook(`harkroom-operator hook pretool`)이 묻는다. 그 턴의 임대(러너가 relay 로 맡긴 것)와 지금 잰 파일
 *    해시, hook 입력의 cwd 로 서버 `POST /agent/command-grants/match` 를 부르고 `{allow}` 만 돌려준다. 임대가 없거나 서버에 닿지
 *    않거나 파일을 못 재면 `allow:false` — hook 은 무출력으로 분류기에 넘긴다(닫힌 쪽 실패).
 *
 * C2: 파일은 `realpath(p) === p`(경로의 **어느 마디도** 링크가 아님)이고 `lstat` 이 일반 파일이며 1MiB 이하일 때만 잰다. 디렉터리는 거절.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { validateExactCommand, type CommandFileArg } from '@harkroom/shared';
import type { CommandFileDigest, RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import type { MergeLease } from './turnMerge.js';

export const COMMAND_CHECK_TOOL = 'command.check';
export const COMMAND_FILE_MAX_BYTES = 1024 * 1024;
/** 파일당 미리 보기 상한 — 헤더(Node 기본 16KB)에 여러 파일이 실려도 넘지 않게(security n2). */
const PREVIEW_CHARS = 1024;
/** 미리 보기 전체 합 상한. 넘치면 뒤 파일은 미리 보기 없이(경로·크기·해시만). */
const PREVIEW_TOTAL_CHARS = 3072;

/**
 * 내용에 비밀이 있어 보이면 미리 보기를 싣지 않는다(security F1) — 플래그로 비밀 자리를 가르는 것만으로는 `kubectl apply -f /x/secret.yaml`
 * 같은 흔한 꼴이 빠진다. 카드 본문·meta 는 채널 멤버 모두에게 영구히 남는다. 오탐은 괜찮다(소유자가 내용을 못 볼 뿐, 해시 고정은 그대로).
 */
const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /kind:\s*["']?Secret\b/i,
  /\bstringData\s*:/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)["']?\s*[:=]/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(ghp|gho|ghs|github_pat|xox[abpr]|sk-[a-z]*)[-_A-Za-z0-9]{10,}/,
];

export function looksSecret(text: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(text));
}

export type MeasureResult = { ok: true; digests: CommandFileDigest[] } | { ok: false; code: string; message: string; path?: string };

/** C2 + 해시. `withPreview` 면 비밀 아닌 자리에 앞 4KB(UTF-8 로 읽힌 만큼)를 싣는다 — 요청 카드용. match 에는 싣지 않는다. */
export async function measureCommandFiles(files: readonly CommandFileArg[], withPreview: boolean): Promise<MeasureResult> {
  const out: CommandFileDigest[] = [];
  let previewBudget = PREVIEW_TOTAL_CHARS;
  for (const f of files) {
    let real: string;
    try { real = await realpath(f.path); } catch { return { ok: false, code: 'file_missing', message: 'a file this command reads does not exist', path: f.path }; }
    if (real !== f.path) return { ok: false, code: 'file_link', message: 'a file path goes through a symbolic link — use the real path', path: f.path };
    const st = await lstat(f.path).catch(() => null);
    if (!st || !st.isFile()) return { ok: false, code: 'file_not_regular', message: 'only regular files can be pinned (no directories or devices)', path: f.path };
    if (st.size > COMMAND_FILE_MAX_BYTES) return { ok: false, code: 'file_too_large', message: `files over ${COMMAND_FILE_MAX_BYTES} bytes cannot be pinned`, path: f.path };
    const buf = await readFile(f.path);
    if (buf.length > COMMAND_FILE_MAX_BYTES) return { ok: false, code: 'file_too_large', message: `files over ${COMMAND_FILE_MAX_BYTES} bytes cannot be pinned`, path: f.path };
    const d: CommandFileDigest = { path: f.path, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
    if (withPreview && !f.secret && previewBudget > 0) {
      const text = buf.toString('utf8');
      // 파일 **전체**에서 비밀 꼴을 찾는다 — 앞 1KB 만 보면 뒤에 있는 키를 놓치지만, 싣는 것은 앞부분뿐이라 전체가 깨끗할 때만 싣는다.
      if (!looksSecret(text)) {
        d.preview = text.slice(0, Math.min(PREVIEW_CHARS, previewBudget));
        previewBudget -= d.preview.length;
      }
    }
    out.push(d);
  }
  return { ok: true, digests: out };
}

/** 링크에서 들어온 요청에서 **오퍼레이터만 쓰는 칸**을 지운다. `run.ts` 가 어떤 처리보다 먼저 부른다(security 사전 2). */
export function stripLinkOnlyFields(req: RunnerLinkRequest): RunnerLinkRequest {
  if (req.type !== 'mcp.request' || !('commandFiles' in req)) return req;
  const { commandFiles: _drop, ...rest } = req;
  return rest;
}

export interface TurnCommandDeps {
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  lookupLease(runnerId: string, cause: string): MergeLease | null;
  log(line: string): void;
  measure?: typeof measureCommandFiles;
}

interface JsonRpcCall { id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function toolCall(payload: unknown): JsonRpcCall | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null ? p : null;
}

function toolResult(id: string | number | undefined, value: unknown, isError: boolean): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } };
}

export function createTurnCommand(deps: TurnCommandDeps) {
  const measure = deps.measure ?? measureCommandFiles;

  const check = async (runnerId: string, agentId: string, req: RunnerLinkRequest & { type: 'mcp.request' }, args: Record<string, unknown>): Promise<{ allow: boolean; grantId?: string }> => {
    const command = typeof args.command === 'string' ? args.command : '';
    const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
    const toolUseId = typeof args.toolUseId === 'string' ? args.toolUseId.slice(0, 200) : undefined;
    const v = validateExactCommand(command);
    if (!v.ok) return { allow: false };
    const lease = req.cause ? deps.lookupLease(runnerId, req.cause) : null;
    if (!lease || lease.agentId !== agentId) return { allow: false };
    const m = await measure(v.files, false);
    if (!m.ok) return { allow: false };
    const res = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/command-grants/match', contentType: 'application/json',
      body: JSON.stringify({
        leaseId: lease.leaseId, token: lease.token, command: v.command,
        files: m.digests.map((d) => ({ path: d.path, sha256: d.sha256 })),
        ...(cwd ? { cwd } : {}), ...(toolUseId ? { toolUseId } : {}),
      }),
    }).catch(() => null);
    if (!res || res.type !== 'http.response' || res.status !== 200) return { allow: false };
    try {
      const r = JSON.parse(res.body) as { allow?: unknown; grantId?: unknown };
      return r.allow === true && typeof r.grantId === 'string' ? { allow: true, grantId: r.grantId } : { allow: false };
    } catch { return { allow: false }; }
  };

  return {
    /** 처리했으면 응답, 아니면 null(다음 처리기로). `req` 는 이미 `stripLinkOnlyFields` 를 지난 것이어야 한다. */
    async maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest, kind: RunnerLinkKind = 'bridge'): Promise<RunnerLinkResponse | null> {
      // hook 소켓은 `command.check` 하나만 한다 — 그 밖의 요청(MCP·REST)은 서버로 나가지 않는다.
      if (kind === 'hook') {
        const c = req.type === 'mcp.request' ? toolCall(req.payload) : null;
        if (!c || c.params?.name !== COMMAND_CHECK_TOOL) {
          return req.type === 'mcp.request'
            ? { type: 'mcp.error', id: req.id, status: 403, message: 'the hook link only answers command.check' }
            : { type: 'http.response', id: req.id, status: 403, body: 'the hook link only answers command.check' };
        }
      }
      if (req.type !== 'mcp.request') return null;
      const call = toolCall(req.payload);
      if (!call) return null;
      const args = (typeof call.params?.arguments === 'object' && call.params.arguments !== null ? call.params.arguments : {}) as Record<string, unknown>;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse => ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });

      if (call.params?.name === COMMAND_CHECK_TOOL) {
        // hook 소켓에서만 받는다(security) — 에이전트가 MCP 로 불러 1회 grant 를 미리 써 버리지 못하게. 서버로도 넘기지 않는다.
        if (kind !== 'hook') return reply({ allow: false, error: { code: 'hook_only', message: 'command.check is answered only on the hook link' } }, true);
        try {
          return reply(await check(runnerId, agentId, req, args), false);
        } catch (e) {
          deps.log(`command.check: 실패 — ${e instanceof Error ? e.message : String(e)}`);
          return reply({ allow: false }, false);
        }
      }

      if (call.params?.name === 'permission.request' && args.kind === 'command' && typeof args.command === 'string') {
        const v = validateExactCommand(args.command);
        // 판정에 걸리는 명령은 서버가 정확한 거절 코드로 답한다 — 재지 않고 그대로 넘긴다(헤더 없음).
        if (!v.ok || !v.files.length) return deps.forward(agentId, req);
        const m = await measure(v.files, true);
        if (!m.ok) return reply({ error: { code: m.code, message: m.message, ...(m.path ? { path: m.path } : {}) } }, true);
        return deps.forward(agentId, { ...req, commandFiles: Buffer.from(JSON.stringify(m.digests)).toString('base64') });
      }
      return null;
    },
  };
}
