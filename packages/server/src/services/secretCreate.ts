import { createHash, generateKeyPairSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { recordAudit } from '../audit.js';
import { postMessage } from './messages.js';
import { scanWrite } from './contentScan.js';
import type { SecretKeyring } from './secretKeyring.js';
import { needlesFor } from './secretLeakGuard.js';
import { RevealLimiter } from './secretAccess.js';

/**
 * 에이전트가 비밀을 만든다·들여온다·회전한다(102). 계획 harkroom 스레드 1a08d0cf, security 조건부 OK.
 *
 * **판정은 전부 여기(서버)다(F1).** 러너 링크는 `/agent/*` 를 경로 제한 없이 넘기고 같은 uid 에서는 임대 토큰도
 * 읽히므로, 모델 셸이 이 REST 를 직접 부를 수 있다. 오퍼레이터의 경로 검사(워크스페이스 안·심링크 거절)는
 * 실수 방지 장치일 뿐이고, capability·소유자 원인·상한·채널 고정 부여·회전 대상·마운트된 값 거절은 서버가 본다.
 *
 * 값은 모델을 거치지 않는다: generate 는 여기서 만들어 곧바로 봉한다. import 의 값은 오퍼레이터가 턴 워크스페이스의
 * 파일에서 읽어 보낸 것이다. 응답·감사·오류 어디에도 값이나 그 해시를 싣지 않는다(L4).
 */

export const AGENT_SECRET_MAX = 20;
export const AGENT_SECRET_DEFAULT_DAYS = 90;
export const AGENT_SECRET_MAX_DAYS = 365;
export const SECRET_CREATE_MAX_BYTES = 64 * 1024;

export const GENERATE_TYPES = ['password', 'token_hex', 'token_base64url', 'ssh_ed25519'] as const;
export type GenerateType = typeof GENERATE_TYPES[number];
export type GenerateSpec = { type: GenerateType; length?: number };

export type CreateSource =
  | { generate: GenerateSpec }
  | { import: { kind: 'text' | 'file'; filename: string | null; value: Buffer } };

export type CreateDenial =
  | 'lease_invalid' | 'not_granted' | 'cause_not_owner' | 'rate_limited' | 'too_many'
  | 'bad_value' | 'bad_length' | 'value_is_mounted' | 'secret_in_description' | 'name_taken'
  | 'not_found' | 'adopted_by_owner' | 'grant_suspended' | 'secret_expired' | 'kind_mismatch' | 'owner_inactive';

export type CreateResult =
  | { ok: true; secretId: string; name: string; kind: 'text' | 'file'; version: number; publicKey: string | null; expiresAt: string | null }
  | { ok: false; code: CreateDenial };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

// ─── 값 만들기 ─────────────────────────────────────────────────────────────────────────

const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+-.=@^_~';

/** 길이 범위: password 는 글자 수, token_* 는 바이트 수. ssh 는 길이를 받지 않는다. */
const LENGTH: Record<Exclude<GenerateType, 'ssh_ed25519'>, { min: number; max: number; def: number }> = {
  password: { min: 16, max: 128, def: 32 },
  token_hex: { min: 16, max: 64, def: 32 },
  token_base64url: { min: 16, max: 64, def: 32 },
};

const sshString = (b: Buffer | string): Buffer => {
  const body = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
};
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** ed25519 키 쌍을 OpenSSH 형식(`openssh-key-v1`, 암호 없음)으로. 공개키 줄의 주석은 비밀 이름이다. */
export function sshEd25519(comment: string): { privateKey: Buffer; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // DER 의 끝 32 바이트가 원시 키다(SPKI·PKCS8 의 ed25519 모양은 고정 길이 머리 + 32 바이트).
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad: number[] = [];
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i);
  priv = Buffer.concat([priv, Buffer.from(pad)]);
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'), sshString('none'), sshString('none'), sshString(''), u32(1),
    sshString(pubBlob), sshString(priv),
  ]);
  const b64 = blob.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '');
  return {
    privateKey: Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`, 'utf8'),
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
  };
}

export function generateValue(spec: GenerateSpec, name: string):
  | { ok: true; kind: 'text' | 'file'; filename: string | null; value: Buffer; publicKey: string | null }
  | { ok: false; code: 'bad_length' } {
  if (spec.type === 'ssh_ed25519') {
    if (spec.length !== undefined) return { ok: false, code: 'bad_length' };
    const k = sshEd25519(`harkroom:${name}`);
    return { ok: true, kind: 'file', filename: 'id_ed25519', value: k.privateKey, publicKey: k.publicKey };
  }
  const r = LENGTH[spec.type];
  const n = spec.length ?? r.def;
  if (!Number.isInteger(n) || n < r.min || n > r.max) return { ok: false, code: 'bad_length' };
  let text: string;
  if (spec.type === 'password') {
    text = Array.from({ length: n }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
  } else {
    const bytes = randomBytes(n);
    text = spec.type === 'token_hex' ? bytes.toString('hex') : bytes.toString('base64url');
  }
  return { ok: true, kind: 'text', filename: null, value: Buffer.from(text, 'utf8'), publicKey: null };
}

// ─── 판정 ─────────────────────────────────────────────────────────────────────────────

interface CreateLease {
  id: string; agentId: string; operatorId: string; channelId: string; threadRootId: string; causeMessageId: string;
  expired: boolean; ended: boolean; ownerId: string | null; ownerInactive: boolean;
  causeAuthorId: string | null; causeKind: string | null;
  causeAskAuthorId: string | null; askAnsweredBy: string | null; askAnswererKind: string | null;
}

async function readCreateLease(pool: Pool, leaseId: string, token: string, now: Date): Promise<CreateLease | undefined> {
  return (await pool.query(
    `select l.id, l.agent_id as "agentId", l.operator_id as "operatorId", l.channel_id as "channelId",
            l.thread_root_id as "threadRootId", l.cause_message_id as "causeMessageId",
            l.expires_at <= $3 as expired, l.ended_at is not null as ended,
            c.owner_account_id as "ownerId",
            coalesce(o.deleted_at is not null or o.disabled_at is not null, true) as "ownerInactive",
            m.author_id as "causeAuthorId", a.kind as "causeKind",
            -- 거울·일괄로 매긴 답(answeredVia)은 사람이 띄운 턴이 아니다(security F1, #1280 — mergeGrants.readLease 와 같다).
            case when m.meta ? 'ask' and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null
                 then m.author_id end as "causeAskAuthorId",
            m.meta->'ask'->>'answeredBy' as "askAnsweredBy", ans.kind as "askAnswererKind"
       from secret_turn_lease l
       left join agent_config c on c.account_id = l.agent_id
       left join account o on o.id = c.owner_account_id
       left join message m on m.id = l.cause_message_id
       left join account a on a.id = m.author_id
       left join account ans on ans.id = nullif(m.meta->'ask'->>'answeredBy', '')::uuid
      where l.id = $1 and l.token_hash = $2`,
    [leaseId, sha256(token), now])).rows[0] as CreateLease | undefined;
}

/**
 * F2: 그 턴을 띄운 글이 **이 에이전트의 소유자** 글이어야 한다. 채널의 아무 사람이나 남의 에이전트를 불러 그 소유자
 * 이름으로 비밀을 쌓지 못하게. 소유자가 이 에이전트 자신의 선택 카드에 답한 턴도 인정한다(`causeByHuman` 과 같은 길).
 */
export function causeByOwner(l: Pick<CreateLease, 'agentId' | 'ownerId' | 'causeAuthorId' | 'causeKind' | 'causeAskAuthorId' | 'askAnsweredBy' | 'askAnswererKind'>): boolean {
  if (!l.ownerId) return false;
  if (l.causeKind === 'human' && l.causeAuthorId === l.ownerId) return true;
  return l.causeAskAuthorId === l.agentId && l.askAnsweredBy === l.ownerId && l.askAnswererKind === 'human';
}

export async function hasCreateGrant(pool: Pool, agentId: string): Promise<boolean> {
  const r = await pool.query(
    `select 1 from account_grant
      where account_id = $1 and capability = 'secret.create' and scope = ''
        and (expires_at is null or expires_at > now()) and suspended_at is null limit 1`, [agentId]);
  return (r.rowCount ?? 0) > 0;
}

const sameValue = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const trimEnd = (b: Buffer): Buffer => Buffer.from(b.toString('latin1').replace(/[\r\n\t ]+$/, ''), 'latin1');

/**
 * F4: 들어온 값이 **같은 오퍼레이터에서 지금 살아 있는 임대로 reveal 된 값**이면 거절한다. 남의 턴에 마운트된 파일을
 * `cp` 해 import 하면 오래 남는, 정식으로 부여되는 비밀로 세탁된다 — H2 가 넓어지는 유일한 자리다. 비교는 서버에서
 * 봉투를 풀어 하고, 오퍼레이터를 믿지 않는다. 끝의 줄바꿈·공백 차이는 같은 값으로 본다.
 */
async function isMountedValue(pool: Pool, keyring: SecretKeyring, operatorId: string, value: Buffer, now: Date): Promise<boolean> {
  const rows = (await pool.query(
    `select distinct s.id as "secretId", s.kind, v.version, v.sealed
       from secret_access_log g
       join secret_turn_lease l on l.id = g.turn_id
       join secret s on s.id = g.secret_id
       join secret_version v on v.secret_id = g.secret_id and v.version = g.version
      where g.result = 'granted' and l.operator_id = $1 and l.ended_at is null and l.expires_at > $2
        and v.sealed is not null`, [operatorId, now])).rows as { secretId: string; kind: 'text' | 'file'; version: number; sealed: string }[];
  const mine = trimEnd(value);
  for (const r of rows) {
    const v = keyring.open(r.sealed, { secretId: r.secretId, version: r.version, kind: r.kind });
    if (v && (sameValue(v, value) || sameValue(trimEnd(v), mine))) return true;
  }
  return false;
}

/** 생성·회전 속도(시간당 10회, 에이전트마다). 인메모리 — 목적은 루프를 늦추는 것이다. */
export const createLimiter = (): RevealLimiter => new RevealLimiter(10, 3_600_000);

interface Common {
  agentId: string; operatorId: string; leaseId: string; token: string; keyring: SecretKeyring;
  limiter: RevealLimiter; now?: Date;
}

type Gate = { ok: true; lease: CreateLease; now: Date } | { ok: false; code: CreateDenial };

async function gate(pool: Pool, args: Common, action: 'create' | 'rotate'): Promise<Gate> {
  const now = args.now ?? new Date();
  const lease = await readCreateLease(pool, args.leaseId, args.token, now);
  const leaseOk = !!lease && lease.agentId === args.agentId && lease.operatorId === args.operatorId && !lease.expired && !lease.ended;
  const deny = async (code: CreateDenial): Promise<Gate> => {
    await recordAudit(pool, {
      action: `secret.${action}.denied`, actorId: args.agentId, target: args.agentId,
      detail: { code, operatorId: args.operatorId, leaseId: leaseOk ? lease!.id : null, causeAuthorId: leaseOk ? lease!.causeAuthorId : null },
    });
    return { ok: false, code };
  };
  if (!leaseOk) return deny('lease_invalid');
  if (lease!.ownerInactive) return deny('owner_inactive');
  if (!(await hasCreateGrant(pool, args.agentId))) return deny('not_granted');
  if (!causeByOwner(lease!)) return deny('cause_not_owner');
  if (!args.limiter.take(args.agentId, now.getTime())) return deny('rate_limited');
  return { ok: true, lease: lease!, now };
}

async function resolveValue(
  pool: Pool, args: Common, lease: CreateLease, now: Date, source: CreateSource, name: string,
): Promise<{ ok: true; kind: 'text' | 'file'; filename: string | null; value: Buffer; publicKey: string | null; via: 'generate' | 'import'; type: string | null } | { ok: false; code: CreateDenial }> {
  if ('generate' in source) {
    const g = generateValue(source.generate, name);
    if (!g.ok) return g;
    return { ...g, via: 'generate', type: source.generate.type };
  }
  const { kind, filename, value } = source.import;
  if (!value.length || value.length > SECRET_CREATE_MAX_BYTES) return { ok: false, code: 'bad_value' };
  if (kind === 'text' && value.toString('utf8').includes('�')) return { ok: false, code: 'bad_value' };
  if (await isMountedValue(pool, args.keyring, lease.operatorId, value, now)) return { ok: false, code: 'value_is_mounted' };
  return { ok: true, kind, filename, value, publicKey: null, via: 'import', type: null };
}

const descriptionLeaks = (description: string, value: Buffer): boolean =>
  !!scanWrite(description)?.rules.includes('secret') || needlesFor(value).some((n) => description.includes(n));

async function logAccess(
  pool: Pool, s: { id: string; name: string }, version: number, lease: CreateLease, result: 'created' | 'rotated', now: Date,
): Promise<void> {
  await pool.query(
    `insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10)`,
    [s.id, s.name, version, lease.agentId, lease.operatorId, lease.id, lease.channelId, lease.threadRootId, result, now]);
}

async function countCreated(db: Pick<Pool, 'query'>, agentId: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from secret where created_by_agent_id = $1`, [agentId]);
  return r.rows[0]!.n;
}

/**
 * 소유자에게 알린다(security n4 — "소유자가 안다"). 그 턴의 스레드에 서버가 시스템 줄을 세우고 소유자를 부른다 —
 * 부름이라 소유자 인박스·푸시가 평범한 멘션과 같은 관문(`insertInbox`)으로 간다. 본문은 서버 값뿐이다: 에이전트
 * handle·소유자 handle(계정 표), 비밀 이름(NAME 정규식을 지난 것), 종류·판. 설명은 싣지 않는다(에이전트가 쓴 글이다).
 * 원인 글이 소유자 글이므로(F2) 소유자는 그 채널에 있다.
 *
 * 실패해도 만들기를 되돌리지 않는다 — 감사·접근 기록은 이미 남았고, 알림이 빠진 것은 로그로 본다.
 */
export async function notifyOwner(
  pool: Pool,
  n: { agentId: string; lease: Pick<CreateLease, 'ownerId' | 'channelId' | 'threadRootId' | 'causeMessageId'>; secretId: string; name: string; version: number; action: 'created' | 'rotated'; via: 'generate' | 'import'; type: string | null },
): Promise<string | null> {
  try {
    if (!n.lease.ownerId) return null;
    const who = (await pool.query<{ agent: string; owner: string }>(
      `select a.handle as agent, o.handle as owner from account a, account o where a.id = $1 and o.id = $2`,
      [n.agentId, n.lease.ownerId])).rows[0];
    if (!who) return null;
    const how = n.via === 'generate' ? `서버가 만든 값(${n.type})` : '값을 에이전트가 정함(import)';
    const what = n.action === 'created' ? '만들었다' : `회전했다(판 ${n.version})`;
    const body = `🔑 ${who.agent} 가 비밀 \`${n.name}\` 을 ${what} · ${how} · 이 채널로 자기에게만 부여 · 설정 › 나 › 비밀과 API @${who.owner}`;
    const posted = await postMessage(pool, {
      channelId: n.lease.channelId, threadRootId: n.lease.threadRootId, authorId: n.agentId, body, kind: 'system', serverNotice: true,
      causeMessageId: n.lease.causeMessageId,
      meta: { secretNotice: { action: n.action, secretId: n.secretId, name: n.name, version: n.version, via: n.via, agentId: n.agentId, ownerAccountId: n.lease.ownerId } },
    });
    // 실패를 찾을 수 있게 secretId·agentId 를 싣는다(security L2'). 이름·설명·값은 싣지 않는다.
    if (posted.failure) { console.error(`[secretCreate] 소유자 알림 실패: ${posted.failure} secretId=${n.secretId} agentId=${n.agentId}`); return null; }
    return posted.message.id;
  } catch (e) {
    console.error(`[secretCreate] 소유자 알림 실패: secretId=${n.secretId} agentId=${n.agentId}`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 만들기(generate·import). 소유자 = 에이전트의 소유자, 부여 = 만든 에이전트 자신에게 **그 임대의 채널·오퍼레이터로**
 * 한 줄(null 채널은 없다 — security). 만료는 주지 않으면 90일(L5).
 */
export async function createAgentSecret(
  pool: Pool,
  args: Common & { name: string; description: string; expiresInDays?: number; source: CreateSource },
): Promise<CreateResult> {
  const g = await gate(pool, args, 'create');
  if (!g.ok) return g;
  const { lease, now } = g;
  // 미리 한 번 센다 — 넘친 에이전트에게 값을 만들거나 봉투를 풀지 않으려고. 확정 판정은 아래 트랜잭션 안이다(n2).
  if ((await countCreated(pool, args.agentId)) >= AGENT_SECRET_MAX) return { ok: false, code: 'too_many' };
  const v = await resolveValue(pool, args, lease, now, args.source, args.name);
  if (!v.ok) return v;
  if (descriptionLeaks(args.description, v.value)) return { ok: false, code: 'secret_in_description' };

  const days = Math.min(args.expiresInDays ?? AGENT_SECRET_DEFAULT_DAYS, AGENT_SECRET_MAX_DAYS);
  const expiresAt = new Date(now.getTime() + days * 86_400_000);
  const client = await pool.connect();
  let id: string;
  try {
    await client.query('begin');
    // 20개 상한을 동시 호출에도 지킨다(security n2) — 같은 에이전트의 만들기를 줄 세운 뒤 다시 센다.
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`secret.create:${args.agentId}`]);
    if ((await countCreated(client, args.agentId)) >= AGENT_SECRET_MAX) {
      await client.query('rollback');
      return { ok: false, code: 'too_many' };
    }
    const ins = await client.query<{ id: string }>(
      `insert into secret (name, kind, filename, description, owner_account_id, expires_at, created_by_agent_id, created_cause_message_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [args.name, v.kind, v.filename, args.description, lease.ownerId, expiresAt, args.agentId, lease.causeMessageId]);
    id = ins.rows[0]!.id;
    const sealed = args.keyring.seal(v.value, { secretId: id, version: 1, kind: v.kind });
    await client.query(
      `insert into secret_version (secret_id, version, sealed, size_bytes, created_by) values ($1, 1, $2, $3, $4)`,
      [id, sealed, v.value.length, args.agentId]);
    // 자동 부여: granted_by = 에이전트. 소유자가 다시 주거나 넓히면 granted_by 가 사람이 되고 회전 권한이 끝난다(F3).
    await client.query(
      `insert into secret_grant (secret_id, agent_id, channel_id, operator_id, granted_by) values ($1, $2, $3, $4, $2)`,
      [id, args.agentId, lease.channelId, lease.operatorId]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if ((e as { code?: string }).code === '23505') return { ok: false, code: 'name_taken' };
    throw e;
  } finally {
    client.release();
  }
  await logAccess(pool, { id, name: args.name }, 1, lease, 'created', now);
  await recordAudit(pool, {
    action: 'secret.created', actorId: args.agentId, target: id,
    detail: {
      name: args.name, kind: v.kind, via: v.via, type: v.type, byAgent: true, leaseId: lease.id,
      causeMessageId: lease.causeMessageId, causeAuthorId: lease.causeAuthorId, channelId: lease.channelId, operatorId: lease.operatorId,
    },
  });
  await notifyOwner(pool, { agentId: args.agentId, lease, secretId: id, name: args.name, version: 1, action: 'created', via: v.via, type: v.type });
  return { ok: true, secretId: id, name: args.name, kind: v.kind, version: 1, publicKey: v.publicKey, expiresAt: expiresAt.toISOString() };
}

/**
 * 회전(F3). **최신 판을 이 에이전트가 만들었고**, 그 비밀의 부여가 **자동 부여 한 줄뿐**일 때만. 사람이 값을 바꿨거나
 * 다시 주거나 넓혔으면 그 비밀은 소유자가 입양한 것이다 → 409 `adopted_by_owner`. 이 에이전트가 만들지 않은 비밀은
 * 있어도 404 다(이름은 권한의 지도다).
 */
export async function rotateAgentSecret(
  pool: Pool, args: Common & { name: string; source: CreateSource },
): Promise<CreateResult> {
  const g = await gate(pool, args, 'rotate');
  if (!g.ok) return g;
  const { lease, now } = g;
  const s = (await pool.query(
    `select s.id, s.name, s.kind, s.description, s.expires_at <= $3 as expired,
            (select created_by from secret_version v where v.secret_id = s.id order by version desc limit 1) as "latestBy"
       from secret s where s.name = $1 and s.created_by_agent_id = $2`,
    [args.name, args.agentId, now])).rows[0] as
    | { id: string; name: string; kind: 'text' | 'file'; description: string; expired: boolean | null; latestBy: string | null }
    | undefined;
  if (!s) return { ok: false, code: 'not_found' };
  if (s.expired) return { ok: false, code: 'secret_expired' };
  const grants = (await pool.query(
    `select agent_id as "agentId", granted_by as "grantedBy", channel_id as "channelId", suspended_at is not null as suspended
       from secret_grant where secret_id = $1`, [s.id])).rows as { agentId: string; grantedBy: string; channelId: string | null; suspended: boolean }[];
  const auto = grants.length === 1 && grants[0]!.agentId === args.agentId && grants[0]!.grantedBy === args.agentId && grants[0]!.channelId !== null;
  if (s.latestBy !== args.agentId || !auto) return { ok: false, code: 'adopted_by_owner' };
  if (grants[0]!.suspended) return { ok: false, code: 'grant_suspended' };

  const v = await resolveValue(pool, args, lease, now, args.source, s.name);
  if (!v.ok) return v;
  if (v.kind !== s.kind) return { ok: false, code: 'kind_mismatch' };
  if (descriptionLeaks(s.description, v.value)) return { ok: false, code: 'secret_in_description' };

  const client = await pool.connect();
  let version: number;
  try {
    await client.query('begin');
    await client.query(`select 1 from secret where id = $1 for update`, [s.id]);
    const cur = await client.query(`select coalesce(max(version), 0)::int as v from secret_version where secret_id = $1`, [s.id]);
    version = (cur.rows[0] as { v: number }).v + 1;
    const sealed = args.keyring.seal(v.value, { secretId: s.id, version, kind: s.kind });
    await client.query(
      `insert into secret_version (secret_id, version, sealed, size_bytes, created_by) values ($1, $2, $3, $4, $5)`,
      [s.id, version, sealed, v.value.length, args.agentId]);
    await client.query(
      `update secret_version set sealed = null, revoked_at = now() where secret_id = $1 and version < $2 and revoked_at is null`,
      [s.id, version]);
    await client.query(`update secret set updated_at = now() where id = $1`, [s.id]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await logAccess(pool, s, version, lease, 'rotated', now);
  await recordAudit(pool, {
    action: 'secret.rotated', actorId: args.agentId, target: s.id,
    detail: {
      name: s.name, version, via: v.via, type: v.type, leaseId: lease.id,
      causeMessageId: lease.causeMessageId, causeAuthorId: lease.causeAuthorId, channelId: lease.channelId, operatorId: lease.operatorId,
    },
  });
  await notifyOwner(pool, { agentId: args.agentId, lease, secretId: s.id, name: s.name, version, action: 'rotated', via: v.via, type: v.type });
  return { ok: true, secretId: s.id, name: s.name, kind: s.kind, version, publicKey: v.publicKey, expiresAt: null };
}
