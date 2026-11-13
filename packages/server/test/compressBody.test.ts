// 큰 JSON 응답 압축(2026-11-13, `routes/compressBody.ts`) — DB 없이 돈다.
import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { COMPRESS_MIN_BYTES, pickEncoding, sendJsonMaybeCompressed } from '../src/routes/compressBody.js';

describe('pickEncoding', () => {
  it('br 를 먼저, 없으면 gzip, 둘 다 없으면 그대로', () => {
    expect(pickEncoding('gzip, deflate, br')).toBe('br');
    expect(pickEncoding('gzip, deflate')).toBe('gzip');
    expect(pickEncoding('deflate')).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding('')).toBeNull();
  });
  it('q=0 은 거절이고, * 는 남은 것을 받는다', () => {
    expect(pickEncoding('br;q=0, gzip')).toBe('gzip');
    expect(pickEncoding('br;q=0, gzip;q=0')).toBeNull();
    expect(pickEncoding('*')).toBe('br');
    expect(pickEncoding('br;q=0, *')).toBe('gzip');
    expect(pickEncoding('identity, *;q=0')).toBeNull();
  });
  it('여러 줄 머리도 읽는다', () => {
    expect(pickEncoding(['deflate', 'GZIP'])).toBe('gzip');
  });
});

describe('sendJsonMaybeCompressed', () => {
  const app = Fastify();
  const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, body: '같은 말이 되풀이되는 본문입니다' })) });
  const small = JSON.stringify({ ok: true });
  app.get('/big', (req, reply) => sendJsonMaybeCompressed(req, reply, big));
  app.get('/small', (req, reply) => sendJsonMaybeCompressed(req, reply, small));
  afterAll(() => app.close());

  it('받을 수 있으면 압축하고, 풀면 같은 JSON 이다', async () => {
    expect(Buffer.byteLength(big)).toBeGreaterThan(COMPRESS_MIN_BYTES);
    for (const [coding, unpack] of [['br', brotliDecompressSync], ['gzip', gunzipSync]] as const) {
      const res = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': coding } });
      expect(res.headers['content-encoding']).toBe(coding);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers.vary).toMatch(/accept-encoding/i);
      expect(res.rawPayload.length).toBeLessThan(Buffer.byteLength(big));
      expect(unpack(res.rawPayload).toString('utf8')).toBe(big);
    }
  });

  it('못 받거나 작은 몸통이면 그대로 보낸다', async () => {
    const none = await app.inject({ method: 'GET', url: '/big' });
    expect(none.headers['content-encoding']).toBeUndefined();
    expect(none.payload).toBe(big);
    const tiny = await app.inject({ method: 'GET', url: '/small', headers: { 'accept-encoding': 'br' } });
    expect(tiny.headers['content-encoding']).toBeUndefined();
    expect(tiny.json()).toEqual({ ok: true });
  });
});
