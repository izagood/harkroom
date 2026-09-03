// 링크 미리보기(#215) — **서버가 가져온다.**
//
// 클라이언트가 가져오면 그 링크를 본 사람마다 자기 IP 로 임의의 서버를 치게 되고, 에이전트가
// 올린 링크가 사람의 기기를 아무 주소로나 접속시키는 길이 된다. 서버가 한 번 가져와 저장하고
// 모두에게 같은 카드를 준다.
//
// **그 대가로 이 파일은 서버가 임의 URL 을 가져오는 유일한 자리다.** SSRF 방어가 여기 전부
// 모여 있고, 각 규칙 옆에 왜 그런지 적어 둔다. 규칙을 다른 파일로 흩으면 어느 것이 실제로
// 걸리는지 아무도 확인할 수 없게 된다.
import type { Pool } from 'pg';
import { Resolver } from 'node:dns';
import * as https from 'node:https';
import * as http from 'node:http';
import { isIP } from 'node:net';
import { normalizePreviewUrl } from '@murmur/shared';
import { emitEvent } from '../events.js';

export type LinkPreviewStatus = 'ok' | 'failed' | 'blocked';

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  status: LinkPreviewStatus;
  fetchedAt: Date;
};

/** 본문 최대 512KB. 넘으면 **끊고 있는 것만** 파싱한다 — og 태그는 head 에 있다. */
export const MAX_BODY_BYTES = 512 * 1024;
/** 한 hop 의 전체 시한 5초. 소켓 유휴가 아니라 **총 시간**이다(아래 이유 참고). */
export const TIMEOUT_MS = 5_000;
/** 리다이렉트 최대 3회. 4번째 hop 은 따라가지 않는다. */
export const MAX_REDIRECTS = 3;
/** 값은 200자로 자른다 — 카드 한 장에 들어갈 양이다. */
export const MAX_FIELD_LENGTH = 200;

const USER_AGENT = 'murmur-link-preview';

/**
 * 이름만으로 막는 호스트. **주소 판정의 보조**일 뿐이다 — 진짜 판정은 해석된 주소가 한다.
 * 여기 있는 이유: `localhost` 계열은 해석 결과가 환경마다 다르고(hosts 파일), 클라우드
 * 메타데이터 이름은 링크 미리보기가 볼 이유가 애초에 없다.
 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'localdomain',
  'local',
  'internal',
  'metadata.google.internal',
  'kubernetes.default.svc',
];

/** 호스트명 정규화 — **판정 앞에** 둔다. */
function hostOf(url: URL): string {
  // IPv6 는 `url.hostname` 이 대괄호를 포함한다(`[::1]`). 주소 판정은 대괄호를 모른다.
  // 후행 점(`example.com.`)은 DNS 상 같은 이름이므로 뗀다 — 남겨 두면 접미사 비교가 어긋난다.
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

function isBlockedHostName(host: string): boolean {
  return BLOCKED_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

/** IPv4 점 표기를 4바이트로. 형식이 아니면 null. */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

/**
 * 가져오면 안 되는 IPv4 대역인가. **허용 목록이 아니라 거절 목록**인 것은 의도다 —
 * 공인 주소 전체를 열거할 수는 없다. 대신 "내부에서만 의미가 있는" 대역을 전부 적는다.
 */
function isBlockedIpv4(ip: string): boolean {
  const o = parseIpv4(ip);
  if (!o) return true; // 파싱되지 않는 주소로는 접속하지 않는다
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true;                                  // 0.0.0.0/8 — "이 호스트"
  if (a === 10) return true;                                 // 사설
  if (a === 127) return true;                                // 루프백
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;                    // 링크로컬 = 클라우드 메타데이터
  if (a === 172 && b >= 16 && b <= 31) return true;           // 사설
  if (a === 192 && b === 168) return true;                    // 사설
  if (a === 192 && b === 0) return true;                      // 192.0.0/24 프로토콜 배정, 192.0.2/24 문서용
  if (a === 198 && (b === 18 || b === 19)) return true;        // 198.18/15 벤치마크
  if (a === 198 && b === 51) return true;                     // 198.51.100/24 문서용
  if (a === 203 && b === 0) return true;                      // 203.0.113/24 문서용
  if (a >= 224) return true;                                 // 224/4 멀티캐스트 + 240/4 예약 + 브로드캐스트
  return false;
}

/**
 * IPv6 를 8개 그룹으로 펼친다. `::` 축약과 뒤에 붙은 IPv4 표기(`::ffff:10.0.0.1`)를 다룬다.
 * 판정을 문자열 비교가 아니라 숫자 그룹으로 하는 이유: `fd00::1` 과 `FD00:0:0:0:0:0:0:1`
 * 은 같은 주소인데 정규식으로는 다른 글자다.
 */
function expandIpv6(ip: string): number[] | null {
  let s = ip.split('%')[0]!; // zone id(`fe80::1%eth0`)는 주소가 아니다
  const tail: number[] = [];
  const last = s.split(':').pop();
  if (last && last.includes('.')) {
    const v4 = parseIpv4(last);
    if (!v4) return null;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    s = s.slice(0, s.length - last.length);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const need = 8 - tail.length;
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const halves = s.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const g = toGroups(s);
    return g && g.length === need ? g.concat(tail) : null;
  }
  const head = toGroups(halves[0]!);
  const rest = toGroups(halves[1]!);
  if (!head || !rest) return null;
  const fill = need - head.length - rest.length;
  if (fill < 0) return null;
  return head.concat(new Array<number>(fill).fill(0)).concat(rest).concat(tail);
}

/**
 * 가져오면 안 되는 IPv6 주소인가.
 *
 * `::ffff:10.0.0.1`(IPv4-mapped)과 `64:ff9b::10.0.0.1`(NAT64)은 **IPv4 판정을 그대로**
 * 받는다. 이것이 없으면 IPv4 거절 목록 전체를 IPv6 표기로 우회할 수 있다.
 */
function isBlockedIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;
  const embedded = (): string => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
  // ::ffff:a.b.c.d (IPv4-mapped) / ::a.b.c.d (deprecated IPv4-compatible)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: 와 ::1
    return isBlockedIpv4(embedded());
  }
  // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(embedded());
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA — **fd00:: 가 실제로 쓰이는 값이다**
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 링크로컬 — fe80 만 비교하면 fe90/fea0/feb0 이 샌다
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 멀티캐스트
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 문서용
  if (first === 0x2002) return true; // 6to4 — 안에 IPv4 를 담아 우회할 수 있다
  if (first === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard
  return false;
}

/** 이 주소로 나가는 요청을 허용하지 않는가. 판정할 수 없으면 **막는다**(fail-closed). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

/** 이 브랜치 초판의 이름을 유지한다(테스트·호출부가 쓴다). */
export function isPrivateIp(ip: string): boolean {
  return isBlockedAddress(ip);
}

export function isBlockedHost(hostname: string): boolean {
  return isBlockedHostName(hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase());
}

export { normalizePreviewUrl as normalizeUrl };
export { extractPreviewUrls as extractUrls } from '@murmur/shared';

// ─────────────────────────────────────────────────────────────────────────────
// 네트워크 경계 — 테스트가 갈아끼운다
// ─────────────────────────────────────────────────────────────────────────────

/** 한 hop 의 결과. **리다이렉트를 따라가지 않는다** — 따라갈지는 이 밖에서 판단한다. */
export type HopResult = { status: number; location: string | null; body: string };

/**
 * 이 파일이 밖으로 나가는 **모든** 길. 테스트가 여기를 갈아끼워 네트워크 없이
 * SSRF 판정과 리다이렉트 흐름을 실제로 태운다(목이 아니라 경계다).
 */
export interface PreviewNet {
  /** 호스트명 → 주소 목록. IP 리터럴은 그대로 돌려준다. */
  resolve(host: string): Promise<string[]>;
  /**
   * **검사가 끝난 `ip` 로 직접 연결한다.** `host` 는 `Host` 헤더와 TLS SNI 용이다.
   * URL 을 다시 해석하지 않는 것이 이 인터페이스의 요점이다(TOCTOU 창을 닫는다).
   */
  fetchHop(req: { url: string; host: string; ip: string }): Promise<HopResult>;
}

/** IP 리터럴이면 그대로, 아니면 A/AAAA **전부**를 돌려준다. */
async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const resolver = new Resolver();
  const both = await Promise.all([
    new Promise<string[]>((res) => resolver.resolve4(host, (e, a) => res(e || !a ? [] : a))),
    new Promise<string[]>((res) => resolver.resolve6(host, (e, a) => res(e || !a ? [] : a))),
  ]);
  return [...both[0], ...both[1]];
}

/**
 * 한 hop 을 가져온다.
 *
 * **`lookup` 으로 이미 검사한 IP 를 못박는다.** `hostname` 을 그대로 두는 이유: TLS SNI 와
 * 인증서 검증, `Host` 헤더가 전부 원래 이름을 써야 한다. IP 를 `hostname` 에 넣으면
 * 인증서가 맞지 않고, 이름을 두고 다시 해석하면 검사한 주소와 다른 곳에 붙을 수 있다
 * (DNS rebinding). 둘을 동시에 만족시키는 자리가 `lookup` 이다.
 */
function httpFetchHop(
  req: { url: string; host: string; ip: string },
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<HopResult> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const parsed = new URL(req.url);
  const isHttps = parsed.protocol === 'https:';
  const family = isIP(req.ip);

  return new Promise<HopResult>((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;

    const finish = (r: HopResult) => { if (!settled) { settled = true; clearTimeout(deadline); request.destroy(); resolve(r); } };
    const fail = (e: Error) => { if (!settled) { settled = true; clearTimeout(deadline); request.destroy(); reject(e); } };

    // **총 시한**이다. `req.setTimeout` 은 소켓 **유휴** 시간만 본다 — 1바이트씩 흘려보내는
    // 서버는 유휴가 되지 않아 영원히 붙어 있는다. 시한이 지나면 있는 것만 들고 끝낸다.
    const deadline = setTimeout(() => {
      finish({ status: 0, location: null, body: Buffer.concat(chunks).toString('utf8') });
    }, timeoutMs);

    const request = (isHttps ? https : http).request({
      hostname: req.host,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      lookup: (_hostname, options, cb) => {
        const entry = { address: req.ip, family: family === 6 ? 6 : 4 };
        // node 는 `all: true` 일 때 배열을, 아니면 (addr, family) 를 기대한다.
        if (options && (options as { all?: boolean }).all) (cb as unknown as (e: null, a: unknown[]) => void)(null, [entry]);
        else (cb as unknown as (e: null, a: string, f: number) => void)(null, entry.address, entry.family);
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === 'string' ? res.headers.location : null;
      // 리다이렉트면 본문을 읽지 않는다 — 다음 hop 을 검사하기 전에 바이트를 받을 이유가 없다.
      if (status >= 300 && status < 400 && location) { finish({ status, location, body: '' }); return; }
      res.on('data', (chunk: Buffer) => {
        if (bytes >= maxBytes) return;
        const room = maxBytes - bytes;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        bytes += Math.min(chunk.length, room);
        // 한계에 닿으면 **즉시 끝낸다.** destroy 뒤에는 'end' 가 오지 않으므로 여기서
        // resolve 하지 않으면 이 promise 는 영원히 끝나지 않는다(초판의 결함).
        if (bytes >= maxBytes) finish({ status, location: null, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('end', () => finish({ status, location: null, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

export const defaultPreviewNet: PreviewNet = {
  resolve: resolveAll,
  fetchHop: (req) => httpFetchHop(req),
};

/** 테스트가 512KB·5초 기제를 실제로 태울 수 있도록 기본 fetcher 를 그대로 내보낸다. */
export { httpFetchHop };

// ─────────────────────────────────────────────────────────────────────────────
// SSRF 판정
// ─────────────────────────────────────────────────────────────────────────────

export type Verdict = { ok: true; host: string; ip: string } | { ok: false; status: 'blocked' | 'failed' };

/**
 * 이 URL 을 가져와도 되는가. **hop 마다 부른다** — 첫 hop 만 검사하는 구현은 리다이렉트
 * 한 번으로 무력화된다.
 *
 * 판정 순서가 곧 방어선이다:
 * 1. 정규화(스킴·자격증명·IP 표기·후행 점) — 정규화하지 않은 문자열을 판정하면 표기를
 *    바꿔 우회할 수 있다(`http://2130706433/` 은 `127.0.0.1` 이다).
 * 2. 이름 기반 차단(`localhost` 계열, 메타데이터 이름).
 * 3. 해석된 주소 **전부**를 검사. 하나라도 막힌 대역이면 거절한다 — 첫 주소만 보면
 *    두 번째 A 레코드로 우회할 수 있다.
 * 4. 통과한 주소 하나를 골라 **그 IP 로 붙는다**(반환값의 `ip`).
 *
 * 해석 실패는 `failed` 다(막힌 것이 아니라 없는 주소다). **`ok` 로 흘리지 않는다** —
 * 초판이 해석 실패를 "안전"으로 읽어, IP 리터럴이 리다이렉트 경로에서 그대로 통과했다.
 */
export async function checkFetchable(rawUrl: string, net: PreviewNet): Promise<Verdict> {
  const normalized = normalizePreviewUrl(rawUrl);
  if (!normalized) return { ok: false, status: 'blocked' };
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { ok: false, status: 'blocked' };
  }
  const host = hostOf(url);
  if (!host || isBlockedHostName(host)) return { ok: false, status: 'blocked' };

  // **IP 리터럴은 여기서 판정한다** — `net.resolve` 에 맡기지 않는다. 판정이 네트워크
  // 구현에 얹히면, 구현이 바뀌거나(초판은 DNS 해석 실패를 '안전'으로 읽었다) 테스트가
  // 갈아끼운 순간 가드가 사라진다. 방어선은 이 함수 안에 있어야 한다.
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await net.resolve(host);
    } catch {
      return { ok: false, status: 'failed' };
    }
  }
  if (!addresses.length) return { ok: false, status: 'failed' };
  if (addresses.some((ip) => isBlockedAddress(ip))) return { ok: false, status: 'blocked' };
  return { ok: true, host, ip: addresses[0]! };
}

/** 하위 호환용 술어. 새 코드는 `checkFetchable` 을 쓴다(사유를 구분해야 한다). */
export async function checkSsrfForUrl(urlString: string, net: PreviewNet = defaultPreviewNet): Promise<boolean> {
  return (await checkFetchable(urlString, net)).ok;
}

// ─────────────────────────────────────────────────────────────────────────────
// 가져오기
// ─────────────────────────────────────────────────────────────────────────────

function blockedPreview(url: string, status: LinkPreviewStatus): LinkPreview {
  return { url, title: null, description: null, imageUrl: null, siteName: null, status, fetchedAt: new Date() };
}

/**
 * URL 하나의 미리보기를 만든다. **리다이렉트는 수동으로 따라간다** — 자동 추적은 hop 을
 * 검사할 틈을 주지 않는다. 최대 3회, 매 hop `checkFetchable`.
 */
export async function fetchLinkPreview(
  rawUrl: string,
  net: PreviewNet = defaultPreviewNet,
): Promise<LinkPreview | null> {
  const normalized = normalizePreviewUrl(rawUrl);
  if (!normalized) return null;

  let current = normalized;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await checkFetchable(current, net);
    if (!verdict.ok) return blockedPreview(normalized, verdict.status);

    let res: HopResult;
    try {
      res = await net.fetchHop({ url: current, host: verdict.host, ip: verdict.ip });
    } catch {
      return blockedPreview(normalized, 'failed');
    }

    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: string;
      try {
        next = new URL(res.location, current).toString();
      } catch {
        return blockedPreview(normalized, 'failed');
      }
      if (next === current) return blockedPreview(normalized, 'failed'); // 제자리 리다이렉트
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) return blockedPreview(normalized, 'failed');
    if (!res.body) return blockedPreview(normalized, 'failed');
    // 저장 키는 **처음 정규화한 URL** 이다 — 클라이언트가 조회하는 것이 그것이다.
    return { ...parseHtml(res.body, normalized), url: normalized };
  }
  // hop 을 다 쓴 것은 실패다(마지막 hop 을 검사 없이 가져오지 않는다).
  return blockedPreview(normalized, 'failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// 저장 + 큐
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 지금 가져오는 중인 URL. **행을 미리 넣어 표시하지 않는 이유**: `status` 는
 * `ok|failed|blocked` 세 값뿐이라 '진행 중'을 담을 자리가 없다. 초판은 `'ok'` 로 빈 행을
 * 넣었는데, 그러면 (1) 클라이언트가 내용 없는 `ok` 카드를 받고 (2) 서버가 가져오는 도중
 * 죽으면 그 URL 은 영원히 빈 `ok` 로 굳는다(재시도 조건이 "행이 없을 때"이므로).
 */
const inFlight = new Set<string>();

/**
 * 메시지 본문의 URL 을 백그라운드로 가져온다. **`postMessage` 를 막지 않는다** — 호출부는
 * 이 promise 를 기다리지 않고, 트랜잭션 밖에서 부른다.
 */
export async function queueLinkPreviewFetch(
  pool: Pool,
  url: string,
  net: PreviewNet = defaultPreviewNet,
): Promise<void> {
  const normalized = normalizePreviewUrl(url);
  if (!normalized) return;
  // **표시를 먼저, await 은 그 뒤에.** DB 조회를 먼저 하면 같은 메시지 두 개가 동시에
  // 들어왔을 때 둘 다 "행이 없다"를 보고 둘 다 가져간다(요구 5 가 깨진다).
  if (inFlight.has(normalized)) return;
  inFlight.add(normalized);
  try {
    const existing = await pool.query('select 1 from link_preview where url = $1', [normalized]);
    if (existing.rowCount) return; // 같은 URL 은 한 번만 가져온다
    const preview = await fetchLinkPreview(normalized, net);
    if (preview) await saveLinkPreview(pool, preview);
  } finally {
    inFlight.delete(normalized);
  }
}

async function saveLinkPreview(pool: Pool, preview: LinkPreview): Promise<void> {
  await pool.query(
    `insert into link_preview (url, title, description, image_url, site_name, status, fetched_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (url) do update set
       title = excluded.title, description = excluded.description, image_url = excluded.image_url,
       site_name = excluded.site_name, status = excluded.status, fetched_at = excluded.fetched_at`,
    [preview.url, preview.title, preview.description, preview.imageUrl,
      preview.siteName, preview.status, preview.fetchedAt],
  );
  // 가져오기는 비동기라 메시지가 먼저 뜨고 카드가 뒤에 온다 — 이 이벤트가 그 간격을 잇는다.
  emitEvent({ type: 'link_preview.ready', url: preview.url, audience: 'all' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 파싱 — 의존성 없는 소형 파서
// ─────────────────────────────────────────────────────────────────────────────

export function parseHtml(html: string, url: string): LinkPreview {
  return {
    url,
    title: clean(metaContent(html, 'property', 'og:title') ?? titleTag(html)),
    description: clean(metaContent(html, 'property', 'og:description') ?? metaContent(html, 'name', 'description')),
    imageUrl: clean(metaContent(html, 'property', 'og:image')),
    siteName: clean(metaContent(html, 'property', 'og:site_name')),
    status: 'ok',
    fetchedAt: new Date(),
  };
}

/**
 * `<meta>` 의 content 를 집는다. 속성 순서는 두 가지 다 온다(`property` 가 앞이거나 뒤).
 * 둘을 각각 시도하는 이유: 하나만 보면 실제 사이트의 절반이 제목 없는 카드가 된다.
 */
function metaContent(html: string, attr: 'property' | 'name', key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = html.match(new RegExp(`<meta[^>]+${attr}=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'));
  if (a?.[1]) return a[1];
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${k}["']`, 'i'));
  return b?.[1] ?? null;
}

function titleTag(html: string): string | null {
  return html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null;
}

/**
 * 값을 카드에 넣을 수 있는 글자로 만든다.
 *
 * **엔티티를 디코드한 뒤 태그를 전부 제거한다.** 순서가 중요하다: 디코드가 `&lt;script&gt;`
 * 를 실제 태그 모양으로 되살리므로, 제거를 먼저 하면 그 태그가 그대로 남는다. 마크업이
 * 카드 문자열에 남으면 그것을 그리는 쪽(지금은 React 라 이스케이프된다)이 언젠가
 * `innerHTML` 로 바뀌는 날 XSS 가 된다 — 저장하는 자리에서 없앤다.
 */
function clean(raw: string | null): string | null {
  if (raw === null) return null;
  const text = decodeEntities(raw).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_FIELD_LENGTH ? text.slice(0, MAX_FIELD_LENGTH) : text;
}

function decodeEntities(str: string): string {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => safeCodePoint(parseInt(num, 10)))
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    // `&amp;` 를 **마지막에** 푼다 — 먼저 풀면 `&amp;lt;` 가 `<` 까지 내려간다.
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}
