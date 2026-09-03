import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as http from 'http';
import * as https from 'https';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { isPrivateIp, isBlockedHost, normalizeUrl, extractUrls, queueLinkPreviewFetch, parseHtml, checkSsrfForUrl } from '../src/services/linkPreview.js';
import type { Pool } from 'pg';

describe('linkPreview', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let adminToken: string;
  let userPat: string;
  let pool: Pool;

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop;
    pool = db.pool;
    app = await buildServer({ pool: db.pool });
    ({ token: adminToken } = await bootstrapAdmin(app));
    const user = await createAgent(app, adminToken, 'linkuser');
    userPat = user.pat;
  });

  afterAll(async () => { await app.close(); await stop(); });

  beforeEach(async () => {
    await pool.query('delete from link_preview');
  });

  describe('isPrivateIp (회귀 테스트 #1)', () => {
    it('사설 IP 대역이면 true', () => {
      expect(isPrivateIp('10.0.0.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('172.31.0.1')).toBe(true);
      expect(isPrivateIp('192.168.0.1')).toBe(true);
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('169.254.0.1')).toBe(true);
    });

    it('공용 IP 는 false', () => {
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('93.184.216.34')).toBe(false);
    });
  });

  describe('isBlockedHost (회귀 테스트 #1 관련)', () => {
    it('차단된 호스트이면 true', () => {
      expect(isBlockedHost('localhost')).toBe(true);
      expect(isBlockedHost('metadata.google.internal')).toBe(true);
      expect(isBlockedHost('169.254.169.254')).toBe(true);
    });

    it('차단되지 않은 호스트는 false', () => {
      expect(isBlockedHost('example.com')).toBe(false);
      expect(isBlockedHost('google.com')).toBe(false);
    });
  });

  describe('checkSsrfForUrl (회귀 테스트 #2 - redirect hop)', () => {
    it('차단 호스트이면 false', async () => {
      vi.mock('dns', () => ({
        Resolver: vi.fn(() => ({
          resolve4: vi.fn((hostname, cb) => cb(null, ['8.8.8.8'])),
          resolve6: vi.fn((hostname, cb) => cb(null, [])),
        })),
      }));
      const { checkSsrfForUrl: checkSsrf } = await import('../src/services/linkPreview.js');
      const result = await checkSsrf('https://localhost/path');
      expect(result).toBe(false);
      vi.resetModules();
    });

    it('공용 IP는 true', async () => {
      vi.mock('dns', () => ({
        Resolver: vi.fn(() => ({
          resolve4: vi.fn((hostname, cb) => cb(null, ['8.8.8.8'])),
          resolve6: vi.fn((hostname, cb) => cb(null, [])),
        })),
      }));
      const { checkSsrfForUrl: checkSsrf } = await import('../src/services/linkPreview.js');
      const result = await checkSsrf('https://example.com/page');
      expect(result).toBe(true);
      vi.resetModules();
    });
  });

  describe('normalizeUrl', () => {
    it('기본 포트 제거', () => {
      expect(normalizeUrl('https://example.com:443/path')).toBe('https://example.com/path');
      expect(normalizeUrl('http://example.com:80/path')).toBe('http://example.com/path');
    });

    it('fragment 제거', () => {
      expect(normalizeUrl('https://example.com/path#section')).toBe('https://example.com/path');
    });

    it('프로토콜 필터링', () => {
      expect(normalizeUrl('ftp://example.com')).toBeNull();
      expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    });
  });

  describe('extractUrls', () => {
    it('본문에서 URL 추출', () => {
      const urls = extractUrls('Check https://example.com and http://test.io please');
      expect(urls).toContain('https://example.com');
      expect(urls).toContain('http://test.io');
    });

    it('중복 제거', () => {
      const urls = extractUrls('See https://example.com and again https://example.com');
      expect(urls).toHaveLength(1);
    });

    it('최대 3개로 제한', () => {
      const urls = extractUrls('a https://a.com b https://b.com c https://c.com d https://d.com');
      expect(urls).toHaveLength(3);
    });
  });

  describe('queueLinkPreviewFetch (회귀 테스트 #5)', () => {
    it('같은 URL 두 번 요청해도 첫 번째만 fetch', async () => {
      await queueLinkPreviewFetch(pool, 'https://example.com');
      await queueLinkPreviewFetch(pool, 'https://example.com');
      const result = await pool.query('select count(*) as cnt from link_preview');
      expect(parseInt(result.rows[0].cnt, 10)).toBe(1);
    });
  });

  describe('POST /channels/:id/messages 에서 링크 추출 (회귀 테스트 #6)', () => {
    it('URL 이 있으면 postMessage 가 즉시 반환됨', async () => {
      const channelRes = await app.inject({
        method: 'POST',
        url: '/channels',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: 'test-link-channel', topic: '' },
      });
      const channelId = channelRes.json().id;

      const start = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: `/channels/${channelId}/messages`,
        headers: { authorization: `Bearer ${userPat}` },
        payload: { body: 'Check https://example.com please' },
      });
      const duration = Date.now() - start;

      expect(res.statusCode).toBe(201);
      expect(duration).toBeLessThan(2000);
    });
  });

  describe('GET /link-previews (회귀 테스트 #7)', () => {
    it('인증 없이는 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/link-previews?url=https://example.com',
      });
      expect(res.statusCode).toBe(401);
    });

    it('인증 있으면 404 (미리보기 없음)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/link-previews?url=https://nonexistent.example.com',
        headers: { authorization: `Bearer ${userPat}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('parseHtml (회귀 테스트 #3)', () => {
    it('og:title 이 있으면 그것을 사용', () => {
      const html = '<html><head><meta property="og:title" content="OG Title"><title>Tag Title</title></head></html>';
      const result = parseHtml(html, 'https://example.com');
      expect(result.title).toBe('OG Title');
    });

    it('og:title 이 없으면 <title> 사용', () => {
      const html = '<html><head><title>Tag Title</title></head></html>';
      const result = parseHtml(html, 'https://example.com');
      expect(result.title).toBe('Tag Title');
    });

    it('HTML 엔티티 디코드', () => {
      const html = '<html><head><meta property="og:title" content="Hello &amp; World"></head></html>';
      const result = parseHtml(html, 'https://example.com');
      expect(result.title).toBe('Hello & World');
    });

    it('200자 초과 자르기', () => {
      const longTitle = 'A'.repeat(300);
      const html = `<html><head><meta property="og:title" content="${longTitle}"></head></html>`;
      const result = parseHtml(html, 'https://example.com');
      expect(result.title?.length).toBe(200);
    });

    it('512KB 이상 본문도 파싱 가능 (회귀 테스트 #4)', () => {
      const largeBody = 'x'.repeat(600 * 1024);
      const html = `<html><head><meta property="og:title" content="Test Title"></head><body>${largeBody}</body></html>`;
      const result = parseHtml(html, 'https://example.com');
      expect(result.title).toBe('Test Title');
    });
  });
});