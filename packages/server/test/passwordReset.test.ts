import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { normalizeResetCode, RESET_CODE_ALPHABET } from '../src/services/passwordReset.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let owner: { token: string; accountId: string };

const ACCOUNT_MAX = 4;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  // 주소 리밋은 넉넉히(시험이 한 주소에서 많이 부른다), 로그인 ID 리밋은 낮춰 횟수로 잰다.
  app = await buildServer({ pool: db.pool, rateLimits: {
    passwordReset: { windowMs: 60_000, max: 1000 },
    signup: { windowMs: 60_000, max: 1000 }, // createMember 가 가입을 여러 번 한다
    login: { windowMs: 60_000, max: 1000 },
    passwordResetAccount: { windowMs: 60_000, max: ACCOUNT_MAX },
  } });
  owner = await bootstrapAdmin(app);
});
afterAll(async () => { await app.close(); await stop(); });

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const stepUp = (token: string, password = 'pw123456') =>
  app.inject({ method: 'POST', url: '/auth/step-up', headers: auth(token), payload: { password } });
const issue = (token: string, id: string) =>
  app.inject({ method: 'POST', url: `/accounts/${id}/password-reset-code`, headers: auth(token) });
const redeem = (loginId: string, code: string, newPassword = 'new-pass-1234') =>
  app.inject({ method: 'POST', url: '/auth/password-reset', payload: { loginId, code, newPassword } });
const login = (loginId: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { loginId, password } });

async function issued(id: string): Promise<string> {
  expect((await stepUp(owner.token)).statusCode).toBe(200);
  const res = await issue(owner.token, id);
  expect(res.statusCode).toBe(201);
  return res.json().code as string;
}

describe('재설정 코드 모양', () => {
  it('정규화는 하이픈·공백·대소문자를 무시하고 헷갈리는 글자는 받지 않는다', () => {
    expect(normalizeResetCode('k7qf-9mxd 2pqr')).toBe('K7QF9MXD2PQR');
    expect(normalizeResetCode('K7QF-9MXD-2PL0')).toBeNull(); // 0 은 알파벳 밖
    expect(normalizeResetCode('K7QF-9MXD')).toBeNull();
    for (const ch of '01ILO') expect(RESET_CODE_ALPHABET.includes(ch)).toBe(false);
  });
});

describe('발급', () => {
  it('step-up 없이는 발급하지 않는다', async () => {
    const m = await createMember(app, owner.token, 'nostep');
    // 새 세션이라 창이 닫혀 있다.
    const fresh = await login('admin', 'pw123456');
    const res = await issue(fresh.json().token, m.accountId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('step_up_required');
  });

  it('member 는 발급하지 못하고 grant 로도 넓힐 수 없다', async () => {
    const a = await createMember(app, owner.token, 'plainmem');
    const b = await createMember(app, owner.token, 'plainmem2');
    await stepUp(a.token);
    expect((await issue(a.token, b.accountId)).statusCode).toBe(403);
    const grant = await app.inject({
      method: 'PUT', url: `/accounts/${a.accountId}/grants`, headers: auth(owner.token),
      payload: { capability: 'member.reset_password' },
    });
    expect(grant.statusCode).toBe(400);
    expect(grant.json().error.code).toBe('not_grantable');
  });

  it('owner 계정은 대상이 될 수 없고, admin 은 owner 만 대상으로 삼는다', async () => {
    const adm = await createMember(app, owner.token, 'adm1');
    const adm2 = await createMember(app, owner.token, 'adm2');
    for (const id of [adm.accountId, adm2.accountId]) {
      expect((await app.inject({ method: 'PUT', url: `/accounts/${id}/role`, headers: auth(owner.token), payload: { role: 'admin' } })).statusCode).toBe(200);
    }
    await stepUp(adm.token);
    const toOwner = await issue(adm.token, owner.accountId);
    expect(toOwner.statusCode).toBe(403);
    expect(toOwner.json().error.code).toBe('owner_target');
    expect((await issue(adm.token, adm2.accountId)).statusCode).toBe(403);
    // admin 이 member 에게는 발급한다.
    const mem = await createMember(app, owner.token, 'admtarget');
    expect((await issue(adm.token, mem.accountId)).statusCode).toBe(201);
    // owner 는 admin 에게 발급한다.
    await stepUp(owner.token);
    expect((await issue(owner.token, adm2.accountId)).statusCode).toBe(201);
  });

  it('자기 자신에게는 발급하지 않는다', async () => {
    await stepUp(owner.token);
    expect((await issue(owner.token, owner.accountId)).json().error.code).toBe('self');
  });

  it('코드는 4-4-4 꼴이고 해시만 저장한다', async () => {
    const m = await createMember(app, owner.token, 'shape');
    const code = await issued(m.accountId);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const rows = await pool.query(`select code_hash from password_reset_code where account_id = $1`, [m.accountId]);
    expect(rows.rows[0].code_hash).not.toContain(code.replace(/-/g, ''));
    const audit = await pool.query(`select detail from audit_log where action = 'password_reset_code.issued' and target = $1`, [m.accountId]);
    expect(JSON.stringify(audit.rows)).not.toContain(code.replace(/-/g, ''));
  });
});

describe('사용', () => {
  it('맞는 코드로 바꾸면 새 세션이 나오고 옛 세션·옛 비밀번호는 죽는다', async () => {
    const m = await createMember(app, owner.token, 'redeem1');
    const code = await issued(m.accountId);
    const res = await redeem('REDEEM1', code.toLowerCase());
    expect(res.statusCode).toBe(200);
    const token = res.json().token as string;
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/auth/me', headers: auth(m.token) })).statusCode).toBe(401);
    expect((await login('redeem1', 'pw123456')).statusCode).toBe(401);
    expect((await login('redeem1', 'new-pass-1234')).statusCode).toBe(200);
  });

  it('handle 과 로그인 ID 가 다른 사람: handle 로는 실패하고, 발급 응답이 주는 로그인 ID 로는 된다(10-22 jinbin 재현)', async () => {
    // 그날의 모양: handle `jin`, 로그인 ID 는 다른 값. 사람은 화면에 보이는 handle 을 쳤다.
    const invite = await app.inject({ method: 'POST', url: '/invites', headers: auth(owner.token) });
    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { inviteToken: invite.json().token, handle: 'jinx', loginId: 'login-other-7', displayName: 'Jin', password: 'pw123456' },
    });
    expect(reg.statusCode).toBe(201);
    const id = reg.json().id as string;
    expect((await stepUp(owner.token)).statusCode).toBe(200);
    const issuedRes = await issue(owner.token, id);
    expect(issuedRes.statusCode).toBe(201);
    // 발급 응답에 대상의 로그인 ID 가 실린다 — 관리자가 코드와 함께 전할 수 있게.
    expect(issuedRes.json().loginId).toBe('login-other-7');
    const code = issuedRes.json().code as string;
    const byHandle = await redeem('jinx', code);
    expect(byHandle.statusCode).toBe(400);
    expect(byHandle.json().error.code).toBe('invalid_reset_code');
    expect((await redeem(issuedRes.json().loginId, code)).statusCode).toBe(200);
  });

  it('한 번만 쓴다', async () => {
    const m = await createMember(app, owner.token, 'once');
    const code = await issued(m.accountId);
    expect((await redeem('once', code)).statusCode).toBe(200);
    const again = await redeem('once', code, 'another-pass-99');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_reset_code');
  });

  it('새로 발급하면 이전 코드는 죽는다', async () => {
    const m = await createMember(app, owner.token, 'reissue');
    const first = await issued(m.accountId);
    const second = await issued(m.accountId);
    expect((await redeem('reissue', first)).json().error.code).toBe('invalid_reset_code');
    expect((await redeem('reissue', second)).statusCode).toBe(200);
  });

  it('거둔 코드·만료된 코드·남의 로그인 ID 는 모두 같은 응답이다', async () => {
    const m = await createMember(app, owner.token, 'same1');
    const other = await createMember(app, owner.token, 'same2');
    const code = await issued(m.accountId);
    const wrongId = await redeem('same2', code);
    const unknownId = await redeem('nobody-here', code);
    await app.inject({ method: 'DELETE', url: `/accounts/${m.accountId}/password-reset-code`, headers: auth(owner.token) });
    const revoked = await redeem('same1', code);
    const c2 = await issued(other.accountId);
    await pool.query(`update password_reset_code set expires_at = now() - interval '1 minute' where account_id = $1`, [other.accountId]);
    const expired = await redeem('same2', c2);
    const malformed = await redeem('same1', 'nope');
    const bodies = [wrongId, unknownId, revoked, expired, malformed].map((r) => [r.statusCode, r.body]);
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]![0]).toBe(400);
  });

  it('발급 뒤 발급자가 강등되면 그 코드는 죽는다(security F1)', async () => {
    const adm = await createMember(app, owner.token, 'demoted');
    const setRole = (id: string, role: string) =>
      app.inject({ method: 'PUT', url: `/accounts/${id}/role`, headers: auth(owner.token), payload: { role } });
    expect((await setRole(adm.accountId, 'admin')).statusCode).toBe(200);
    const mem = await createMember(app, owner.token, 'demotetarget');
    await stepUp(adm.token);
    const res = await issue(adm.token, mem.accountId);
    expect(res.statusCode).toBe(201);
    expect((await setRole(adm.accountId, 'member')).statusCode).toBe(200);
    const used = await redeem('demotetarget', res.json().code);
    expect(used.statusCode).toBe(400);
    expect(used.json().error.code).toBe('invalid_reset_code');
    // 발급자를 다시 올리면 같은 코드가 산다 — 막은 것이 바로 그 조건임을 보인다.
    expect((await setRole(adm.accountId, 'admin')).statusCode).toBe(200);
    expect((await redeem('demotetarget', res.json().code)).statusCode).toBe(200);
  });

  it('발급 뒤 대상이 admin 으로 오르면 admin 이 발급한 코드는 죽는다(security F1)', async () => {
    const adm = await createMember(app, owner.token, 'issueradm');
    const tgt = await createMember(app, owner.token, 'promoted');
    const setRole = (id: string, role: string) =>
      app.inject({ method: 'PUT', url: `/accounts/${id}/role`, headers: auth(owner.token), payload: { role } });
    expect((await setRole(adm.accountId, 'admin')).statusCode).toBe(200);
    await stepUp(adm.token);
    const res = await issue(adm.token, tgt.accountId);
    expect(res.statusCode).toBe(201);
    expect((await setRole(tgt.accountId, 'admin')).statusCode).toBe(200);
    expect((await redeem('promoted', res.json().code)).json().error.code).toBe('invalid_reset_code');
    // owner 가 발급한 코드는 admin 대상에도 산다.
    const byOwner = await issued(tgt.accountId);
    expect((await redeem('promoted', byOwner)).statusCode).toBe(200);
  });

  it('로그인 ID 단위로 시도를 센다', async () => {
    for (let i = 0; i < ACCOUNT_MAX; i += 1) expect((await redeem('limited', 'AAAA-AAAA-AAAA')).statusCode).toBe(400);
    const limited = await redeem('LIMITED', 'AAAA-AAAA-AAAA');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
  });

  it('비밀번호 규칙은 가입과 같다', async () => {
    const res = await redeem('whoever', 'AAAA-AAAA-AAAA', 'short');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});

describe('로그인 ID 목록(멤버와 초대, 관리자만)', () => {
  const loginIds = (token: string) => app.inject({ method: 'GET', url: '/accounts/login-ids', headers: auth(token) });

  it('owner·admin 은 사람들의 로그인 ID 를 받는다 — handle 과 다른 값도 그대로', async () => {
    const invite = await app.inject({ method: 'POST', url: '/invites', headers: auth(owner.token) });
    const reg = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: { inviteToken: invite.json().token, handle: 'listed', loginId: 'listed-login-9', displayName: 'Listed', password: 'pw123456' },
    });
    const id = reg.json().id as string;
    const res = await loginIds(owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json().loginIds[id]).toBe('listed-login-9');

    const adm = await createMember(app, owner.token, 'lister-adm');
    await app.inject({ method: 'PUT', url: `/accounts/${adm.accountId}/role`, headers: auth(owner.token), payload: { role: 'admin' } });
    expect((await loginIds(adm.token)).json().loginIds[id]).toBe('listed-login-9');
  });

  it('member 는 못 받고(403), 모두가 받는 /accounts 에는 로그인 ID 가 실리지 않는다', async () => {
    const m = await createMember(app, owner.token, 'plain-lister');
    expect((await loginIds(m.token)).statusCode).toBe(403);
    const dir = await app.inject({ method: 'GET', url: '/accounts', headers: auth(m.token) });
    expect(dir.statusCode).toBe(200);
    expect(dir.body).not.toMatch(/login_?id/i);
    // 관리자가 받아도 /accounts 자체에는 없다 — 거르는 자리는 이 라우트 하나다.
    expect((await app.inject({ method: 'GET', url: '/accounts', headers: auth(owner.token) })).body).not.toMatch(/login_?id/i);
  });
});

describe('본인 알림(R7)', () => {
  it('발급되면 대상에게 알림이 서고, 확인하면 내려간다 — 남의 알림은 못 내린다', async () => {
    const m = await createMember(app, owner.token, 'notice1');
    const other = await createMember(app, owner.token, 'notice2');
    await issued(m.accountId);
    const list = await app.inject({ method: 'GET', url: '/auth/password-reset-notices', headers: auth(m.token) });
    expect(list.statusCode).toBe(200);
    const notices = list.json().notices as { id: string; issuedById: string }[];
    expect(notices).toHaveLength(1);
    expect(notices[0]!.issuedById).toBe(owner.accountId);

    await app.inject({ method: 'POST', url: '/auth/password-reset-notices/ack', headers: auth(other.token), payload: { ids: [notices[0]!.id] } });
    expect((await app.inject({ method: 'GET', url: '/auth/password-reset-notices', headers: auth(m.token) })).json().notices).toHaveLength(1);

    const ack = await app.inject({ method: 'POST', url: '/auth/password-reset-notices/ack', headers: auth(m.token), payload: { ids: [notices[0]!.id] } });
    expect(ack.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/auth/password-reset-notices', headers: auth(m.token) })).json().notices).toHaveLength(0);
  });

  it('감사에 발급·사용이 남는다', async () => {
    const m = await createMember(app, owner.token, 'audit1');
    const code = await issued(m.accountId);
    await redeem('audit1', code);
    const r = await pool.query(
      `select action from audit_log where target = $1 and action like 'password_reset_code.%' order by id`, [m.accountId]);
    expect(r.rows.map((x) => x.action)).toEqual(['password_reset_code.issued', 'password_reset_code.used']);
  });
});
