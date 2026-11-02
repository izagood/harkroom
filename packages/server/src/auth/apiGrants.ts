import type { Pool } from 'pg';
import { API_METHODS, CONNECTOR_SCOPE_RE, connectorScope, type ApiAuthKind, type ApiGrantLimits, type ApiMethod, type ApiTokenForm } from '@harkroom/shared';

/**
 * 외부 API 권한(`api.call`) 판정 — 설계 스레드 07519d86(채널 a42006a1), C안 P2.
 *
 * **이것은 실수 방지 장치이지 경계가 아니다**(머지와 같다, `docs/agent-merge.md`). 같은 사용자 계정으로 도는
 * 에이전트는 마운트된 파일이나 Keychain 에 닿는다. 이 판정이 막는 것은 "사람이 허락하지 않은 대상·메서드·경로로
 * 키가 붙어 나가는 것"이다.
 *
 * 판정은 **쓰는 순간 사슬을 거슬러 올라가** 한다(098). 부모를 거두면 cascade 로 아래가 지워지지만, 만료·정지는
 * 지우지 않으므로 여기서 막아야 한다. 사슬의 모든 줄이:
 * - 같은 capability·scope 이고, 만료되지 않았고, 정지되지 않았다
 * - 루트(부모 없음)는 **사람**이 줬고, 그 사람이 연결의 주인이며(E1), 지금 이 에이전트의 소유자다(E1 — 소유가 바뀌면 끊긴다)
 * 그리고 이 줄의 limits 가 요청 메서드·경로를 덮어야 한다.
 */

export type ApiDenial =
  | 'no_connector' | 'no_secret' | 'not_granted' | 'expired' | 'suspended' | 'chain_broken'
  | 'method_not_allowed' | 'path_not_allowed' | 'bad_path';

export interface ApiGrantHit {
  grantId: string; rootGrantedBy: string; connectorId: string; connectorName: string;
  baseUrl: string; authKind: ApiAuthKind; authHeader: string | null; secretId: string | null;
  limits: ApiGrantLimits;
  /** 토큰 교환(156) — `token_exchange` 일 때만. */
  tokenUrl: string | null; tokenForm: ApiTokenForm | null;
  /** 실제로 보낼 경로(`wirePath`, security 조건 7). 판정은 이 값으로 했다. */
  path: string;
}

const WRITE: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const hasWriteMethod = (methods: readonly string[]): boolean => methods.some((m) => WRITE.has(m));

/**
 * 연결 기본 주소를 origin 으로 정규화한다. https 만, 사용자 정보·질의·조각·경로 없음. 경로를 받지 않는 이유:
 * 경로 범위는 grant 의 `pathPrefix` 하나가 정한다 — 두 곳에서 정하면 어느 쪽이 이기는지 사람이 헷갈린다.
 */
export function normalizeBaseUrl(input: string): string | null {
  const u = parseHttpsUrl(input);
  if (!u) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.origin;
}

/**
 * 연결 주소·토큰 교환 주소가 공통으로 지키는 모양(security 조건 1): https 만, 사용자 정보·질의·조각 없음, 호스트 있음.
 * 두 주소 모두 키를 받는 곳이라 같은 함수로 잰다.
 */
function parseHttpsUrl(input: string): URL | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (!u.hostname) return null;
  return u;
}

/**
 * 토큰 교환 주소(156). 기본 주소와 같은 검사에 **경로를 허용**한다(토큰 엔드포인트는 보통 경로가 있다). 경로도 안전한
 * 모양이어야 한다. 출처는 연결 주인이 정한다(security S1 — base_url 과 같은 신뢰 수준).
 */
export function normalizeTokenUrl(input: string): string | null {
  // URL 짓기가 `%2e%2e`·`..` 를 풀어 다른 경로로 바꾸기 전에 원문에서 거른다 — 사람이 본 주소와 키가 가는 주소가 같아야 한다.
  if (/%2e|%2f|%5c|%25/i.test(input) || /\/\.\.?(\/|$)/.test(input)) return null;
  const u = parseHttpsUrl(input);
  if (!u) return null;
  const path = u.pathname || '/';
  if (!safePath(path) || /%2f/i.test(path)) return null;
  const out = `${u.origin}${path === '/' ? '' : path}`;
  return out.length <= 500 ? out : null;
}

/** `%2F` 를 `/` 로 푼 경로(질의 앞만). 대상 서버·프록시가 이렇게 풀 수 있으므로 판정은 이 꼴로도 한 번 더 한다. */
export const decodeSlashes = (path: string): string => {
  const i = path.indexOf('?');
  const p = i < 0 ? path : path.slice(0, i);
  return p.replace(/%2f/gi, '/') + (i < 0 ? '' : path.slice(i));
};

/**
 * 실제로 보낼 경로(security 조건 7) — `new URL(path, baseUrl)` 뒤의 pathname + 질의. 판정은 입력 글자가 아니라 이 값에
 * 대해 하고, 오퍼레이터는 이 값을 그대로 보낸다(두 쪽의 인코딩 차이를 없앤다). origin 이 바뀌면 null.
 */
export function wirePath(baseUrl: string, path: string): string | null {
  let u: URL;
  try { u = new URL(path, baseUrl); } catch { return null; }
  if (u.origin !== new URL(baseUrl).origin || u.hash) return null;
  return `${u.pathname}${u.search}`;
}

/**
 * 요청 경로가 안전한 모양인가. `..`·인코딩된 점·역슬래시·`//` 로 시작하는 것은 접두 검사를 속일 수 있으므로
 * 처음부터 받지 않는다(`/api/../admin` 이 `/api/` 접두를 지나는 것을 막는다).
 *
 * `%2F`(인코딩된 `/`)는 받는다(156 — 모델 이름처럼 `/` 가 든 값을 한 마디로 보내는 API 가 있다). 대신 **두 번 잰다**
 * (security S3): 원문 마디와, `%2F` 를 `/` 로 푼 마디 둘 다 `.`·`..` 가 없어야 하고, 푼 쪽에 빈 마디(`//`)가 생기면
 * 거절한다(조건 8 — 서버·프록시마다 `//` 를 다르게 정규화한다). 접두는 `pathCovered` 가 두 꼴 모두에 대해 본다.
 */
export function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (/[\\\s#]/.test(path)) return false;
  const p = path.split('?')[0] ?? '';
  // `;` — `/api/..;/admin` 을 Tomcat·Spring 계열이 상위로 푼다. `%25` — 이중 인코딩(`%252e%252e`)이 뒤에서 풀린다.
  if (/%2e|%5c|%25/i.test(p) || p.includes(';')) return false;
  const dotSeg = (seg: string): boolean => seg === '..' || seg === '.';
  if (p.split('/').some(dotSeg)) return false;
  if (!/%2f/i.test(p)) return true;
  const decoded = decodeSlashes(p);
  const segs = decoded.split('/').slice(1);
  // 끝의 빈 마디는 원문도 `/` 로 끝날 때만 받는다(`/x%2F` 처럼 인코딩이 만든 빈 마디는 거절).
  const last = segs.length - 1;
  return !segs.some((seg, i) => dotSeg(seg) || (seg === '' && !(i === last && p.endsWith('/'))));
}

/**
 * 경로가 접두 안에 드는가 — **마디 경계**를 본다. 접두가 `/` 로 끝나지 않으면 `/api` 는 `/api`·`/api/…` 만 받고
 * `/api-admin`·`/apikeys` 는 받지 않는다(security F2①). 질의는 떼고 잰다.
 */
export function pathCovered(path: string, prefix: string): boolean {
  // `%2F` 가 든 경로는 원문과 푼 꼴 **둘 다** 접두 안이어야 한다(security S3) — `/api%2Fx` 는 `/api/` 를 지나지 못한다.
  if (/%2f/i.test(path.split('?')[0] ?? '') && !pathCovered(decodeSlashes(path), prefix)) return false;
  const p = path.split('?')[0] ?? '';
  if (prefix.endsWith('/')) return p.startsWith(prefix);
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** grant 의 limits 모양: 메서드는 연결이 허용한 것의 부분집합(비지 않음), 경로 접두는 안전한 경로. */
export function parseLimits(raw: unknown, connectorMethods: readonly string[]): ApiGrantLimits | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'limits 가 필요하다 — {methods, pathPrefix}' };
  const { methods, pathPrefix, ...extra } = raw as Record<string, unknown>;
  if (Object.keys(extra).length) return { error: `받지 않는 limits 칸: ${Object.keys(extra).join(', ')}` };
  if (!Array.isArray(methods) || methods.length === 0) return { error: 'limits.methods 가 비었다' };
  const ms = [...new Set(methods.map(String))];
  if (!ms.every((m) => (API_METHODS as readonly string[]).includes(m))) return { error: 'limits.methods 에 모르는 메서드가 있다' };
  if (!ms.every((m) => connectorMethods.includes(m))) return { error: '연결이 허용하지 않은 메서드다' };
  if (typeof pathPrefix !== 'string' || !safePath(pathPrefix) || pathPrefix.includes('?') || pathPrefix.includes('%')) return { error: 'limits.pathPrefix 는 / 로 시작하는 안전한 경로다' };
  return { methods: ms as ApiMethod[], pathPrefix };
}

interface ChainRow {
  id: string; parentGrantId: string | null; accountId: string; capability: string; scope: string;
  grantedBy: string; granterKind: string | null; expired: boolean; suspended: boolean; depth: number;
  limits: ApiGrantLimits | null; delegateDepth: number; writeNeedsHumanCause: boolean;
}

/**
 * 에이전트가 연결 `connectorId` 로 `method path` 를 불러도 되는가. P3 래퍼(오퍼레이터)가 턴 임대와 함께 묻는다.
 * 통과하면 오퍼레이터가 키를 붙일 정보(기본 주소·인증 형식·비밀 id)를 함께 준다 — 키 값은 아니다.
 */
export async function apiGrantFor(
  pool: Pool, args: { agentId: string; connectorId: string; method: string; path: string },
): Promise<{ ok: true; hit: ApiGrantHit } | { ok: false; code: ApiDenial }> {
  if (!safePath(args.path)) return { ok: false, code: 'bad_path' };
  const c = (await pool.query(
    `select id, name, owner_account_id as "ownerAccountId", base_url as "baseUrl", auth_kind as "authKind",
            auth_header as "authHeader", secret_id as "secretId", methods,
            token_url as "tokenUrl", token_form as "tokenForm"
       from api_connector where id = $1`, [args.connectorId])).rows[0] as
    { id: string; name: string; ownerAccountId: string; baseUrl: string; authKind: ApiAuthKind; authHeader: string | null; secretId: string | null; methods: string[]; tokenUrl: string | null; tokenForm: ApiTokenForm | null } | undefined;
  if (!c) return { ok: false, code: 'no_connector' };
  // 판정은 실제로 보낼 경로로 한다(security 조건 7). URL 짓기가 바꾼 꼴도 다시 안전해야 한다.
  const wire = wirePath(c.baseUrl, args.path);
  if (!wire || !safePath(wire)) return { ok: false, code: 'bad_path' };
  const scope = connectorScope(c.id);

  const leaf = (await pool.query(
    `select id, limits from account_grant where account_id = $1 and capability = 'api.call' and scope = $2`,
    [args.agentId, scope])).rows[0] as { id: string; limits: ApiGrantLimits | null } | undefined;
  if (!leaf) return { ok: false, code: 'not_granted' };

  // 사슬: 이 줄에서 부모를 따라 루트까지. 깊이 상한(2단 위임 + 루트 = 3줄)을 넘는 사슬은 잘못 만든 것이다.
  const chain = (await pool.query(
    `with recursive up as (
       select g.id, g.parent_grant_id, g.account_id, g.capability, g.scope, g.granted_by, g.expires_at, g.suspended_at,
              g.limits, g.delegate_depth, g.write_needs_human_cause, 0 as depth
         from account_grant g where g.id = $1
       union all
       select p.id, p.parent_grant_id, p.account_id, p.capability, p.scope, p.granted_by, p.expires_at, p.suspended_at,
              p.limits, p.delegate_depth, p.write_needs_human_cause, up.depth + 1
         from account_grant p join up on p.id = up.parent_grant_id
        where up.depth < 5
     )
     select up.id, up.parent_grant_id as "parentGrantId", up.account_id as "accountId", up.capability, up.scope,
            up.granted_by as "grantedBy", a.kind as "granterKind",
            (up.expires_at is not null and up.expires_at <= now()) as expired,
            (up.suspended_at is not null) as suspended, up.depth,
            up.limits, up.delegate_depth as "delegateDepth", up.write_needs_human_cause as "writeNeedsHumanCause"
       from up left join account a on a.id = up.granted_by
      order by up.depth`, [leaf.id])).rows as ChainRow[];

  const root = chain[chain.length - 1];
  if (!root || root.parentGrantId !== null || chain.length > 3) return { ok: false, code: 'chain_broken' };
  if (chain.some((g) => g.capability !== 'api.call' || g.scope !== scope)) return { ok: false, code: 'chain_broken' };
  if (root.granterKind !== 'human' || root.grantedBy !== c.ownerAccountId) return { ok: false, code: 'chain_broken' };
  // 이웃한 두 줄마다(security F1): 위임된 줄은 부모 줄의 받은 쪽이 준 것이어야 하고, **지금의** 부모 범위 안이어야
  // 한다. 사람이 부모를 좁혀 다시 주면(upsert — 줄 id 는 그대로) 자식이 넓은 범위를 들고 남는다 — 여기서 막는다.
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i]!; const parent = chain[i + 1]!;
    if (child.grantedBy !== parent.accountId) return { ok: false, code: 'chain_broken' };
    if (!child.limits || !parent.limits) return { ok: false, code: 'chain_broken' };
    if (!child.limits.methods.every((m) => parent.limits!.methods.includes(m))) return { ok: false, code: 'chain_broken' };
    if (!pathCovered(child.limits.pathPrefix, parent.limits.pathPrefix)) return { ok: false, code: 'chain_broken' };
    if (parent.delegateDepth < 1 || child.delegateDepth > parent.delegateDepth - 1) return { ok: false, code: 'chain_broken' };
    // 「쓰기는 사람 글 턴만」은 아래로 물려야 한다 — 위임으로 그 칸을 끈 자식이 쓰기 관문을 비켜 가지 못한다(security L3, P5).
    if (parent.writeNeedsHumanCause && !child.writeNeedsHumanCause) return { ok: false, code: 'chain_broken' };
  }
  // E1: 사슬 위 모든 에이전트가 지금도 루트 사람의 것이어야 한다.
  const owners = (await pool.query(
    `select account_id as "accountId", owner_account_id as "ownerAccountId" from agent_config where account_id = any($1::uuid[])`,
    [chain.map((g) => g.accountId)])).rows as { accountId: string; ownerAccountId: string | null }[];
  if (owners.length !== chain.length || owners.some((o) => o.ownerAccountId !== root.grantedBy)) return { ok: false, code: 'chain_broken' };
  if (chain.some((g) => g.expired)) return { ok: false, code: 'expired' };
  if (chain.some((g) => g.suspended)) return { ok: false, code: 'suspended' };

  const limits = leaf.limits;
  if (!limits) return { ok: false, code: 'chain_broken' };
  if (!limits.methods.includes(args.method as ApiMethod) || !c.methods.includes(args.method)) return { ok: false, code: 'method_not_allowed' };
  if (!pathCovered(args.path, limits.pathPrefix) || !pathCovered(wire, limits.pathPrefix)) return { ok: false, code: 'path_not_allowed' };
  if (c.authKind !== 'none' && !c.secretId) return { ok: false, code: 'no_secret' };

  return {
    ok: true,
    hit: {
      grantId: leaf.id, rootGrantedBy: root.grantedBy, connectorId: c.id, connectorName: c.name,
      baseUrl: c.baseUrl, authKind: c.authKind, authHeader: c.authHeader, secretId: c.secretId, limits,
      tokenUrl: c.authKind === 'token_exchange' ? c.tokenUrl : null, tokenForm: c.authKind === 'token_exchange' ? c.tokenForm : null, path: wire,
    },
  };
}

export const isConnectorScope = (scope: string): boolean => CONNECTOR_SCOPE_RE.test(scope);
