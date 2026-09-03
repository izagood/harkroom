// 링크 미리보기(#215) — 서버 쪽 보증.
//
// **네트워크를 치지 않는다.** `PreviewNet`(services/linkPreview.ts) 이 이 파일이 밖으로
// 나가는 모든 길이고, 여기서는 그 경계를 가짜로 갈아끼워 SSRF 판정과 리다이렉트 흐름을
// **실제 코드 경로로** 태운다. 예외는 하나: 512KB·5초 기제는 실제 소켓에서만 확인할 수
// 있으므로 127.0.0.1 의 임시 서버로 시험한다(외부 네트워크가 아니다).
//
// 초판의 테스트는 `isPrivateIp('10.0.0.1')` 같은 순수 함수만 태워서, **가드를 fetch 경로에서
// 떼어내도 전부 초록**이었다. 여기서는 매 항목이 `fetchLinkPreview` 를 지난다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import * as http from 'node:http';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import {
  fetchLinkPreview, queueLinkPreviewFetch, parseHtml, isBlockedAddress, isBlockedHost,
  normalizeUrl, extractUrls, httpFetchHop, MAX_BODY_BYTES, TIMEOUT_MS, MAX_REDIRECTS,
  type PreviewNet, type HopResult, isStale, TTL_OK_MS, TTL_FAILED_MS,
} from '../src/services/linkPreview.js';

/** 가짜 네트워크 경계. 호출 기록을 남겨 "가져가지 않았다"를 단언할 수 있게 한다. */
function fakeNet(opts: {
  resolve?: (host: string) => string[] | Promise<string[]>;
  hop?: (req: { url: string; host: string; ip: string }, n: number) => HopResult;
}): PreviewNet & { resolved: string[]; hops: { url: string; host: string; ip: string }[] } {
  const resolved: string[] = [];
  const hops: { url: string; host: string; ip: string }[] = [];
  return {
    resolved,
    hops,
    async resolve(host) {
      resolved.push(host);
      return opts.resolve ? opts.resolve(host) : ['93.184.216.34'];
    },
    async fetchHop(req) {
      hops.push(req);
      return opts.hop
        ? opts.hop(req, hops.length - 1)
        : { status: 200, location: null, body: '<title>ok</title>' };
    },
  };
}

const PAGE = '<html><head><meta property="og:title" content="Hello"></head></html>';

describe('SSRF 가드 (요구 1)', () => {
  it('사설 IP 로 해석되는 호스트는 blocked 이고 **가져오지 않는다**', async () => {
    const net = fakeNet({ resolve: () => ['10.0.0.7'] });
    const p = await fetchLinkPreview('https://evil.example/x', net);
    expect(p?.status).toBe('blocked');
    expect(net.hops).toHaveLength(0); // 가드를 빼면 여기가 1 이 된다
  });

  // 초판의 진짜 구멍: 호스트가 IP 리터럴이면 DNS 해석이 실패하고, 그 실패를 "안전"으로
  // 읽어 그대로 가져갔다. `URL` 은 10진수·16진수 IPv4 도 점 표기로 정규화한다.
  it.each([
    ['http://169.254.169.254/latest/meta-data/', '클라우드 메타데이터'],
    ['http://127.0.0.1/', '루프백'],
    ['http://2130706433/', '10진수 표기'],
    ['http://0x7f000001/', '16진수 표기'],
    ['http://[::1]/', 'IPv6 루프백'],
    ['http://[::ffff:10.0.0.1]/', 'IPv4-mapped IPv6'],
    ['http://[fd00::1]/', 'ULA(fc00::/7 — fd00 이 실제로 쓰인다)'],
    ['http://[fe9f::1]/', '링크로컬(fe80::/10 — fe80 만 비교하면 샌다)'],
    ['http://192.168.1.1/', '사설'],
    ['http://10.0.0.1/', '사설'],
  ])('IP 리터럴 %s 는 blocked (%s)', async (url) => {
    const net = fakeNet({});
    const p = await fetchLinkPreview(url, net);
    expect(p?.status).toBe('blocked');
    expect(net.hops).toHaveLength(0);
  });

  it('이름으로 막는 호스트(localhost 별칭)도 가져오지 않는다', async () => {
    for (const url of ['http://localhost/x', 'http://foo.localhost/x', 'http://db.internal/x']) {
      const net = fakeNet({});
      expect((await fetchLinkPreview(url, net))?.status).toBe('blocked');
      expect(net.hops).toHaveLength(0);
    }
  });

  // 첫 A 레코드만 보면 두 번째 레코드로 우회할 수 있다.
  it('해석 결과 중 **하나라도** 막힌 대역이면 blocked', async () => {
    const net = fakeNet({ resolve: () => ['93.184.216.34', '10.1.2.3'] });
    expect((await fetchLinkPreview('https://mixed.example/', net))?.status).toBe('blocked');
    expect(net.hops).toHaveLength(0);
  });

  it('해석 실패는 failed 다 — **ok 로 흘리지 않는다**', async () => {
    const net = fakeNet({ resolve: () => [] });
    const p = await fetchLinkPreview('https://nx.example/', net);
    expect(p?.status).toBe('failed');
    expect(net.hops).toHaveLength(0);
  });

  it('http/https 가 아닌 스킴과 자격증명이 실린 URL 은 가져오지 않는다', async () => {
    const net = fakeNet({});
    expect(await fetchLinkPreview('ftp://example.com/x', net)).toBeNull();
    expect(await fetchLinkPreview('file:///etc/passwd', net)).toBeNull();
    // `user:pass@` 는 **거절**한다(벗겨서 가져오면 사람이 본 링크와 다른 자원을 보여 준다).
    expect(await fetchLinkPreview('http://user:pass@example.com/', net)).toBeNull();
    expect(net.hops).toHaveLength(0);
  });

  it('공인 IP 는 통과하고, 검사한 그 IP 로 붙는다', async () => {
    const net = fakeNet({ resolve: () => ['93.184.216.34'], hop: () => ({ status: 200, location: null, body: PAGE }) });
    const p = await fetchLinkPreview('https://example.com/a', net);
    expect(p?.status).toBe('ok');
    expect(p?.title).toBe('Hello');
    expect(net.hops[0]).toEqual({ url: 'https://example.com/a', host: 'example.com', ip: '93.184.216.34' });
  });
});

describe('리다이렉트 (요구 2)', () => {
  it('hop 마다 다시 검사한다 — **마지막 hop 만** 사설이어도 blocked', async () => {
    let n = 0;
    const net = fakeNet({
      resolve: (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']),
      hop: () => {
        n += 1;
        if (n === 1) return { status: 302, location: 'https://b.example/2', body: '' };
        if (n === 2) return { status: 302, location: 'https://internal.example/3', body: '' };
        return { status: 200, location: null, body: PAGE };
      },
    });
    const p = await fetchLinkPreview('https://a.example/1', net);
    expect(p?.status).toBe('blocked');
    // 두 hop 만 실제로 가져왔다 — 세 번째는 검사에서 막혔다.
    expect(net.hops.map((h) => h.host)).toEqual(['a.example', 'b.example']);
  });

  it('IP 리터럴로 가는 리다이렉트도 blocked', async () => {
    const net = fakeNet({
      hop: (_r, i) => (i === 0
        ? { status: 302, location: 'http://169.254.169.254/latest/', body: '' }
        : { status: 200, location: null, body: PAGE }),
    });
    expect((await fetchLinkPreview('https://a.example/1', net))?.status).toBe('blocked');
    expect(net.hops).toHaveLength(1);
  });

  it(`리다이렉트는 최대 ${MAX_REDIRECTS} 회 — 그 뒤로는 따라가지 않는다`, async () => {
    const net = fakeNet({
      hop: (_r, i) => ({ status: 302, location: `https://a.example/${i + 2}`, body: '' }),
    });
    const p = await fetchLinkPreview('https://a.example/1', net);
    expect(p?.status).toBe('failed');
    expect(net.hops).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('저장 키는 **처음 정규화한 URL** 이다 — 리다이렉트 뒤 주소가 아니다', async () => {
    const net = fakeNet({
      hop: (_r, i) => (i === 0
        ? { status: 301, location: 'https://example.com/final', body: '' }
        : { status: 200, location: null, body: PAGE }),
    });
    const p = await fetchLinkPreview('https://Example.com/start#frag', net);
    expect(p?.url).toBe('https://example.com/start');
  });
});

// **TOCTOU.** "해석해서 검사한 뒤 URL 로 다시 fetch" 하면 두 번째 해석이 사설 IP 를 줄 수
// 있다(DNS rebinding). 이 구조는 hop 마다 **한 번** 해석하고 그 IP 를 fetch 에 넘긴다 —
// 두 번째 해석이 존재하지 않으므로 창이 닫힌다.
describe('DNS rebinding (TOCTOU)', () => {
  it('첫 해석이 공인, 두 번째가 사설이어도 사설로 붙지 않는다', async () => {
    let call = 0;
    const net = fakeNet({
      resolve: () => { call += 1; return call === 1 ? ['93.184.216.34'] : ['10.0.0.9']; },
      hop: () => ({ status: 200, location: null, body: PAGE }),
    });
    const p = await fetchLinkPreview('https://rebind.example/', net);
    expect(p?.status).toBe('ok');
    // hop 당 해석은 한 번이고, fetch 는 검사된 그 IP 를 받는다.
    expect(net.resolved).toHaveLength(1);
    expect(net.hops[0]!.ip).toBe('93.184.216.34');
  });

  // 위 단언은 "IP 를 넘긴다"까지다. 실제 fetcher 가 그 IP 로 **붙는지**는 소켓으로만 안다:
  // 존재하지 않는 이름을 127.0.0.1 로 못박아 임시 서버가 받으면 못박기가 실재한다.
  it('기본 fetcher 는 넘겨받은 IP 로 붙고 Host 헤더에 원래 이름을 넣는다', async () => {
    let seenHost = '';
    const server = http.createServer((req, res) => {
      seenHost = req.headers.host ?? '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await httpFetchHop({
        url: `http://pinned.invalid:${port}/`, host: 'pinned.invalid', ip: '127.0.0.1',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('og:title');
      expect(seenHost).toContain('pinned.invalid');
    } finally {
      server.close();
    }
  });
});

describe('본문 한계와 시한 (요구 4)', () => {
  it('상수는 512KB·5초다', () => {
    expect(MAX_BODY_BYTES).toBe(512 * 1024);
    expect(TIMEOUT_MS).toBe(5_000);
  });

  it('한계를 넘는 본문은 끊고, promise 는 **반드시 끝난다**', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      // 계속 흘려보낸다 — 끊지 않으면 이 응답은 끝나지 않는다.
      const chunk = 'x'.repeat(64 * 1024);
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await httpFetchHop(
        { url: `http://capped.invalid:${port}/`, host: 'capped.invalid', ip: '127.0.0.1' },
        { maxBytes: 4096, timeoutMs: 4000 },
      );
      // 끊긴 뒤에도 resolve 된다(초판은 destroy 뒤 'end' 가 오지 않아 영원히 걸렸다).
      expect(res.body.length).toBe(4096);
    } finally {
      server.close();
    }
  }, 10_000);

  it('시한이 지나면 있는 것만 들고 끝낸다 — 유휴가 아니라 총 시간이다', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      // 1바이트씩 계속 보낸다: 소켓은 유휴가 되지 않으므로 `setTimeout` 만으로는 안 끊긴다.
      const timer = setInterval(() => res.write('x'), 5);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const started = Date.now();
      const res = await httpFetchHop(
        { url: `http://slow.invalid:${port}/`, host: 'slow.invalid', ip: '127.0.0.1' },
        { timeoutMs: 300 },
      );
      expect(Date.now() - started).toBeLessThan(3000);
      expect(res.body.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  }, 10_000);
});

describe('파싱 (요구 3)', () => {
  it('og:title 이 있으면 그것을, 없으면 <title> 을 쓴다', () => {
    expect(parseHtml('<meta property="og:title" content="OG"><title>Tag</title>', 'u').title).toBe('OG');
    expect(parseHtml('<title>Tag</title>', 'u').title).toBe('Tag');
    expect(parseHtml('<html></html>', 'u').title).toBeNull();
  });

  it('content 가 앞에 오는 속성 순서도 읽는다', () => {
    expect(parseHtml('<meta content="OG" property="og:title">', 'u').title).toBe('OG');
  });

  it('og:description → meta[name=description] 순서', () => {
    expect(parseHtml('<meta property="og:description" content="A"><meta name="description" content="B">', 'u')
      .description).toBe('A');
    expect(parseHtml('<meta name="description" content="B">', 'u').description).toBe('B');
  });

  it('엔티티는 디코드하고 **태그는 전부 제거한다**', () => {
    // 디코드만 하고 제거하지 않으면 카드 문자열에 마크업이 남는다 — 그리는 쪽이 언젠가
    // innerHTML 로 바뀌는 날 XSS 다. 저장하는 자리에서 없앤다.
    const html = '<meta property="og:title" content="Hi &lt;script&gt;alert(1)&lt;/script&gt; there">';
    const title = parseHtml(html, 'u').title!;
    expect(title).not.toContain('<');
    expect(title).not.toContain('script>');
    expect(title).toBe('Hi alert(1) there');
    expect(parseHtml('<meta property="og:title" content="A &amp; B">', 'u').title).toBe('A & B');
    // `&amp;lt;` 는 글자 `&lt;` 다 — 두 번 디코드해 태그로 만들지 않는다.
    expect(parseHtml('<meta property="og:title" content="&amp;lt;b&amp;gt;">', 'u').title).toBe('&lt;b&gt;');
  });

  it('값은 200자로 자른다', () => {
    const html = `<meta property="og:title" content="${'A'.repeat(300)}">`;
    expect(parseHtml(html, 'u').title).toHaveLength(200);
  });

  it('빈 값은 null 이다 — 빈 문자열을 카드에 넣지 않는다', () => {
    expect(parseHtml('<meta property="og:title" content="">', 'u').title).toBeNull();
    expect(parseHtml('<title>   </title>', 'u').title).toBeNull();
  });

  it('본문이 512KB 로 잘려도 head 의 og 태그는 읽힌다', () => {
    const html = `<head><meta property="og:title" content="Test"></head><body>${'x'.repeat(600 * 1024)}`;
    expect(parseHtml(html.slice(0, MAX_BODY_BYTES), 'u').title).toBe('Test');
  });
});

describe('정규화와 추출', () => {
  it('기본 포트·fragment·후행 점·대문자를 정규화한다', () => {
    expect(normalizeUrl('https://Example.COM:443/p#frag')).toBe('https://example.com/p');
    expect(normalizeUrl('http://example.com:80/p')).toBe('http://example.com/p');
    expect(normalizeUrl('http://example.com./p')).toBe('http://example.com/p');
  });

  it('IP 표기를 점 표기로 정규화한다 — 표기를 바꿔 우회할 수 없다', () => {
    expect(normalizeUrl('http://2130706433/')).toBe('http://127.0.0.1/');
    expect(normalizeUrl('http://0x7f000001/')).toBe('http://127.0.0.1/');
  });

  it('미리보기 대상이 아닌 URL 은 null', () => {
    expect(normalizeUrl('ftp://example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('http://user:pass@example.com/')).toBeNull();
  });

  // **서버와 데스크탑이 같은 함수를 쓴다.** 후행 문장부호를 떼지 않으면 클라이언트가
  // `…/b.` 로 조회해 카드가 영원히 404 다.
  it('문장 끝의 마침표는 URL 이 아니다', () => {
    expect(extractUrls('자세히는 https://a.io/b.')).toEqual(['https://a.io/b']);
    expect(extractUrls('(https://a.io/b)')).toEqual(['https://a.io/b']);
  });

  it('중복은 정규화 후 하나이고, 최대 3개다', () => {
    expect(extractUrls('https://a.io/x 와 https://A.io/x#f')).toEqual(['https://a.io/x']);
    expect(extractUrls('https://a.io https://b.io https://c.io https://d.io')).toHaveLength(3);
  });

  it('http/https 아닌 후보는 집지 않는다', () => {
    expect(extractUrls('javascript:alert(1) murmur://message/x mailto:a@b.io')).toEqual([]);
  });

  it('isBlockedAddress·isBlockedHost 는 판정할 수 없는 값을 막는다(fail-closed)', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedHost('LOCALHOST.')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
  });
});

describe('DB·라우트·큐', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let pool: Pool;
  let adminToken: string;
  let userPat: string;

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop;
    pool = db.pool;
    app = await buildServer({ pool: db.pool });
    ({ token: adminToken } = await bootstrapAdmin(app));
    ({ pat: userPat } = await createAgent(app, adminToken, 'linkuser'));
  });

  afterAll(async () => { await app.close(); await stop(); });
  beforeEach(async () => { await pool.query('delete from link_preview'); });

  // 요구 5.
  it('같은 URL 을 두 번 큐에 넣어도 **가져오기는 한 번**이다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: PAGE }) });
    await queueLinkPreviewFetch(pool, 'https://example.com/one', net);
    await queueLinkPreviewFetch(pool, 'https://example.com/one', net);
    // 정규화 후 같은 URL 도 마찬가지다(대문자 호스트·fragment).
    await queueLinkPreviewFetch(pool, 'https://EXAMPLE.com/one#x', net);
    expect(net.hops).toHaveLength(1);
    const rows = await pool.query('select count(*)::int as n from link_preview');
    expect(rows.rows[0].n).toBe(1);
  });

  it('동시에 두 번 들어와도 한 번만 가져온다', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const net = fakeNet({});
    const slow: PreviewNet = {
      resolve: net.resolve.bind(net),
      async fetchHop(req) { await gate; return net.fetchHop(req); },
    };
    const both = Promise.all([
      queueLinkPreviewFetch(pool, 'https://example.com/two', slow),
      queueLinkPreviewFetch(pool, 'https://example.com/two', slow),
    ]);
    release();
    await both;
    expect(net.hops).toHaveLength(1);
  });

  // 초판은 '진행 중' 표시로 빈 `ok` 행을 미리 넣었다 — 클라이언트가 내용 없는 카드를 받고,
  // 가져오는 중에 서버가 죽으면 그 URL 은 영원히 빈 `ok` 로 굳었다.
  it('가져오기 전에 빈 행을 만들지 않는다', async () => {
    let seen: number | null = null;
    const net: PreviewNet = {
      async resolve() { return ['93.184.216.34']; },
      async fetchHop() {
        seen = (await pool.query('select count(*)::int as n from link_preview')).rows[0].n;
        return { status: 200, location: null, body: PAGE };
      },
    };
    await queueLinkPreviewFetch(pool, 'https://example.com/three', net);
    expect(seen).toBe(0);
  });

  it('blocked 도 저장한다 — 매 메시지마다 다시 해석하지 않기 위해서다', async () => {
    const net = fakeNet({ resolve: () => ['10.0.0.1'] });
    await queueLinkPreviewFetch(pool, 'https://internal.example/x', net);
    const row = await pool.query('select status, title from link_preview where url = $1', ['https://internal.example/x']);
    expect(row.rows[0].status).toBe('blocked');
    expect(row.rows[0].title).toBeNull();
  });

  // 요구 6.
  it('postMessage 는 가져오기 지연에 영향받지 않는다', async () => {
    const ch = await app.inject({
      method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'link-ch' },
    });
    const channelId = ch.json().id;
    const started = Date.now();
    const res = await app.inject({
      method: 'POST', url: `/channels/${channelId}/messages`,
      headers: { authorization: `Bearer ${userPat}` },
      payload: { body: 'Check https://example.com/slow please' },
    });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(201);
    // 가져오기는 트랜잭션 밖에서 await 되지 않고 돌아간다. 5초 시한이 응답에 얹히면 여기서 걸린다.
    expect(elapsed).toBeLessThan(2000);
  });

  // 요구 7.
  it('GET /link-previews 는 인증을 요구한다', async () => {
    expect((await app.inject({ method: 'GET', url: '/link-previews?url=https://example.com' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: '/link-previews?url=https://example.com',
      headers: { authorization: `Bearer ${userPat}` },
    })).statusCode).toBe(404); // 인증은 통과, 아직 카드가 없다
  });

  it('조회 키를 정규화한다 — 대문자·fragment 로 물어도 같은 카드가 온다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: PAGE }) });
    await queueLinkPreviewFetch(pool, 'https://example.com/four', net);
    for (const q of ['https://example.com/four', 'https://EXAMPLE.com/four', 'https://example.com/four#frag']) {
      const res = await app.inject({
        method: 'GET', url: `/link-previews?url=${encodeURIComponent(q)}`,
        headers: { authorization: `Bearer ${userPat}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe('Hello');
    }
  });

  it('미리보기 대상이 아닌 URL 은 400 이다 — 404 와 뭉개지 않는다', async () => {
    const res = await app.inject({
      method: 'GET', url: `/link-previews?url=${encodeURIComponent('javascript:alert(1)')}`,
      headers: { authorization: `Bearer ${userPat}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('url 없이 부르면 400 이다(500 이 아니다)', async () => {
    const res = await app.inject({
      method: 'GET', url: '/link-previews', headers: { authorization: `Bearer ${userPat}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('캐시 만료 (#312)', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let pool: Pool;
  let adminToken: string;
  let userPat: string;

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop;
    pool = db.pool;
    app = await buildServer({ pool: db.pool });
    ({ token: adminToken } = await bootstrapAdmin(app));
    ({ pat: userPat } = await createAgent(app, adminToken, 'ttluser'));
  });

  afterAll(async () => { await app.close(); await stop(); });

  // TTL 상수 확인
  it('TTL_OK_MS 는 7일, TTL_FAILED_MS 는 1시간', () => {
    expect(TTL_OK_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(TTL_FAILED_MS).toBe(60 * 60 * 1000);
  });

  // isStale 순수 함수 tests
  it('ok 는 7일 이후에 만료, 그 전에는 fresh', () => {
    const now = Date.now();
    const freshOk = { url: 'x', title: 't', description: null, imageUrl: null, siteName: null, status: 'ok' as const, fetchedAt: new Date(now - TTL_OK_MS + 1) };
    const staleOk = { url: 'x', title: 't', description: null, imageUrl: null, siteName: null, status: 'ok' as const, fetchedAt: new Date(now - TTL_OK_MS - 1) };
    expect(isStale(freshOk, now)).toBe(false);
    expect(isStale(staleOk, now)).toBe(true);
  });

  it('failed/blocked 는 1시간 이후에 만료', () => {
    const now = Date.now();
    const freshFailed = { url: 'x', title: null, description: null, imageUrl: null, siteName: null, status: 'failed' as const, fetchedAt: new Date(now - TTL_FAILED_MS + 1) };
    const staleFailed = { url: 'x', title: null, description: null, imageUrl: null, siteName: null, status: 'failed' as const, fetchedAt: new Date(now - TTL_FAILED_MS - 1) };
    const staleBlocked = { url: 'x', title: null, description: null, imageUrl: null, siteName: null, status: 'blocked' as const, fetchedAt: new Date(now - TTL_FAILED_MS - 1) };
    expect(isStale(freshFailed, now)).toBe(false);
    expect(isStale(staleFailed, now)).toBe(true);
    expect(isStale(staleBlocked, now)).toBe(true);
  });

  // 회귀 테스트 1: 만료된 failed 가 다시 시도된다
  it('만료된 failed 를 다시 큐에 넣으면 fetch 가 불린다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: PAGE }) });
    // 만료된 failed 행을 수동으로 넣는다
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['https://example.com/expired', null, null, null, null, 'failed', new Date(Date.now() - TTL_FAILED_MS - 1000)],
    );
    // 이제 큐에 넣으면 다시 가져와야 한다
    const before = Date.now();
    await queueLinkPreviewFetch(pool, 'https://example.com/expired', net);
    expect(net.hops).toHaveLength(1); // 만료되었으니 다시 가져온다
    // 저장된 행이 ok 로 바뀌었는지 확인
    const row = await pool.query('select status from link_preview where url = $1', ['https://example.com/expired']);
    expect(row.rows[0].status).toBe('ok');
  });

  // 회귀 테스트 2: 만료 안 된 ok 는 fetch 를 부르지 않는다
  it('만료 안 된 ok 는 fetch 를 부르지 않는다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: PAGE }) });
    // fresh ok 행을 수동으로 넣는다
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['https://example.com/fresh', 'Fresh Title', null, null, null, 'ok', new Date()],
    );
    await queueLinkPreviewFetch(pool, 'https://example.com/fresh', net);
    expect(net.hops).toHaveLength(0); // fresh 니까 다시 가져오지 않는다
  });

  // 회귀 테스트 3: 만료된 blocked 재검사에서 여전히 사설 IP 면 다시 blocked — 가드를 통과한다
  it('만료된 blocked 재검사에서 사설 IP 면 다시 blocked (가드 통과)', async () => {
    const net = fakeNet({ resolve: () => ['10.0.0.1'] }); // 사설 IP 로 해석
    // 만료된 blocked 행을 수동으로 넣는다
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['https://private.example/blocked', null, null, null, null, 'blocked', new Date(Date.now() - TTL_FAILED_MS - 1000)],
    );
    await queueLinkPreviewFetch(pool, 'https://private.example/blocked', net);
    // fetchHop 은 불리지 않아야 한다 (가드에서 막혀서)
    expect(net.hops).toHaveLength(0);
    // 그래도 blocked 로 남아 있어야 한다
    const row = await pool.query('select status from link_preview where url = $1', ['https://private.example/blocked']);
    expect(row.rows[0].status).toBe('blocked');
  });

  // 회귀 테스트 4: 만료 재조회가 행을 지우지 않는다 (같은 url 로 갱신된다)
  it('만료 재조회가 행을 지우지 않고 갱신한다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: '<title>New Title</title>' }) });
    const oldUrl = 'https://example.com/update';
    // 만료된 failed 행을 넣고
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [oldUrl, 'Old Title', 'old desc', null, null, 'failed', new Date(Date.now() - TTL_FAILED_MS - 1000)],
    );
    // **SQL 을 엿본다.** 행 개수만 세면 "지웠다 다시 넣기"를 구분하지 못한다 — 그 구현은
    // 삭제와 삽입 사이에 조회가 404 를 보는 구멍이고, 그것이 이 요구가 막는 것이다.
    const seen: string[] = [];
    const realQuery = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '');
      seen.push(sql);
      return (realQuery as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await queueLinkPreviewFetch(pool, oldUrl, net);
    } finally {
      (pool as unknown as { query: unknown }).query = realQuery;
    }
    expect(seen.some((sql) => /delete\s+from\s+link_preview/i.test(sql))).toBe(false);
    // 행이 삭제되지 않고 갱신되었는지 확인
    const rows = await pool.query('select count(*)::int as n from link_preview where url = $1', [oldUrl]);
    expect(rows.rows[0].n).toBe(1); // 행은 하나만 있어야 한다
    const row = await pool.query('select title, status from link_preview where url = $1', [oldUrl]);
    expect(row.rows[0].title).toBe('New Title');
    expect(row.rows[0].status).toBe('ok');
  });

  // 회귀 테스트 5: 동시 조회 열 건에 fetch 는 한 번 (in-flight 중복 방지)
  it('동시에 열 번 queueLinkPreviewFetch 해도 fetch 는 한 번', async () => {
    const net = fakeNet({});
    const slow: PreviewNet = {
      resolve: net.resolve.bind(net),
      async fetchHop(req) {
        await new Promise((r) => setTimeout(r, 50));
        return net.fetchHop(req);
      },
    };
    // 만료된 행을 넣어둔다
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['https://example.com/concurrent', null, null, null, null, 'failed', new Date(Date.now() - TTL_FAILED_MS - 1000)],
    );
    // 동시에 10번 호출
    const promises = Array.from({ length: 10 }, () => queueLinkPreviewFetch(pool, 'https://example.com/concurrent', slow));
    await Promise.all(promises);
    // fetchHop 은 한 번만 불려야 한다
    expect(net.hops).toHaveLength(1);
  });

  // 라우트에서 만료 시 재조회 테스트
  it('GET /link-previews 에서 만료된 행은 백그라운드에서 재조회된다', async () => {
    const net = fakeNet({ hop: () => ({ status: 200, location: null, body: '<title>Fetched</title>' }) });
    // 가짜 네트워크를 라우트에 주입한다
    (app as any).linkPreviewNet = net;
    // 만료된 ok 행을 넣는다
    await pool.query(
      `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['https://example.com/route', 'Old', null, null, null, 'ok', new Date(Date.now() - TTL_OK_MS - 1000)],
    );
    // 조회가 stale trigger
    const res = await app.inject({
      method: 'GET', url: '/link-previews?url=https://example.com/route',
      headers: { authorization: `Bearer ${userPat}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Old'); // 먼저 stale 데이터를 반환
    // background 에서 재조회되길 기다린다
    await new Promise((r) => setTimeout(r, 100));
    expect(net.hops).toHaveLength(1); // 백그라운드에서 가져옴
    const row = await pool.query('select title from link_preview where url = $1', ['https://example.com/route']);
    expect(row.rows[0].title).toBe('Fetched');
  });
});
