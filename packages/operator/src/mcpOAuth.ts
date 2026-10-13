/**
 * 원격 MCP 의 OAuth 토큰 — **오퍼레이터가 갖는다**(2026-09-30, harkroom 스레드 ebb97c7b).
 *
 * ## 왜 하네스에 맡기지 않나
 *
 * 전에는 claude 가 제 손으로 인증했다(정의의 `oauth` 를 읽고 `/mcp` 또는 `authenticate` 도구로).
 * 그 토큰은 claude 의 secure storage — mac 이면 Keychain `Claude Code-credentials-<sha8(configDir)>` —
 * 에 **계정 디렉터리마다 따로** 남는다. 계정 풀이 있으면 그것이 곧 결함이다(실측 09-30):
 * - slack 토큰은 풀의 한 계정(lime)에만 있었고, 한도로 lychee 에 넘어간 턴은 "requires authentication".
 * - 턴 안에서 연 흐름(PKCE verifier·localhost 콜백)은 그 프로세스와 함께 사라져, 다음 턴에 붙인
 *   콜백은 `No OAuth flow is in progress` 로 떨어졌다.
 * - 계정을 지우면(#941) 그 Keychain 항목과 함께 MCP 토큰도 사라진다.
 *
 * 그래서 사람이 **데스크톱에서 한 번** 인증하고, 오퍼레이터가 토큰을 들고 refresh 하며, 러너를
 * 띄울 때 `Authorization` 헤더로 굽는다(`mcpConfig.ts::buildMcpConfig`). 하네스·계정 디렉터리와
 * 무관하다 — 계정을 바꾸든 지우고 다시 넣든 토큰은 여기 그대로다.
 *
 * ## 흐름 (MCP 권한 명세 2025-06-18 · RFC 9728 · RFC 8414 · RFC 7591 · PKCE)
 *
 * 1. 보호 자원 메타데이터 — MCP url 에 인증 없이 부르면 오는 401 의 `resource_metadata`, 없으면
 *    `/.well-known/oauth-protected-resource[경로]`. 거기서 인가 서버를 얻는다. 없으면 옛 명세
 *    (2025-03-26)대로 MCP 의 origin 이 인가 서버다.
 * 2. 인가 서버 메타데이터 — `/.well-known/oauth-authorization-server`, 없으면 `openid-configuration`.
 * 3. 클라이언트 — 정의에 `oauth.clientId` 가 있으면 그것(slack 처럼 등록된 클라이언트만 받는
 *    서버), 없으면 동적 등록(RFC 7591).
 * 4. 브라우저 → localhost 콜백 → 코드 교환. 콜백 포트는 정의의 `oauth.callbackPort`(등록된
 *    redirect_uri 가 그 포트다 — slack 3118), 없으면 빈 포트.
 *
 * **포트가 겹치면 기다리지 않고 말한다**: 3118 은 claude 의 `/mcp` 가 같은 클라이언트로 쓰는
 * 자리라, 다른 창에서 그 인증이 열려 있으면 여기서 못 연다. 한 이름에 흐름은 하나다 — 다시
 * 누르면 앞 흐름을 닫고 새로 연다.
 *
 * 토큰은 `<appDataDir>/operator/secrets/mcp-oauth.json`(0600, 원자적 쓰기)에 둔다 — 운영자 토큰과
 * 같은 자리다. 소켓으로는 **값을 내보내지 않는다**(상태만).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OperatorMcpAuthState, OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';

export interface McpOAuthRecord {
  /** 이 토큰이 붙는 MCP url. 정의의 url 이 바뀌면 이 토큰은 그 서버의 것이 아니다. */
  url: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  /** RFC 8707 resource — 토큰을 그 MCP 로 묶는다. refresh 에도 싣는다. */
  resource: string;
  accessToken: string;
  refreshToken?: string;
  /** ms. 모르면 없다 — 그때는 만료를 가정하지 않는다. */
  expiresAt?: number;
  /**
   * `expired` = refresh 가 거절됐다(invalid_grant 등). 사람이 다시 인증해야 한다.
   * `rejected` = **MCP 서버가** 이 토큰을 거절했고(하네스의 `AUTH_HEADER_REJECTED`), 그 보고로
   * 즉시 refresh 한 새 토큰도 다시 거절됐다(`reportRejected`). 역시 사람이 다시 인증해야 한다.
   */
  status: 'ok' | 'expired' | 'rejected';
  /** 이 토큰을 받은 시각(ms). 하네스의 거절 보고가 이 토큰에 대한 것인지 가르는 기준이다. */
  updatedAt: number;
  /** 이 토큰이 **거절 보고로 당겨 받은** 것인가. 이것이 다시 거절되면 `rejected` 다. */
  refreshedOnReject?: boolean;
  /** `rejected` 가 된 시각과 그 보고를 한 에이전트 id. 새 토큰이 들어오면 지운다. */
  rejectedAt?: number;
  rejectedBy?: string;
}

/** `reportRejected` 가 한 일. 운영 로그와 설정 재작성에 쓴다 — 토큰 값은 `refreshed` 에만 있다. */
export type McpRejectOutcome =
  | { action: 'ignored'; reason: 'unknown' | 'not_ok' | 'stale' | 'cooldown' | 'network' | 'no_refresh_token' | 'client_changed' }
  | { action: 'refreshed'; url: string; accessToken: string }
  | { action: 'expired' }
  | { action: 'rejected' };

export interface McpOAuth {
  /** 흐름을 연다. 돌려준 url 을 사람이 브라우저에서 연다(앱이 연다). */
  start(name: string, definition: OperatorMcpRemoteDefinition): Promise<{ authUrl: string }>;
  /**
   * `clientId` 는 지금 정의의 `oauth.clientId`. 들고 있는 토큰이 **다른 클라이언트로** 받은 것이면
   * (전용 Slack 앱으로 갈아탄 직후 등) 그 토큰은 이 정의의 것이 아니다 — `none` 으로 내어 다시 인증하게 한다.
   */
  status(name: string, url: string, clientId?: string): Promise<OperatorMcpAuthState>;
  /**
   * 스폰·재작성 직전에 부른다. 만료가 가까우면 refresh 하고, **쓸 수 있는** 토큰만 돌려준다.
   * `expired` 는 쓸 수 없는 이름(사람이 다시 인증해야 한다).
   */
  tokensFor(defs: Record<string, { url?: string; clientId?: string }>): Promise<{ tokens: Record<string, string>; expired: string[] }>;
  /**
   * 등록된 클라이언트의 secret(2026-10-07, 전용 Slack 앱). 정의 파일이 아니라 `<secrets>/mcp-oauth-clients.json`
   * (0600)에 둔다. `null` 은 지운다. 값은 소켓·로그로 나가지 않는다 — 있는지만 `hasClientSecret` 으로 본다.
   */
  /**
   * secret 은 **그 clientId 에 묶여** 저장된다(security F1, #1243) — 실을 때 clientId 가 같을 때만 싣는다.
   * 다른 클라이언트·다른 인가 서버로 이 값이 나가지 않는다. `secret: null` 이면 clientId 와 상관없이 지운다.
   */
  setClientSecret(name: string, clientId: string | null, secret: string | null): Promise<void>;
  /** `clientId` 를 주면 그 클라이언트에 묶인 secret 만 센다. */
  hasClientSecret(name: string, clientId?: string): Promise<boolean>;
  /** 만료가 가까운 것을 전부 refresh 한다. 새 토큰이 생긴 이름을 돌려준다(설정 재작성용). */
  refreshDue(): Promise<Record<string, { url: string; accessToken: string }>>;
  /**
   * 하네스가 이 이름의 토큰을 **MCP 서버에 거절당했다**(러너의 `mcp.authRejected`, 2026-10-01).
   *
   * 보고는 **신호일 뿐 사실이 아니다** — 세션 기록은 그 에이전트가 직접 쓸 수 있는 파일이고, 토큰
   * 하나를 여러 러너가 같이 쓴다. 그래서 보고 하나로 할 수 있는 일을 좁힌다(security 검토, #989):
   * - 저장소에 없는 이름은 버린다. 이미 `ok` 가 아닌 것도 그대로 둔다.
   * - 그 턴이 **지금 토큰을 받기 전에** 떴으면(`turnStartedAtMs < updatedAt`) 옛 토큰의 늦은 보고다.
   * - 즉시 refresh 는 이름마다 `rejectCooldownMs` 에 한 번이다 — 거짓 보고로 토큰을 계속 돌리지 못한다.
   * - `rejected` 는 보고만으로 붙이지 않는다. **거절로 당겨 받은 토큰이 다시 거절됐을 때만** 붙인다.
   */
  reportRejected(name: string, report: { turnStartedAtMs: number; agentId: string }): Promise<McpRejectOutcome>;
  forget(name: string): Promise<void>;
  close(): void;
}

export interface McpOAuthDeps {
  storePath: string;
  fetch?: typeof fetch;
  now?: () => number;
  log: (line: string) => void;
  /** 흐름의 수명. 기본 5분. */
  flowTimeoutMs?: number;
  /** 만료 몇 ms 전에 refresh 하나. 기본 5분. */
  refreshSkewMs?: number;
  /** 거절 보고로 당기는 refresh 의 이름별 최소 간격. 기본 5분. */
  rejectCooldownMs?: number;
  /**
   * 지금 정의의 `oauth.clientId`(security F2, #1243). 들고 있는 토큰이 다른 클라이언트의 것이면 1분 refresh·
   * 거절 보고 refresh 가 그 토큰을 돌리지 않는다 — 정의 파일을 손으로 고친 경우도 막는다. 없으면 대조하지 않는다.
   */
  currentClientId?: (name: string) => Promise<string | undefined>;
  /** 흐름이 끝나 토큰이 생겼다 — 도는 러너의 설정 파일을 다시 쓴다. */
  onToken?: (name: string, record: { url: string; accessToken: string }) => void | Promise<void>;
}

type Store = Record<string, McpOAuthRecord>;
type ClientStore = Record<string, { clientId: string; clientSecret: string }>;

interface Flow {
  url: string;
  servers: Server[];
  timer: ReturnType<typeof setTimeout>;
  state: 'pending' | 'error';
  error?: string;
}

/**
 * 저장소에서 이름 하나를 꺼낸다 — **자기 키일 때만.** 저장소는 `JSON.parse` 로 만든 평범한 객체라
 * `store['constructor']`·`store['__proto__']` 가 prototype 값을 돌려준다. 이름은 러너의 보고에서도
 * 오므로(`reportRejected`) 그런 이름이 "기록이 있다"로 읽히면 안 된다(security 검토 #990).
 */
const own = (store: Record<string, McpOAuthRecord>, name: string): McpOAuthRecord | undefined =>
  (Object.hasOwn(store, name) ? store[name] : undefined);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const b64url = (buf: Buffer) => buf.toString('base64url');

export function createMcpOAuth(deps: McpOAuthDeps): McpOAuth {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const skew = deps.refreshSkewMs ?? 5 * 60_000;
  const flows = new Map<string, Flow>();
  /** refresh 는 이름마다 한 번에 하나 — refresh 토큰이 회전하면 둘째 요청이 첫째가 받은 것을 무효로 만든다. */
  const refreshing = new Map<string, Promise<McpOAuthRecord | null>>();
  let chain: Promise<unknown> = Promise.resolve();
  const clientsPath = join(dirname(deps.storePath), 'mcp-oauth-clients.json');
  let clientsChain: Promise<unknown> = Promise.resolve();

  async function loadClients(): Promise<ClientStore> {
    let raw: string;
    try { raw = await readFile(clientsPath, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    // JSON.parse 의 오류 문구에는 입력 앞부분이 들어간다(Node 22) — secret 조각이 소켓 오류로 나가지 않게
    // 고정 문구로 바꾼다(security n1, #1243).
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('client secret 파일을 읽지 못했다(형식이 깨졌다)'); }
    return isRecord(parsed) ? (parsed as ClientStore) : {};
  }
  /** 그 이름·그 clientId 에 묶인 secret. clientId 가 다르면 없다. */
  const clientSecretFor = async (name: string, clientId: string | undefined): Promise<string | undefined> => {
    if (!clientId) return undefined;
    const c = await loadClients();
    const v = Object.hasOwn(c, name) ? c[name] : undefined;
    return v && v.clientId === clientId && typeof v.clientSecret === 'string' && v.clientSecret ? v.clientSecret : undefined;
  };
  /** 지금 정의의 clientId 와 기록의 clientId 가 다른가. 정의를 모르면 다르지 않다고 본다. */
  const clientChanged = async (name: string, rec: McpOAuthRecord): Promise<boolean> => {
    if (!deps.currentClientId) return false;
    const cur = await deps.currentClientId(name).catch(() => undefined);
    return cur !== undefined && cur !== rec.clientId;
  };

  async function load(): Promise<Store> {
    let raw: string;
    try { raw = await readFile(deps.storePath, 'utf8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    // 깨진 파일을 빈 표로 읽고 덮어쓰면 모든 인증이 사라진다 — 던진다.
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Store) : {};
  }
  /** 읽고-고치고-쓰기를 한 줄로 세운다 — 병렬 refresh 가 서로의 결과를 덮지 않게. */
  function update(fn: (s: Store) => void): Promise<Store> {
    const next = chain.then(async () => {
      const s = await load();
      fn(s);
      await mkdir(dirname(deps.storePath), { recursive: true, mode: 0o700 });
      const tmp = `${deps.storePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, deps.storePath);
      return s;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  async function getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await doFetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return isRecord(body) ? body : null;
    } catch { return null; }
  }

  /** 1·2단계 — 인가 서버 메타데이터와 scope. */
  async function discover(mcpUrl: string): Promise<{ as: Record<string, unknown>; scopes: string[] }> {
    const u = new URL(mcpUrl);
    let prmUrl: string | null = null;
    try {
      const res = await doFetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harkroom-operator', version: '1' } } }),
      });
      const www = res.headers.get('www-authenticate') ?? '';
      const m = /resource_metadata="([^"]+)"/.exec(www);
      if (m) prmUrl = m[1]!;
    } catch { /* 아래 well-known 으로 */ }
    const path = u.pathname === '/' ? '' : u.pathname;
    const prm = (prmUrl ? await getJson(prmUrl) : null)
      ?? await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`)
      ?? await getJson(`${u.origin}/.well-known/oauth-protected-resource`);
    const servers = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === 'string') : [];
    const issuer = new URL(servers[0] ?? u.origin);
    const ipath = issuer.pathname === '/' ? '' : issuer.pathname;
    const as = await getJson(`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`)
      ?? await getJson(`${issuer.origin}/.well-known/openid-configuration${ipath}`)
      ?? (ipath ? await getJson(`${issuer.origin}${ipath}/.well-known/openid-configuration`) : null);
    if (!as || typeof as.authorization_endpoint !== 'string' || typeof as.token_endpoint !== 'string') {
      throw new Error(`${mcpUrl} 의 인가 서버 메타데이터를 찾지 못했다 — 이 서버가 OAuth 를 쓰지 않거나 명세 밖이다`);
    }
    const scopes = prm && Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === 'string') : [];
    return { as, scopes };
  }

  async function register(as: Record<string, unknown>, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
    if (typeof as.registration_endpoint !== 'string') {
      throw new Error('이 인가 서버는 동적 클라이언트 등록을 받지 않는다 — 정의에 oauth.clientId 가 필요하다');
    }
    const res = await doFetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Harkroom', redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecord(body) || typeof body.client_id !== 'string') throw new Error(`클라이언트 등록 실패(${res.status})`);
    return { clientId: body.client_id, ...(typeof body.client_secret === 'string' ? { clientSecret: body.client_secret } : {}) };
  }

  async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok || !isRecord(body) || typeof body.access_token !== 'string') {
      const error = isRecord(body) && typeof body.error === 'string' ? body.error : `http_${res.status}`;
      return { ok: false, status: res.status, error };
    }
    return { ok: true, body };
  }

  const expiresAtOf = (body: Record<string, unknown>): number | undefined =>
    typeof body.expires_in === 'number' && body.expires_in > 0 ? now() + body.expires_in * 1000 : undefined;

  function closeFlow(name: string): void {
    const f = flows.get(name);
    if (!f) return;
    clearTimeout(f.timer);
    for (const s of f.servers) s.close();
    flows.delete(name);
  }

  /** 127.0.0.1 과 ::1 둘 다 — 브라우저가 localhost 를 어느 쪽으로 풀지 모른다. 바깥 인터페이스에는 열지 않는다. */
  async function listen(port: number, handler: Parameters<typeof createServer>[1]): Promise<{ servers: Server[]; port: number }> {
    const v4 = createServer(handler);
    const actual = await new Promise<number>((resolve, reject) => {
      v4.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE'
        ? new Error(`콜백 포트 ${port} 를 다른 프로그램이 쓰고 있다 — 다른 창(예: claude 의 /mcp)에서 같은 인증이 열려 있으면 닫고 다시 누른다`)
        : err));
      v4.listen(port, '127.0.0.1', () => resolve((v4.address() as { port: number }).port));
    });
    const servers = [v4];
    const v6 = createServer(handler);
    await new Promise<void>((resolve) => {
      v6.once('error', () => resolve()); // ::1 이 없는 머신도 있다
      v6.listen(actual, '::1', () => { servers.push(v6); resolve(); });
    });
    return { servers, port: actual };
  }

  async function refreshOne(name: string, rec: McpOAuthRecord, onReject = false): Promise<McpOAuthRecord | null> {
    const inflight = refreshing.get(name);
    if (inflight) return inflight;
    const p = (async () => {
      if (!rec.refreshToken) {
        await update((s) => { if (s[name]) s[name]!.status = 'expired'; });
        return null;
      }
      let r;
      try {
        // secret 은 지금 비밀 파일의 것을 먼저 — 인증 뒤에 넣거나 바꿔도 다음 refresh 부터 실린다.
        // 둘 다 없으면 PKCE 공개 클라이언트로 refresh 한다(Slack PKCE 앱).
        // 이름이 아니라 **기록의 clientId** 에 묶인 것만(security F1). DCR 로 받은 secret 은 기록에 있다.
        const secret = (await clientSecretFor(name, rec.clientId).catch(() => undefined)) ?? rec.clientSecret;
        r = await tokenRequest(rec.tokenEndpoint, {
          grant_type: 'refresh_token', refresh_token: rec.refreshToken, client_id: rec.clientId, resource: rec.resource,
          ...(secret ? { client_secret: secret } : {}),
        });
      } catch (err) {
        // 네트워크 실패는 거절이 아니다 — 들고 있는 토큰을 그대로 두고 다음에 다시 한다.
        deps.log(`MCP OAuth: ${name} refresh 실패(네트워크, 다시 시도한다): ${err instanceof Error ? err.message : String(err)}`);
        return rec.expiresAt !== undefined && rec.expiresAt <= now() ? null : rec;
      }
      if (!r.ok) {
        // 인가 서버가 거절했다(invalid_grant·회수·만료). 다시 인증하는 수밖에 없다.
        // Slack PKCE 앱의 refresh 토큰은 30일이면 끝난다 — 그때도 여기로 온다(expired = "다시 인증 필요").
        deps.log(`MCP OAuth: ${name} refresh 거절(${r.error}) — refresh 토큰이 만료(Slack PKCE 앱은 30일)됐거나 회수됐다. 데스크톱에서 다시 인증해야 한다`);
        await update((s) => { if (s[name]) s[name]!.status = 'expired'; });
        return null;
      }
      // 거절 표시는 새 토큰과 함께 지운다 — 그것은 옛 토큰의 사실이다.
      const { rejectedAt: _at, rejectedBy: _by, refreshedOnReject: _was, ...kept } = rec;
      const next: McpOAuthRecord = {
        ...kept,
        ...(onReject ? { refreshedOnReject: true } : {}),
        accessToken: r.body.access_token as string,
        // 회전하지 않는 서버는 새 refresh 토큰을 안 준다 — 있던 것을 그대로 쓴다.
        refreshToken: typeof r.body.refresh_token === 'string' ? r.body.refresh_token : rec.refreshToken,
        expiresAt: expiresAtOf(r.body),
        status: 'ok',
        updatedAt: now(),
      };
      await update((s) => { s[name] = next; });
      return next;
    })().finally(() => refreshing.delete(name));
    refreshing.set(name, p);
    return p;
  }

  const due = (rec: McpOAuthRecord) => rec.expiresAt !== undefined && rec.expiresAt - now() <= skew;
  const rejectCooldown = deps.rejectCooldownMs ?? 5 * 60_000;
  /** 이름별로 거절 보고가 refresh 를 당긴 마지막 시각. 메모리에만 둔다 — 재기동은 드물고 그때 한 번 더 당겨도 된다. */
  const lastRejectRefresh = new Map<string, number>();

  return {
    async start(name, definition) {
      closeFlow(name);
      const { as, scopes } = await discover(definition.url);
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const state = b64url(randomBytes(16));
      let redirectUri = '';
      const secret = await clientSecretFor(name, definition.oauth?.clientId);
      let client: { clientId: string; clientSecret?: string } | null = definition.oauth?.clientId
        ? { clientId: definition.oauth.clientId, ...(secret ? { clientSecret: secret } : {}) }
        : null;

      const flow: Flow = { url: definition.url, servers: [], timer: setTimeout(() => {}, 0), state: 'pending' };
      const fail = (error: string) => {
        flow.state = 'error'; flow.error = error;
        clearTimeout(flow.timer);
        for (const s of flow.servers) s.close();
        deps.log(`MCP OAuth: ${name} 실패 — ${error}`);
      };
      const { servers, port } = await listen(definition.oauth?.callbackPort ?? 0, (req, res) => {
        const u = new URL(req.url ?? '/', 'http://localhost');
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const page = (status: number, text: string) => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Harkroom</title><p style="font:16px system-ui;margin:3em">${text}</p>`);
        };
        if (u.searchParams.get('state') !== state) { page(400, '인증 요청이 맞지 않습니다. 앱에서 다시 시도하세요.'); return; }
        const code = u.searchParams.get('code');
        if (!code) { const e = u.searchParams.get('error') ?? 'no_code'; page(400, `인증이 거절됐습니다(${e}).`); fail(`인가 거절: ${e}`); return; }
        void (async () => {
          try {
            const r = await tokenRequest(as.token_endpoint as string, {
              grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client!.clientId,
              code_verifier: verifier, resource: definition.url,
              ...(client!.clientSecret ? { client_secret: client!.clientSecret } : {}),
            });
            if (!r.ok) { page(400, `토큰 교환에 실패했습니다(${r.error}).`); fail(`토큰 교환 실패: ${r.error}`); return; }
            const rec: McpOAuthRecord = {
              url: definition.url, clientId: client!.clientId, ...(client!.clientSecret ? { clientSecret: client!.clientSecret } : {}),
              tokenEndpoint: as.token_endpoint as string, resource: definition.url,
              accessToken: r.body.access_token as string,
              ...(typeof r.body.refresh_token === 'string' ? { refreshToken: r.body.refresh_token } : {}),
              expiresAt: expiresAtOf(r.body), status: 'ok', updatedAt: now(),
            };
            await update((s) => { s[name] = rec; });
            page(200, '인증됐습니다. 이 창을 닫고 Harkroom 으로 돌아가세요.');
            closeFlow(name);
            deps.log(`MCP OAuth: ${name} 인증됨`);
            await deps.onToken?.(name, { url: rec.url, accessToken: rec.accessToken });
          } catch (err) {
            page(500, '토큰을 저장하지 못했습니다.');
            fail(err instanceof Error ? err.message : String(err));
          }
        })();
      });
      flow.servers = servers;
      flow.timer = setTimeout(() => fail('시간 초과 — 브라우저에서 인증을 끝내지 않았다'), deps.flowTimeoutMs ?? 5 * 60_000);
      flow.timer.unref?.();
      flows.set(name, flow);
      redirectUri = `http://localhost:${port}/callback`;
      try {
        if (!client) client = await register(as, redirectUri);
      } catch (err) {
        closeFlow(name);
        throw err;
      }
      const auth = new URL(as.authorization_endpoint as string);
      const q = auth.searchParams;
      q.set('response_type', 'code');
      q.set('client_id', client.clientId);
      q.set('redirect_uri', redirectUri);
      q.set('code_challenge', challenge);
      q.set('code_challenge_method', 'S256');
      q.set('state', state);
      q.set('resource', definition.url);
      if (scopes.length) q.set('scope', scopes.join(' '));
      return { authUrl: auth.toString() };
    },

    async status(name, url, clientId) {
      const f = flows.get(name);
      if (f && f.url === url) return f.state === 'pending' ? { state: 'pending' } : { state: 'error', reason: f.error ?? '' };
      const rec = own(await load(), name);
      if (!rec || rec.url !== url) return { state: 'none' };
      if (clientId && rec.clientId !== clientId) return { state: 'none' };
      if (rec.status === 'expired') return { state: 'expired' };
      if (rec.status === 'rejected') {
        return { state: 'rejected', at: rec.rejectedAt ?? rec.updatedAt, ...(rec.rejectedBy ? { agentId: rec.rejectedBy } : {}) };
      }
      if (rec.expiresAt !== undefined && rec.expiresAt <= now() && !rec.refreshToken) return { state: 'expired' };
      return { state: 'ok', ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}) };
    },

    async tokensFor(defs) {
      const store = await load();
      const tokens: Record<string, string> = {};
      const expired: string[] = [];
      for (const [name, def] of Object.entries(defs)) {
        const rec = own(store, name);
        if (!rec || !def.url || rec.url !== def.url) continue;
        // 다른 클라이언트로 받은 토큰 — 굽지 않고 "인증 필요"로 낸다(클라이언트를 갈아탄 뒤 재인증 1회).
        if (def.clientId && rec.clientId !== def.clientId) { expired.push(name); continue; }
        // 거절된 토큰은 구워 봐야 또 401 이다 — 만료와 같이 "인증 필요"로 낸다.
        if (rec.status !== 'ok') { expired.push(name); continue; }
        const live = due(rec) ? await refreshOne(name, rec) : rec;
        if (live) tokens[name] = live.accessToken; else expired.push(name);
      }
      return { tokens, expired };
    },

    async refreshDue() {
      const store = await load();
      const out: Record<string, { url: string; accessToken: string }> = {};
      for (const [name, rec] of Object.entries(store)) {
        if (rec.status !== 'ok' || !due(rec)) continue;
        // 다른 클라이언트의 토큰은 돌리지 않는다 — 그 클라이언트를 계속 쓰게 된다(security F2).
        if (await clientChanged(name, rec)) continue;
        const next = await refreshOne(name, rec);
        if (next && next.accessToken !== rec.accessToken) out[name] = { url: next.url, accessToken: next.accessToken };
      }
      return out;
    },

    async reportRejected(name, report) {
      const rec = own(await load(), name);
      if (!rec) return { action: 'ignored', reason: 'unknown' };
      if (rec.status !== 'ok') return { action: 'ignored', reason: 'not_ok' };
      if (await clientChanged(name, rec)) return { action: 'ignored', reason: 'client_changed' };
      if (!(report.turnStartedAtMs >= rec.updatedAt)) return { action: 'ignored', reason: 'stale' };
      if (rec.refreshedOnReject) {
        // 거절로 당겨 받은 토큰도 거절됐다 — refresh 로는 안 낫는다. 사람이 다시 인증해야 한다.
        const at = now();
        await update((s) => {
          const cur = s[name];
          if (cur && cur.accessToken === rec.accessToken) s[name] = { ...cur, status: 'rejected', rejectedAt: at, rejectedBy: report.agentId };
        });
        deps.log(`MCP OAuth: ${name} 새 토큰도 MCP 서버가 거절했다 — 데스크톱에서 다시 인증해야 한다 (agent=${report.agentId})`);
        return { action: 'rejected' };
      }
      // refresh 토큰이 없으면 당길 것이 없다. 보고만으로 `expired` 를 붙이지 않는다(위의 원칙).
      if (!rec.refreshToken) return { action: 'ignored', reason: 'no_refresh_token' };
      const last = lastRejectRefresh.get(name);
      if (last !== undefined && now() - last < rejectCooldown) return { action: 'ignored', reason: 'cooldown' };
      lastRejectRefresh.set(name, now());
      const next = await refreshOne(name, rec, true);
      if (!next) return { action: 'expired' };
      // 네트워크 실패는 들고 있던 것을 그대로 돌려준다 — 바뀐 것이 없다.
      if (next.accessToken === rec.accessToken) return { action: 'ignored', reason: 'network' };
      deps.log(`MCP OAuth: ${name} MCP 서버 거절 보고로 토큰을 새로 받았다 (agent=${report.agentId})`);
      return { action: 'refreshed', url: next.url, accessToken: next.accessToken };
    },

    async setClientSecret(name, clientId, secret) {
      if (secret !== null && !clientId) throw new Error('client secret 은 clientId 와 함께만 넣는다');
      const next = clientsChain.then(async () => {
        const c = await loadClients();
        if (secret === null) { if (!Object.hasOwn(c, name)) return; delete c[name]; }
        else c[name] = { clientId: clientId!, clientSecret: secret };
        await mkdir(dirname(clientsPath), { recursive: true, mode: 0o700 });
        const tmp = `${clientsPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        await writeFile(tmp, `${JSON.stringify(c, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, clientsPath);
      });
      clientsChain = next.catch(() => undefined);
      await next;
      deps.log(`MCP OAuth: ${name} client secret ${secret === null ? '지움' : '넣음'}`);
    },

    async hasClientSecret(name, clientId) {
      const c = await loadClients();
      const v = Object.hasOwn(c, name) ? c[name] : undefined;
      if (!v || typeof v.clientSecret !== 'string' || !v.clientSecret) return false;
      return clientId === undefined || v.clientId === clientId;
    },

    async forget(name) {
      closeFlow(name);
      await update((s) => { delete s[name]; });
    },

    close() { for (const name of [...flows.keys()]) closeFlow(name); },
  };
}
