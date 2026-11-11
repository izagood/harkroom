/**
 * 외부 API 호출 래퍼 — 오퍼레이터가 받는 `harkroom-operator api` (C안 P3, 설계 스레드 07519d86). 머지 래퍼(`turnMerge.ts`)와
 * 같은 틀이다.
 *
 * **이것은 실수 방지 장치이지 경계가 아니다.** 같은 사용자 계정으로 도는 에이전트는 이 머신의 다른 자격에 닿는다. 이 래퍼가
 * 막는 것은 "사람이 허락하지 않은 대상·메서드·경로로 키가 붙어 나가는 것"과 "키가 채팅·transcript 에 평문으로 도는 것"이다.
 *
 * 흐름:
 *   하네스가 `<operatorBin> api <연결> <METHOD> <경로> [--data @파일|<글자>] [--content-type <형식>]` 를 부른다(러너가 그 에이전트에
 *   api.call grant 가 있을 때만 allow 규칙을 준다) → 래퍼 프로세스가 브릿지와 같은 소켓으로 `tools/call api.call` 을 보낸다
 *   (`main.ts::apiMain`) → 여기서 받는다: ① 인자 모양 ② 턴 임대 ③ 서버 `POST /agent/api-checks`(사슬 판정·키 건네기, 닿지 않으면
 *   fail-closed) ④ URL 을 짓고 origin 을 다시 확인 ⑤ fetch(`redirect: 'manual'`, 시한) ⑥ `POST /agent/api-results`(스레드 시스템 줄)
 *   ⑦ 응답을 가려서(키 값 제거) 돌려준다.
 *
 * 지키는 것(security 메모):
 * - **키는 이 프로세스 메모리에만 잠깐 있다.** 래퍼 프로세스·하네스 env·MCP 결과·로그 어디에도 나가지 않는다. 응답 본문·헤더에
 *   키 값이 되비치면 가린다.
 * - **리다이렉트는 따라가지 않는다.** fetch 는 다른 출처로 갈 때 `Authorization` 만 떼고 사용자 정의 헤더는 그대로 보낸다 —
 *   `header` 종류의 키가 남의 호스트로 간다. 3xx 는 상태와 `location` 만 돌려준다.
 * - **origin 을 다시 잰다.** `new URL(path, baseUrl).origin === baseUrl` 가 아니면 보내지 않는다(서버도 경로를 재지만 URL 짓기는
 *   여기서 한다).
 * - 사설 IP·내부 호스트를 기본 주소로 쓰는 것은 연결 주인의 선택이다(문서에 적는다) — 여기서 막지 않는다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunnerLinkRequest, RunnerLinkResponse } from '@harkroom/shared/runnerLink';
import { API_METHODS } from '@harkroom/shared';
import type { MergeLease } from './turnMerge.js';

export const API_TOOL = 'api.call';

const CONNECTOR_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 요청 본문 상한 — 래퍼가 파일을 읽어 소켓으로 보내므로 크게 두지 않는다. */
export const API_MAX_BODY = 1024 * 1024;
/** 응답 본문은 이만큼 읽고, 모델에게는 앞부분만 준다. */
const RESPONSE_READ_MAX = 2 * 1024 * 1024;
const RESPONSE_RETURN_MAX = 256 * 1024;
const TIMEOUT_MS = 60_000;
/** 토큰 교환(156) — 시한·응답 상한·토큰 모양. */
const EXCHANGE_TIMEOUT_MS = 15_000;
const EXCHANGE_READ_MAX = 64 * 1024;
const TOKEN_MAX = 8192;
/** 헤더에 그대로 실어도 되는 글자만(보이는 ASCII, 공백·제어문자 없음 — security 조건 3). */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const TOKEN_TTL_DEFAULT_S = 300;
const TOKEN_TTL_MAX_S = 3600;

export interface TokenForm { grantType: string; clientId: string; keyField: string }

/**
 * 받은 토큰을 얼마나 쓸까(초). 만료 60초 전까지 — 단 `expires_in` 이 짧으면 max(절반, 10초)(security 조건 6). 없으면 5분,
 * 상한 1시간.
 */
export function tokenTtlSeconds(expiresIn: unknown): number {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return TOKEN_TTL_DEFAULT_S;
  const ttl = expiresIn > 120 ? expiresIn - 60 : Math.max(expiresIn / 2, 10);
  return Math.min(ttl, TOKEN_TTL_MAX_S);
}

/**
 * 토큰 교환 한 번. 키는 form 의 `keyField` 자리에만 들어간다(`URLSearchParams` 로만 짓는다 — 조건 2). 실패하면 HTTP
 * 상태만 돌려준다 — 오류 본문·예외 문구는 키가 되비칠 수 있어 어디에도 싣지 않는다(조건 5). `access_token` 말고는 바로
 * 버린다(조건 4).
 */
export async function exchangeToken(
  doFetch: Fetcher, tokenUrl: string, form: TokenForm, key: string,
): Promise<{ ok: true; token: string; ttlS: number } | { ok: false; status: number }> {
  let url: URL;
  try { url = new URL(tokenUrl); } catch { return { ok: false, status: 0 }; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return { ok: false, status: 0 };
  const body = new URLSearchParams();
  body.set('grant_type', form.grantType);
  body.set('client_id', form.clientId);
  body.set(form.keyField, key);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST', body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'harkroom-operator-api' },
    });
  } catch {
    return { ok: false, status: 0 };
  }
  // 3xx 는 실패다 — Location 을 따라가지 않는다(조건 3).
  if (res.status < 200 || res.status >= 300) { await res.body?.cancel().catch(() => {}); return { ok: false, status: res.status }; }
  const chunks: Buffer[] = []; let read = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value: chunk } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done || !chunk) break;
      read += chunk.byteLength;
      if (read > EXCHANGE_READ_MAX) { await reader.cancel().catch(() => {}); return { ok: false, status: res.status }; }
      chunks.push(Buffer.from(chunk));
    }
  }
  let json: { access_token?: unknown; token_type?: unknown; expires_in?: unknown };
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof json; } catch { return { ok: false, status: res.status }; }
  const token = json.access_token;
  if (json.token_type !== undefined && (typeof json.token_type !== 'string' || json.token_type.toLowerCase() !== 'bearer')) return { ok: false, status: res.status };
  if (typeof token !== 'string' || !token.length || token.length > TOKEN_MAX || !TOKEN_RE.test(token)) return { ok: false, status: res.status };
  return { ok: true, token, ttlS: tokenTtlSeconds(json.expires_in) };
}

/**
 * `--data @파일` 을 읽는다(#1882 정리, Rust `api_cli::read_body_file` 과 같은 규칙).
 * - 작업 폴더(`cwd`, 하네스 셸의 cwd) **안의 일반 파일**만 — 절대 경로·`..`·심링크로 밖을 가리키면 거절한다. 판정은 실제 경로끼리 한다.
 * - FIFO 에 멈추지 않게 열기 전에 종류를 보고 O_NONBLOCK·O_NOFOLLOW 로 연 뒤 핸들에서 다시 본다.
 * - 상한+1 바이트까지만 읽는다. 넘었는지는 `parseApiArgs` 가 길이로 판정한다.
 */
export function readApiBodyFile(cwd: string, p: string): Buffer {
  if (!p || isAbsolute(p) || p.split(/[\\/]/).some((c) => c === '..')) throw new Error('outside the working folder');
  const root = realpathSync(cwd);
  const real = realpathSync(resolve(root, p));
  const rel = relative(root, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('outside the working folder');
  if (!lstatSync(real).isFile()) throw new Error('not a regular file');
  const fd = openSync(real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(API_MAX_BODY + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export interface ApiArgs { connector: string; method: string; path: string; body: string | null; contentType: string | null }

/**
 * `api <연결> <METHOD> <경로> [--data @파일|<글자>] [--content-type <형식>]`. 셸에서 온 문자열이라 전부 다시 잰다. `readFile` 은 래퍼
 * 프로세스(하네스 셸)에서만 쓴다 — 오퍼레이터 쪽 `argsOf` 는 파일을 읽지 않는다.
 */
export function parseApiArgs(argv: readonly string[], readFile: (p: string) => Buffer): ApiArgs | { error: string } {
  const [connector, rawMethod, path, ...rest] = argv;
  const usage = '사용법: harkroom-operator api <연결> <GET|POST|PUT|PATCH|DELETE> </경로> [--data @파일|<글자>] [--content-type <형식>]';
  if (!connector || !rawMethod || !path) return { error: usage };
  if (!CONNECTOR_RE.test(connector)) return { error: `연결 이름이 아니다: ${connector}` };
  const method = rawMethod.toUpperCase();
  if (!(API_METHODS as readonly string[]).includes(method)) return { error: `메서드가 아니다: ${rawMethod}` };
  if (!path.startsWith('/') || path.length > 2000) return { error: '경로는 / 로 시작한다(전체 URL 이 아니라 경로만 — 주소는 연결이 정한다)' };
  let body: string | null = null; let contentType: string | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]; const value = rest[i + 1];
    if (value === undefined) return { error: `${flag ?? ''} 에 값이 없다` };
    if (flag === '--data' && body === null) {
      if (value.startsWith('@')) {
        let buf: Buffer;
        try { buf = readFile(value.slice(1)); } catch { return { error: `파일을 읽지 못했다: ${value.slice(1)}` }; }
        if (buf.length > API_MAX_BODY) return { error: `본문이 ${API_MAX_BODY} 바이트보다 크다` };
        body = buf.toString('utf8');
      } else {
        if (Buffer.byteLength(value) > API_MAX_BODY) return { error: `본문이 ${API_MAX_BODY} 바이트보다 크다` };
        body = value;
      }
      continue;
    }
    if (flag === '--content-type' && contentType === null && /^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/i.test(value)) { contentType = value; continue; }
    return { error: `받지 않는 인자: ${flag ?? ''} — --data·--content-type 만 받는다(헤더·주소는 연결이 정한다)` };
  }
  if (body !== null && (method === 'GET' || method === 'DELETE') && body.length) return { error: `${method} 에는 본문을 싣지 않는다` };
  return { connector, method, path, body, contentType: body !== null ? contentType ?? 'application/json' : null };
}

/** 키 값을 응답에서 가린다 — 값 그대로와 base64 꼴 둘 다. 8자 미만 값은 오탐이 많아 가리지 않는다(그런 키는 키가 아니다). */
export function scrubValue(text: string, value: string): string {
  if (value.length < 8) return text;
  let out = text.split(value).join('[REDACTED]');
  const b64 = Buffer.from(value, 'utf8').toString('base64').replace(/=+$/, '');
  if (b64.length >= 8) out = out.split(b64).join('[REDACTED]');
  // URL 인코딩 꼴로 되비치는 응답도 있다(질의·리다이렉트 location, #1139 security n1).
  const enc = encodeURIComponent(value);
  if (enc !== value) out = out.split(enc).join('[REDACTED]');
  return out;
}

export type Fetcher = typeof fetch;

export interface TurnApiDeps {
  forward(agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse>;
  lookupLease(runnerId: string, cause: string): MergeLease | null;
  log(line: string): void;
  fetch?: Fetcher;
  now?: () => number;
}

export interface TurnApi {
  maybeHandle(runnerId: string, agentId: string, req: RunnerLinkRequest): Promise<RunnerLinkResponse | null>;
}

interface JsonRpcCall { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: unknown; arguments?: unknown } }

function isApiCall(payload: unknown): payload is JsonRpcCall {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as JsonRpcCall;
  return p.method === 'tools/call' && typeof p.params === 'object' && p.params !== null && p.params.name === API_TOOL;
}

function toolResult(id: string | number | undefined, value: unknown, isError: boolean): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } };
}

/** 소켓으로 온 `arguments` 를 다시 잰다 — 래퍼 프로세스가 아니라 **이 프로세스**가 마지막 관문이다. 파일은 읽지 않는다. */
function argsOf(call: JsonRpcCall): ApiArgs | { error: string } {
  const a = call.params?.arguments;
  if (typeof a !== 'object' || a === null) return { error: 'arguments 가 없다' };
  const { connector, method, path, body, contentType, ...extra } = a as Record<string, unknown>;
  if (Object.keys(extra).length) return { error: `받지 않는 인자: ${Object.keys(extra).join(', ')}` };
  if (body !== null && body !== undefined && typeof body !== 'string') return { error: 'body 는 글자다' };
  if (contentType !== null && contentType !== undefined && typeof contentType !== 'string') return { error: 'contentType 은 글자다' };
  const r = parseApiArgs([String(connector ?? ''), String(method ?? ''), String(path ?? '')], () => { throw new Error('no file reads here'); });
  if ('error' in r) return r;
  if (typeof body === 'string' && Buffer.byteLength(body) > API_MAX_BODY) return { error: `본문이 ${API_MAX_BODY} 바이트보다 크다` };
  if (typeof body === 'string' && body.length && (r.method === 'GET' || r.method === 'DELETE')) return { error: `${r.method} 에는 본문을 싣지 않는다` };
  if (typeof contentType === 'string' && !/^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/i.test(contentType)) return { error: 'contentType 모양이 아니다' };
  return {
    ...r,
    body: typeof body === 'string' ? body : null,
    contentType: typeof body === 'string' ? (typeof contentType === 'string' ? contentType : 'application/json') : null,
  };
}

export function createTurnApi(deps: TurnApiDeps): TurnApi {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  /**
   * 받은 토큰 캐시(156) — 메모리에만. 키는 (에이전트, 연결 주소, 토큰 주소, form, 키 값) 지문이다: 에이전트 계정은 한
   * 커뮤니티(서버)에만 있으므로 여러 커뮤니티를 붙든 오퍼레이터에서도 섞이지 않고(조건 6), 키를 돌리거나 주소·form 을
   * 바꾸면 저절로 새로 받는다. 캐시가 있어도 **매 호출 서버 판정(api-checks)을 먼저** 거친다 — 부여 회수·연결 삭제가 바로 듣는다.
   */
  const tokens = new Map<string, { token: string; until: number }>();
  const tokenKey = (agentId: string, baseUrl: string, tokenUrl: string, form: TokenForm, key: string): string =>
    createHash('sha256').update(JSON.stringify([agentId, baseUrl, tokenUrl, form.grantType, form.clientId, form.keyField, key])).digest('hex');

  const run = async (runnerId: string, agentId: string, req: RunnerLinkRequest & { type: 'mcp.request' }, call: JsonRpcCall)
    : Promise<{ ok: boolean; value: unknown }> => {
    const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, value: { error: { code, message }, ...extra } });
    const parsed = argsOf(call);
    if ('error' in parsed) return fail('bad_request', parsed.error);
    const { connector, method, path } = parsed;

    const lease = req.cause ? deps.lookupLease(runnerId, req.cause) : null;
    if (!lease || lease.agentId !== agentId) return fail('no_lease', 'api calls are not available in this turn (no turn lease)');

    // ③ 서버 판정. 닿지 않으면 부르지 않는다(fail-closed).
    const check = await deps.forward(agentId, {
      type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/api-checks',
      body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, connector, method, path, caps: ['token_exchange'] }), contentType: 'application/json',
    }).catch(() => null);
    if (!check || check.type !== 'http.response' || check.status === 0) return fail('unavailable', 'the server could not be reached — call refused (fail-closed)');
    if (check.status !== 200) {
      let code = `http_${check.status}`;
      try { code = (JSON.parse(check.body) as { error?: { code?: string } }).error?.code ?? code; } catch { /* 그대로 */ }
      return fail(code, `api call not allowed: ${code}`, { blocked: true });
    }
    let g: { baseUrl?: string; authKind?: string; authHeader?: string | null; valueBase64?: string | null; tokenUrl?: string; tokenForm?: TokenForm; path?: string };
    try { g = JSON.parse(check.body) as typeof g; } catch { return fail('bad_reply', 'unparseable api-checks reply'); }
    const value = g.valueBase64 ? Buffer.from(g.valueBase64, 'base64').toString('utf8') : '';
    g.valueBase64 = null;

    const report = async (status: number, durationMs: number, bytes: number, error: string | null): Promise<void> => {
      const res = await deps.forward(agentId, {
        type: 'http.forward', id: randomUUID(), method: 'POST', path: '/agent/api-results',
        body: JSON.stringify({ leaseId: lease.leaseId, token: lease.token, connector, method, path, status, durationMs, bytes, error }), contentType: 'application/json',
      }).catch(() => null);
      if (!res || res.type !== 'http.response' || res.status !== 201) deps.log(`api: ${connector} ${method} 보고가 서버에 닿지 않았다(${res && res.type === 'http.response' ? res.status : 'no response'})`);
    };

    // ④ URL 짓기 + origin 재확인. 서버가 판정한 경로(실제로 보낼 꼴, security 조건 7)가 있으면 그것을 그대로 쓴다.
    const sendPath = typeof g.path === 'string' && g.path.startsWith('/') ? g.path : path;
    let url: URL;
    try { url = new URL(sendPath, g.baseUrl); } catch { await report(0, 0, 0, 'bad_url'); return fail('bad_url', 'could not build the URL'); }
    if (!g.baseUrl || url.origin !== g.baseUrl || url.protocol !== 'https:') { await report(0, 0, 0, 'origin_mismatch'); return fail('origin_mismatch', 'the path would leave the connector origin'); }

    const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5', 'user-agent': 'harkroom-operator-api' };
    // 토큰 교환(156). 받은 토큰도 키와 똑같이 가린다(조건 4) — `scrub` 이 둘 다 본다.
    let accessToken = '';
    let fromCache = false;
    const scrub = (text: string): string => scrubValue(scrubValue(text, value), accessToken);
    const tk = g.authKind === 'token_exchange' && g.tokenUrl && g.tokenForm ? tokenKey(agentId, g.baseUrl, g.tokenUrl, g.tokenForm, value) : null;
    const getToken = async (): Promise<boolean> => {
      const hit = tk ? tokens.get(tk) : undefined;
      if (hit && hit.until > now()) { accessToken = hit.token; fromCache = true; return true; }
      fromCache = false;
      const ex = await exchangeToken(doFetch, g.tokenUrl!, g.tokenForm!, value);
      if (!ex.ok) return false;
      accessToken = ex.token;
      tokens.set(tk!, { token: ex.token, until: now() + ex.ttlS * 1000 });
      return true;
    };
    if (g.authKind === 'token_exchange') {
      if (!tk) { await report(0, 0, 0, 'token_exchange_failed'); return fail('token_exchange_failed', 'token exchange is not configured for this connector'); }
      if (!(await getToken())) {
        await report(0, 0, 0, 'token_exchange_failed');
        return fail('token_exchange_failed', 'token exchange failed');
      }
      headers.authorization = `Bearer ${accessToken}`;
    } else if (g.authKind === 'bearer') headers.authorization = `Bearer ${value}`;
    else if (g.authKind === 'header' && g.authHeader) headers[g.authHeader.toLowerCase()] = value;
    if (parsed.body !== null) headers['content-type'] = parsed.contentType ?? 'application/json';

    // ⑤ 호출. 리다이렉트는 따라가지 않는다.
    const started = now();
    let res: Response;
    const send = () => doFetch(url, { method, headers, body: parsed.body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    try {
      res = await send();
      // 캐시에서 꺼낸 토큰이 401 이면 버리고 **한 번만** 다시 교환해 다시 보낸다(조건 6). 401 은 처리되지 않은 요청이다.
      if (res.status === 401 && fromCache && tk) {
        tokens.delete(tk);
        await res.body?.cancel().catch(() => {});
        if (!(await getToken())) {
          await report(0, now() - started, 0, 'token_exchange_failed');
          return fail('token_exchange_failed', 'token exchange failed');
        }
        headers.authorization = `Bearer ${accessToken}`;
        res = await send();
      }
    } catch (e) {
      const msg = scrub(e instanceof Error ? e.message : String(e)).slice(0, 300);
      await report(0, now() - started, 0, msg);
      return fail('unreachable', `request failed: ${msg}`);
    }
    // 본문은 상한까지만 읽는다.
    const chunks: Buffer[] = []; let read = 0; let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        read += chunk.byteLength;
        if (read > RESPONSE_READ_MAX) { truncated = true; await reader.cancel().catch(() => {}); break; }
        chunks.push(Buffer.from(chunk));
      }
    }
    const durationMs = now() - started;
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = scrub(raw);
    const returned = text.length > RESPONSE_RETURN_MAX ? text.slice(0, RESPONSE_RETURN_MAX) : text;
    await report(res.status, durationMs, read, null);
    deps.log(`api: ${connector} ${method} ${path.split('?')[0]} → ${res.status} (${durationMs}ms, ${read}B) agent=${agentId}`);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    return {
      ok: res.status < 400,
      value: {
        status: res.status,
        contentType: res.headers.get('content-type'),
        ...(location ? { location: scrub(location), note: 'redirects are not followed' } : {}),
        body: returned,
        ...(truncated || returned.length < text.length ? { truncated: true } : {}),
      },
    };
  };

  return {
    async maybeHandle(runnerId, agentId, req) {
      if (req.type !== 'mcp.request' || !isApiCall(req.payload)) return null;
      const call = req.payload;
      const reply = (value: unknown, isError: boolean): RunnerLinkResponse =>
        ({ type: 'mcp.response', id: req.id, messages: [toolResult(call.id, value, isError)] });
      try {
        const r = await run(runnerId, agentId, req, call);
        return reply(r.value, !r.ok);
      } catch (e) {
        deps.log(`api: 실패 — ${e instanceof Error ? e.message : String(e)}`);
        return reply({ error: { code: 'api_error', message: 'the api wrapper hit an internal error' } }, true);
      }
    },
  };
}
