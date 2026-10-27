import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import type { MailMessage } from '../src/services/mail/mailer.js';
import { loadMailConfig, mailErrorSummary } from '../src/services/mail/mailer.js';

// 149: 초대 메일. 진짜 SMTP 대신 보낸 것을 모아 두는 가짜 전송부를 꽂는다.
const sent: MailMessage[] = [];
let failNext = false;
const transport = {
  async send(msg: MailMessage) {
    if (failNext) { failNext = false; throw new Error('550 mailbox unavailable'); }
    sent.push(msg);
  },
};

let app: FastifyInstance; let off: FastifyInstance;
let stop: () => Promise<void>; let pool: Pool;
let adminToken: string; let offToken: string;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop; pool = db.pool as Pool;
  app = await buildServer({ pool, mail: { transport, publicUrl: 'https://ws.example.com' } });
  ({ token: adminToken } = await bootstrapAdmin(app));
  off = await buildServer({ pool, mail: null });
  offToken = adminToken;
});
afterAll(async () => { await app.close(); await off.close(); await stop(); });
beforeEach(() => { sent.length = 0; failNext = false; });

const invite = (payload: object, server = app, token = adminToken) =>
  server.inject({ method: 'POST', url: '/invites', headers: auth(token), payload });
const register = (inviteToken: string, handle: string) => app.inject({
  method: 'POST', url: '/auth/register',
  payload: { inviteToken, handle, loginId: handle, displayName: handle, password: 'pw123456' },
});
const tokenIn = (m: MailMessage) => /Invite token: (hrki_\S+)|초대 토큰: (hrki_\S+)/.exec(m.text)?.slice(1).find(Boolean);

describe('초대 메일', () => {
  it('healthz 가 메일 켜짐·꺼짐을 낸다', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().mail).toBe('on');
    expect((await off.inject({ method: 'GET', url: '/healthz' })).json().mail).toBe('off');
  });

  it('이메일을 실으면 메일이 가고, 응답에 토큰이 없으며, 메일의 토큰으로 가입된다', async () => {
    const res = await invite({ email: ' Friend@Example.com ', locale: 'ko' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mail).toBe('sent');
    expect(body.token).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('friend@example.com');
    expect(sent[0]!.subject).toContain('Harkroom');
    const token = tokenIn(sent[0]!)!;
    expect(sent[0]!.text).toContain(`https://ws.example.com/join#${token}`);
    expect(sent[0]!.text).toContain('서버 주소: https://ws.example.com');
    expect((await register(token, 'mailfriend')).statusCode).toBe(201);
    const list = (await app.inject({ method: 'GET', url: '/invites', headers: auth(adminToken) })).json().invites;
    const row = list.find((i: { id: string }) => i.id === body.id);
    expect(row).toMatchObject({ email: 'friend@example.com', mailStatus: 'sent', status: 'used' });
  });

  it('보내지 못하면 초대는 남고 토큰을 한 번 보여 준다(사유는 응답·DB 에 없다)', async () => {
    failNext = true;
    const res = await invite({ email: 'bounce@example.com' });
    expect(res.statusCode).toBe(201);
    expect(res.json().mail).toBe('failed');
    expect(res.json().token).toMatch(/^hrki_/);
    expect(res.body).not.toContain('550');
    const row = await pool.query(`select mail_status from invite where id = $1`, [res.json().id]);
    expect(row.rows[0].mail_status).toBe('failed');
  });

  it('이메일 없이 내면 지금처럼 토큰을 준다(mail: off)', async () => {
    const res = await invite({});
    expect(res.json()).toMatchObject({ mail: 'off' });
    expect(res.json().token).toMatch(/^hrki_/);
    expect(sent).toHaveLength(0);
  });

  it('메일이 꺼진 서버에 이메일을 실으면 409 이고 초대를 만들지 않는다', async () => {
    const before = await pool.query(`select count(*)::int as n from invite`);
    const res = await invite({ email: 'x@example.com' }, off, offToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('mail_disabled');
    const after = await pool.query(`select count(*)::int as n from invite`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('주소가 아니면 400', async () => {
    expect((await invite({ email: 'not-an-address' })).statusCode).toBe(400);
  });

  it('다시 보내기: 새 토큰을 보내고 앞 토큰은 죽는다, 60초 안에 또 누르면 429', async () => {
    const first = (await invite({ email: 'again@example.com' })).json();
    const oldToken = tokenIn(sent[0]!)!;
    // 간격 검사를 건너뛰려고 앞 발송 시각을 옮긴다.
    await pool.query(`update invite set last_sent_at = now() - interval '2 minutes' where id = $1`, [first.id]);
    const res = await app.inject({ method: 'POST', url: `/invites/${first.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json().mail).toBe('sent');
    expect(res.json().id).not.toBe(first.id);
    const newToken = tokenIn(sent[1]!)!;
    expect(newToken).not.toBe(oldToken);
    expect(sent[1]!.to).toBe('again@example.com');
    expect((await register(oldToken, 'oldtok')).statusCode).toBe(400);
    const tooSoon = await app.inject({ method: 'POST', url: `/invites/${res.json().id}/resend`, headers: auth(adminToken), payload: {} });
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json().error.code).toBe('resend_too_soon');
    expect((await register(newToken, 'newtok')).statusCode).toBe(201);
    const used = await app.inject({ method: 'POST', url: `/invites/${res.json().id}/resend`, headers: auth(adminToken), payload: {} });
    expect(used.statusCode).toBe(409);
  });

  it('이메일 없는 초대는 다시 보낼 수 없다(409 no_email)', async () => {
    const plain = (await invite({})).json();
    const res = await app.inject({ method: 'POST', url: `/invites/${plain.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_email');
  });

  it('감사 기록에는 주소를 가려 싣는다', async () => {
    await invite({ email: 'secretname@example.com' });
    const rows = await pool.query(`select detail from audit_log where action = 'invite.created' and detail ? 'email'`);
    const emails = rows.rows.map((r) => r.detail.email as string);
    expect(emails).toContain('s***@example.com');
    expect(JSON.stringify(rows.rows)).not.toContain('secretname');
  });

  it('취소됐거나 다른 초대로 바뀐 초대는 다시 보낼 수 없다(409 invite_revoked)', async () => {
    const a = (await invite({ email: 'replaced@example.com' })).json();
    await pool.query(`update invite set last_sent_at = now() - interval '2 minutes' where id = $1`, [a.id]);
    const b = await app.inject({ method: 'POST', url: `/invites/${a.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(b.statusCode).toBe(201);
    const again = await app.inject({ method: 'POST', url: `/invites/${a.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('invite_revoked');
    const live = await pool.query(
      `select count(*)::int as n from invite where email = 'replaced@example.com' and revoked_at is null and used_by is null`,
    );
    expect(live.rows[0].n).toBe(1);

    const c = (await invite({ email: 'pulled@example.com' })).json();
    await app.inject({ method: 'DELETE', url: `/invites/${c.id}`, headers: auth(adminToken) });
    await pool.query(`update invite set last_sent_at = now() - interval '2 minutes' where id = $1`, [c.id]);
    const pulled = await app.inject({ method: 'POST', url: `/invites/${c.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(pulled.statusCode).toBe(409);
    expect(pulled.json().error.code).toBe('invite_revoked');
  });

  it('만료된 초대는 다시 보낼 수 있다', async () => {
    const a = (await invite({ email: 'late@example.com' })).json();
    await pool.query(
      `update invite set expires_at = now() - interval '1 second', last_sent_at = now() - interval '2 minutes' where id = $1`, [a.id],
    );
    const res = await app.inject({ method: 'POST', url: `/invites/${a.id}/resend`, headers: auth(adminToken), payload: {} });
    expect(res.statusCode).toBe(201);
  });

  it('두 번 빠르게 눌러도 다시 보내기는 한 번만 된다', async () => {
    const a = (await invite({ email: 'double@example.com' })).json();
    await pool.query(`update invite set last_sent_at = now() - interval '2 minutes' where id = $1`, [a.id]);
    sent.length = 0;
    const hit = () => app.inject({ method: 'POST', url: `/invites/${a.id}/resend`, headers: auth(adminToken), payload: {} });
    const codes = (await Promise.all([hit(), hit(), hit()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409]);
    expect(sent).toHaveLength(1);
    const live = await pool.query(
      `select count(*)::int as n from invite where email = 'double@example.com' and revoked_at is null and used_by is null`,
    );
    expect(live.rows[0].n).toBe(1);
  });

  it('시간당 상한은 동시 요청으로도 넘지 않는다', async () => {
    await pool.query(
      `insert into invite (token_hash, created_by, email, mail_status, last_sent_at)
       select 'race-' || g, (select id from account where handle = 'admin'), 'race@example.com', 'sent', now()
         from generate_series(1, 30 - (select count(*)::int from invite
           where created_by = (select id from account where handle = 'admin') and last_sent_at > now() - interval '1 hour') - 1) g`,
    );
    const codes = (await Promise.all([1, 2, 3, 4].map((i) => invite({ email: `r${i}@example.com` })))).map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 429, 429, 429]);
    await pool.query(`delete from invite where token_hash like 'race-%' or email like 'r_@example.com'`);
  });

  it('한 시간 상한을 넘으면 429', async () => {
    await pool.query(
      `insert into invite (token_hash, created_by, email, mail_status, last_sent_at)
       select 'cap-' || g, (select id from account where handle = 'admin'), 'cap@example.com', 'sent', now()
         from generate_series(1, 30) g`,
    );
    const res = await invite({ email: 'over@example.com' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('mail_rate_limited');
    await pool.query(`delete from invite where token_hash like 'cap-%'`);
  });
});

describe('/join 안내 페이지', () => {
  it('인증 없이 열리고, CSP·no-referrer·no-store 를 건다', async () => {
    const res = await app.inject({ method: 'GET', url: '/join' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'; script-src 'sha256-/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('textContent');
    expect(res.body).not.toContain('innerHTML');
  });
});

describe('loadMailConfig', () => {
  const full = {
    HARKROOM_SMTP_HOST: 'smtp.example.com', HARKROOM_MAIL_FROM: 'Harkroom <invite@example.com>',
    HARKROOM_PUBLIC_URL: 'https://ws.example.com/', HARKROOM_SMTP_USER: 'u', HARKROOM_SMTP_PASSWORD: 'p',
  };
  it('하나도 없으면 null(끔)', () => { expect(loadMailConfig({})).toBeNull(); });
  it('메일 칸 없이 공개 주소만 있으면(http 라도) 끈 채로 뜬다 — 메일 안 쓰는 테넌트를 판올림이 죽이지 않는다', () => {
    expect(loadMailConfig({ HARKROOM_PUBLIC_URL: 'http://ws.example.com' })).toBeNull();
    expect(loadMailConfig({ HARKROOM_PUBLIC_URL: 'https://ws.example.com', HARKROOM_SMTP_PASSWORD: '' })).toBeNull();
  });
  it('다 있으면 읽고, 기본 포트 587·뒤 / 를 뗀다', () => {
    expect(loadMailConfig(full)).toMatchObject({ port: 587, publicUrl: 'https://ws.example.com', user: 'u' });
  });
  it('필수 일부만 있으면 기동을 멈추고, 값은 문구에 싣지 않는다', () => {
    expect(() => loadMailConfig({ HARKROOM_SMTP_PASSWORD: 'hunter2-secret' })).toThrow(/HARKROOM_SMTP_HOST/);
    expect(() => loadMailConfig({ HARKROOM_SMTP_PASSWORD: 'hunter2-secret' })).not.toThrow(/hunter2/);
  });
  it('사용자·비밀번호는 둘 다 또는 둘 다 없이', () => {
    expect(() => loadMailConfig({ ...full, HARKROOM_SMTP_PASSWORD: '' })).toThrow(/both/);
  });
  it('공개 주소는 https 여야 한다(localhost 만 http 허락)', () => {
    expect(() => loadMailConfig({ ...full, HARKROOM_PUBLIC_URL: 'http://ws.example.com' })).toThrow(/https/);
    expect(loadMailConfig({ ...full, HARKROOM_PUBLIC_URL: 'http://localhost:3400' })?.publicUrl).toBe('http://localhost:3400');
    expect(loadMailConfig({ ...full, HARKROOM_PUBLIC_URL: 'http://127.0.0.1:3400' })).not.toBeNull();
  });
  it('잘못된 포트·주소는 멈춘다', () => {
    expect(() => loadMailConfig({ ...full, HARKROOM_SMTP_PORT: 'abc' })).toThrow(/port/);
    expect(() => loadMailConfig({ ...full, HARKROOM_PUBLIC_URL: 'ftp://x.example.com' })).toThrow(/http/);
  });
});

describe('mailErrorSummary', () => {
  it('SMTP 응답 글(받는 주소가 섞인)은 버리고 코드만 남긴다', () => {
    const err = Object.assign(new Error('550 <someone@example.com> mailbox unavailable'), {
      code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', response: '550 <someone@example.com> mailbox unavailable',
    });
    const out = mailErrorSummary(err);
    expect(out).toEqual({ code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
    expect(JSON.stringify(out)).not.toContain('example.com');
    expect(mailErrorSummary(new Error('x'))).toEqual({ code: null, responseCode: null, command: null });
    expect(mailErrorSummary(undefined)).toEqual({ code: null, responseCode: null, command: null });
  });
});
