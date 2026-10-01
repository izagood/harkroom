// APNs 전송부(node:http2). 실제 APNs 대신 로컬 h2c 서버로 요청 모양을 잰다. TLS 검증을 끄는 것이
// 아니다 — 시험이 `origins` 를 평문 로컬 주소로 바꿀 뿐이다(운영 주소는 APNS_ORIGINS 고정).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Http2Server, type IncomingHttpHeaders } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  APNS_JWT_TTL_MS, APNS_ORIGINS, createApnsTransport, loadApnsConfig, redactToken, type ApnsConfig,
} from '../src/services/push/apns.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const cfg: ApnsConfig = { keyId: 'KEY1234567', teamId: 'TEAM123456', keyPem, topic: 'com.example.app' };
const TOKEN = 'cd'.repeat(32);

let server: Http2Server; let origin: string;
const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
let respond: { status: number; body?: string } = { status: 200 };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(respond.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

function jwtOf(h: IncomingHttpHeaders): string {
  return String(h.authorization).replace(/^bearer /, '');
}

describe('createApnsTransport', () => {
  it('운영 주소는 Apple 의 두 호스트다', () => {
    expect(APNS_ORIGINS).toEqual({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
  });

  it('요청 모양: 경로·topic·push-type·collapse-id·본문, JWT 는 ES256 ieee-p1363 로 검증된다', async () => {
    const t = createApnsTransport(cfg, { origins: { production: origin, sandbox: origin } });
    respond = { status: 200 };
    const res = await t.send({ token: TOKEN, env: 'production', payload: { aps: { alert: 'x' } }, collapseId: 'm-1' });
    t.close();
    expect(res).toEqual({ status: 200 });
    const req = seen.at(-1)!;
    expect(req.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(req.headers[':method']).toBe('POST');
    expect(req.headers['apns-topic']).toBe('com.example.app');
    expect(req.headers['apns-push-type']).toBe('alert');
    expect(req.headers['apns-collapse-id']).toBe('m-1');
    expect(JSON.parse(req.body)).toEqual({ aps: { alert: 'x' } });
    const [h, c, s] = jwtOf(req.headers).split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: 'TEAM123456' });
    const sig = Buffer.from(s!, 'base64url');
    expect(sig).toHaveLength(64); // DER 이 아니라 r||s 64바이트
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('JWT 는 50분 안에서는 같은 것을 쓰고, 지나면 새로 만든다', async () => {
    let now = 1_800_000_000_000;
    const t = createApnsTransport(cfg, { origins: { production: origin, sandbox: origin }, now: () => now });
    const send = () => t.send({ token: TOKEN, env: 'production', payload: {}, collapseId: 'c' });
    await send(); const a = jwtOf(seen.at(-1)!.headers);
    now += APNS_JWT_TTL_MS - 1; await send(); const b = jwtOf(seen.at(-1)!.headers);
    now += 2; await send(); const c = jwtOf(seen.at(-1)!.headers);
    t.close();
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('실패 응답의 reason 을 읽는다', async () => {
    const t = createApnsTransport(cfg, { origins: { production: origin, sandbox: origin } });
    respond = { status: 410, body: JSON.stringify({ reason: 'Unregistered', timestamp: 1 }) };
    const res = await t.send({ token: TOKEN, env: 'sandbox', payload: {}, collapseId: 'c' });
    t.close();
    respond = { status: 200 };
    expect(res).toEqual({ status: 410, reason: 'Unregistered' });
  });

  it('닿지 않으면 status 0 이다(재시도 대상)', async () => {
    const t = createApnsTransport(cfg, { origins: { production: 'http://127.0.0.1:1', sandbox: 'http://127.0.0.1:1' } });
    const res = await t.send({ token: TOKEN, env: 'production', payload: {}, collapseId: 'c' });
    t.close();
    expect(res.status).toBe(0);
  });
});

describe('loadApnsConfig', () => {
  const full = { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY_P8: keyPem, APNS_TOPIC: 'com.example.app' };
  it('넷 다 없으면 끈다(null)', () => { expect(loadApnsConfig({})).toBeNull(); });
  it('넷 다 있으면 읽는다', () => { expect(loadApnsConfig(full)).toMatchObject({ keyId: 'K', teamId: 'T', topic: 'com.example.app' }); });
  it('일부만 있으면 빠진 이름을 대며 멈춘다', () => {
    expect(() => loadApnsConfig({ APNS_KEY_ID: 'K' })).toThrow(/APNS_TEAM_ID, APNS_KEY_P8, APNS_TOPIC/);
  });
  it('키가 PEM 이 아니면 멈추되 값은 싣지 않는다', () => {
    let msg = '';
    try { loadApnsConfig({ ...full, APNS_KEY_P8: 'not-a-key-SECRETVALUE' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/APNS_KEY_P8/);
    expect(msg).not.toContain('SECRETVALUE');
  });
});

it('redactToken 은 앞 8자만 남긴다', () => { expect(redactToken(TOKEN)).toBe(`${TOKEN.slice(0, 8)}…`); });
