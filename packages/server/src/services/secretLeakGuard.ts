import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { actorOf, recordAudit } from '../audit.js';
import type { SecretKeyring } from './secretKeyring.js';

/**
 * 본문 거절(D5, 비밀 보관소 PR 2b). 에이전트가 쓰는 글(발화·기억·스킬·첨부·그 밖의 모든 MCP 인자와
 * REST 본문)에 **그 에이전트가 grant 받은 비밀의 값**이 들어 있으면 거절한다. 계획·검토: 스레드 bc98df3a.
 *
 * - 대상 비밀은 이번 턴에 받은 것만이 아니라 **grant 가 걸린 것 전부**다 — 정지·만료된 grant 도 넣는다.
 *   지난 턴의 transcript·기억에서 값이 다시 올라올 수 있고, 정지됐다고 값이 덜 비밀이 되지는 않는다.
 * - 형태: 평문, URL 인코딩, base64(표준·패딩 없음·url-safe). 파일 비밀은 줄 단위로도 본다(PEM 한 줄을
 *   옮겨 적는 경우). **8자 미만은 보지 않는다** — 짧은 값은 정상 글에 우연히 나온다.
 * - 거절은 **고정 문장**이다. 어느 비밀인지·어디가 걸렸는지 되비추지 않는다 — 되비추면 그 오류가
 *   그대로 문맥에 실린다. 누가 무엇을 막혔는지는 감사와 access_log(소유자 화면의 "회전 권장")에 남는다.
 * - 사람 글은 여기서 보지 않는다. 사람에게는 보내기 전 경고가 맞다(desktop, PR 5) — 서버에서 막으면
 *   사람 자신의 정당한 글을 잃고, 보낸 뒤 경고는 이미 늦다.
 */
export interface LeakHit { id: string; name: string }

export interface SecretLeakGuard {
  findInTexts(agentId: string, texts: readonly string[]): Promise<LeakHit[]>;
  findInBytes(agentId: string, bytes: Buffer): Promise<LeakHit[]>;
  /** 거절을 남긴다: access_log(비밀마다, reason='leak_blocked') + 감사 한 줄. */
  record(req: FastifyRequest | null, agentId: string, operatorId: string | null, hits: LeakHit[], surface: string): Promise<void>;
}

export const LEAK_MIN_CHARS = 8;
/** 파일 비밀의 줄 단위 검사에서 이보다 짧은 줄은 보지 않는다(빈 줄·`-----END …` 같은 공통 줄 제외용). */
const LINE_MIN_CHARS = 16;

export const SECRET_IN_BODY = {
  code: 'secret_in_body',
  message: 'refused: the content contains the value of a secret you were granted. Do not write secret values; refer to the secret by name.',
} as const;

/** 한 값에서 찾을 바늘들. 바이트 바늘(이진 첨부용)과 글자 바늘을 함께 만든다. */
export function needlesFor(value: Buffer): string[] {
  // 하한은 **값 자체**에 건다 — 짧은 값의 base64 는 8자를 넘겨도 정상 글에 우연히 나올 만큼 짧다.
  if (value.length < LEAK_MIN_CHARS) return [];
  const out = new Set<string>();
  const add = (s: string) => { if (s.length >= LEAK_MIN_CHARS) out.add(s); };
  const b64 = value.toString('base64');
  add(b64);
  add(b64.replace(/=+$/, ''));
  add(value.toString('base64url'));
  const text = value.toString('utf8');
  // 잘못된 UTF-8 이면 대체 문자가 섞인다 — 그 문자열은 어디에도 그대로 나오지 않으니 평문 바늘로 쓰지 않는다.
  if (Buffer.from(text, 'utf8').equals(value)) {
    add(text);
    const trimmed = text.trim();
    add(trimmed);
    try { add(encodeURIComponent(trimmed)); } catch { /* 짝 없는 서로게이트 — 건너뛴다 */ }
    if (trimmed.includes('\n')) {
      for (const line of trimmed.split(/\r?\n/)) {
        const l = line.trim();
        if (l.length >= LINE_MIN_CHARS) out.add(l);
      }
    }
  }
  return [...out];
}

/** JSON 같은 값에서 문자열을 전부 모은다(키도 포함 — 값을 키 자리에 숨기는 길을 막는다). */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.push(k); collectStrings(v, out, depth + 1); }
  }
  return out;
}

export function createSecretLeakGuard(pool: Pool, keyring: SecretKeyring | null): SecretLeakGuard | null {
  if (!keyring) return null;

  /** grant 가 걸린 비밀의 현재 값마다 바늘들. 쓰기마다 새로 읽는다 — 부여·회수·값 교체가 곧바로 반영된다. */
  const needles = async (agentId: string): Promise<{ hit: LeakHit; needles: string[]; raw: Buffer }[]> => {
    const r = await pool.query(
      `select distinct s.id, s.name, s.kind, v.version, v.sealed
         from secret_grant g join secret s on s.id = g.secret_id
         join secret_version v on v.secret_id = s.id and v.revoked_at is null and v.sealed is not null
        where g.agent_id = $1`, [agentId]);
    const out: { hit: LeakHit; needles: string[]; raw: Buffer }[] = [];
    for (const row of r.rows as { id: string; name: string; kind: 'text' | 'file'; version: number; sealed: string }[]) {
      const value = keyring.open(row.sealed, { secretId: row.id, version: row.version, kind: row.kind });
      if (!value) continue;
      out.push({ hit: { id: row.id, name: row.name }, needles: needlesFor(value), raw: value });
    }
    return out;
  };

  return {
    async findInTexts(agentId, texts) {
      const hay = texts.filter((t) => t.length >= LEAK_MIN_CHARS);
      if (!hay.length) return [];
      const secrets = await needles(agentId);
      return secrets.filter((s) => s.needles.some((n) => hay.some((h) => h.includes(n)))).map((s) => s.hit);
    },
    async findInBytes(agentId, bytes) {
      if (bytes.length < LEAK_MIN_CHARS) return [];
      const secrets = await needles(agentId);
      return secrets.filter((s) =>
        (s.raw.length >= LEAK_MIN_CHARS && bytes.includes(s.raw))
        || s.needles.some((n) => bytes.includes(Buffer.from(n, 'utf8')))).map((s) => s.hit);
    },
    async record(req, agentId, operatorId, hits, surface) {
      for (const h of hits) {
        await pool.query(
          `insert into secret_access_log (secret_id, secret_name, agent_id, operator_id, result, reason)
           values ($1, $2, $3, $4, 'denied', 'leak_blocked')`, [h.id, h.name, agentId, operatorId]);
      }
      await recordAudit(pool, {
        action: 'secret.leak.blocked',
        ...(req ? actorOf(req) : { actorId: agentId, actorHandle: null }),
        target: agentId,
        // 이름·id·표면만 — 값도, 걸린 글도 남기지 않는다.
        detail: { surface, secrets: hits.map((h) => ({ id: h.id, name: h.name })) },
      }, req ?? undefined);
    },
  };
}

/**
 * REST 쪽 관문. 에이전트의 쓰기(POST·PUT·PATCH) JSON 본문을 본다. `/mcp` 는 건너뛴다 — 도구 하나하나에서
 * 같은 검사를 하고, 거기서는 MCP 오류 모양으로 답할 수 있다(`mcpPlugin.ts`). 첨부(multipart)는 본문이
 * 여기 없으므로 업로드 라우트가 저장한 바이트를 본다.
 */
export function leakGuardHook(guard: SecretLeakGuard) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.account?.kind !== 'agent') return;
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') return;
    if (req.url === '/mcp' || req.url.startsWith('/mcp?')) return;
    // 문자열 본문(`text/plain` — fastify 기본 파서가 문자열로 준다)도 본다(security N1).
    if (req.body === undefined || req.body === null || (typeof req.body !== 'object' && typeof req.body !== 'string')) return;
    const hits = await guard.findInTexts(req.account.id, collectStrings(req.body));
    if (!hits.length) return;
    await guard.record(req, req.account.id, req.operator?.id ?? null, hits, `rest:${req.method} ${req.routeOptions.url ?? req.url}`);
    await reply.code(400).send({ error: SECRET_IN_BODY });
  };
}
