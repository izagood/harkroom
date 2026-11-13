/**
 * 큰 JSON 응답 하나를 클라이언트가 받는 방식(`Accept-Encoding`)으로 압축한다(2026-11-13, 「내 작업」 보드).
 *
 * 왜 전역 압축이 아니라 이것인가: 서버 앞(Rust 앞단·istio·터널)은 응답을 그대로 넘기고 어디서도 압축하지 않는다. 보드
 * 응답(`GET /inbox/board`)은 큰 계정에서 한 판이 수 MB라 **보내는 데만 수 초**가 걸렸다(디스크가 붐빌 때 크게 느려지는
 * 첫 경로). 전역 압축 플러그인은 모든 응답(롱폴·SSE 꼴 응답 포함)의 흐름을 바꾸므로, 효과가 분명한 큰 응답 하나에만 건다.
 *
 * - brotli 를 먼저(브라우저·WKWebView 가 받는다), 없으면 gzip. 둘 다 없거나 `q=0` 이면 그대로 보낸다.
 * - 작은 몸통(`COMPRESS_MIN_BYTES` 미만)은 압축하지 않는다 — 머리·CPU 값이 더 든다.
 * - 압축은 libuv 스레드풀에서 돈다(비동기 zlib) — 이벤트 루프를 막지 않는다. brotli 는 속도 쪽 품질(4)을 쓴다.
 * - `Vary: Accept-Encoding` 을 단다 — 같은 주소의 응답이 요청 머리에 따라 다르다는 것을 캐시에 알린다.
 */
import { brotliCompress, constants as zc, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** 이보다 작은 몸통은 그대로 보낸다. */
export const COMPRESS_MIN_BYTES = 1024;

export type ContentCoding = 'br' | 'gzip' | null;

/** `Accept-Encoding` 에서 쓸 방식을 고른다. `q=0` 은 거절이다. `*` 는 br 로 읽는다. */
export function pickEncoding(header: string | string[] | undefined): ContentCoding {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const accepted = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q' && v !== undefined) { const n = Number(v); q = Number.isFinite(n) ? n : 0; }
    }
    accepted.set(name, q);
  }
  const ok = (name: 'br' | 'gzip'): boolean => {
    const q = accepted.get(name) ?? accepted.get('*');
    return q !== undefined && q > 0;
  };
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/** JSON 문자열을 보낸다 — 받을 수 있으면 압축해서. `reply` 를 돌려주므로 라우트에서 그대로 `return` 한다. */
export async function sendJsonMaybeCompressed(req: FastifyRequest, reply: FastifyReply, json: string): Promise<FastifyReply> {
  void reply.type('application/json; charset=utf-8').header('vary', 'accept-encoding');
  const raw = Buffer.from(json, 'utf8');
  const coding = raw.length >= COMPRESS_MIN_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  if (!coding) return reply.send(raw);
  const packed = coding === 'br'
    ? await brotli(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 4, [zc.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    : await gz(raw, { level: 6 });
  return reply.header('content-encoding', coding).send(packed);
}
