import type { Pool } from 'pg';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 미리보기로 열 수 있는 HTML 의 상한. 업로드 한도(25MB)보다 훨씬 작다 — 폰 WebView 가 한 번에
 * 읽어 그리는 문서이고, 디자인 안은 대개 200KB 미만이다(2026-10-02 결정: HTML 5MB).
 */
export const ARTIFACT_HTML_MAX_BYTES = 5 * 1024 * 1024;

/** 서명 URL 의 수명. 앱은 열 때마다 새로 받는다 — 새도 곧 죽는다. */
export const PREVIEW_TOKEN_TTL_MS = 60_000;

export interface ArtifactVersionRef {
  artifactId: string;
  version: number;
  latestVersion: number;
  /** 이 버전의 제목(091). 옛 버전을 열어도 그때 이름이 보인다. */
  title: string;
  /** 최신 버전의 제목(`artifact.title`). */
  latestTitle: string;
}

/** 이 첨부가 어느 미리보기의 몇 번째 버전인가. 미리보기가 아니면 null. */
export async function artifactVersionForAttachment(
  pool: Pool, attachmentId: string,
): Promise<ArtifactVersionRef | null> {
  const res = await pool.query(
    `select v.artifact_id as "artifactId", v.version, coalesce(v.title, a.title) as title, a.title as "latestTitle",
            (select max(v2.version) from artifact_version v2 where v2.artifact_id = v.artifact_id) as "latestVersion"
       from artifact_version v join artifact a on a.id = v.artifact_id
      where v.attachment_id = $1`,
    [attachmentId],
  );
  if (!res.rowCount) return null;
  const row = res.rows[0];
  return {
    artifactId: row.artifactId, version: row.version, latestVersion: row.latestVersion,
    title: row.title, latestTitle: row.latestTitle,
  };
}

/**
 * 서명 키를 읽는다(없으면 한 번 만든다). 프로세스 안에서는 한 번만 읽는다 — 키는 바뀌지 않는다.
 * 실패한 읽기는 캐시하지 않는다: 한 번의 DB 오류가 프로세스 수명 내내 미리보기를 죽이면 안 된다.
 */
export function createPreviewKeyReader(pool: Pool): () => Promise<Buffer> {
  let cached: Promise<Buffer> | null = null;
  return () => {
    if (!cached) {
      cached = (async () => {
        await pool.query(
          `insert into preview_signing_key (id, key) values (1, $1) on conflict (id) do nothing`,
          [randomBytes(32)],
        );
        const res = await pool.query(`select key from preview_signing_key where id = 1`);
        return res.rows[0].key as Buffer;
      })();
      cached.catch(() => { cached = null; });
    }
    return cached;
  };
}

/**
 * 토큰 모양: base64url( 첨부 uuid 16B | 계정 uuid 16B | 만료 epoch 초 u32 | HMAC-SHA256 앞 16B ).
 * JSON 이 아니라 고정 길이 이진인 이유: fastify 의 경로 파라미터는 기본 **100자**까지라(넘으면
 * 414) JSON+서명은 들어가지 않는다. 이 모양은 75자다. 전역 한도를 올리면 모든 라우트가 함께
 * 늘어나므로 토큰을 줄인다. MAC 을 16B 로 자르는 것은 128비트라 위조에 충분하다.
 */
const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_BYTES = 16 + 16 + 4;
const MAC_BYTES = 16;

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
function uuidString(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update('harkroom-preview.v1\0').update(body).digest().subarray(0, MAC_BYTES);
}

/**
 * 토큰을 만든다. 상태 없는 서명값인 이유는 마이그레이션 주석과 같다 — 메모리 티켓은 다른
 * 파드에서 검증되지 않는다.
 *
 * **일회용이 아니다.** 수명 안에는 같은 URL 로 다시 열 수 있다. WebView 는 같은 주소를 두 번
 * 받는 일이 있고(새로고침·회전), 그때마다 404 가 나면 화면이 깨진다. 수명이 짧은 것으로 막는다.
 */
export function signPreviewToken(key: Buffer, attachmentId: string, accountId: string, nowMs: number): string {
  if (!UUID_HEX.test(attachmentId) || !UUID_HEX.test(accountId)) throw new Error('preview token ids must be uuids');
  const body = Buffer.alloc(BODY_BYTES);
  uuidBytes(attachmentId).copy(body, 0);
  uuidBytes(accountId).copy(body, 16);
  // 초 단위로 올림한다 — 내림하면 수명이 최대 1초 짧아진다.
  body.writeUInt32BE(Math.ceil((nowMs + PREVIEW_TOKEN_TTL_MS) / 1000), 32);
  return Buffer.concat([body, mac(key, body)]).toString('base64url');
}

/** 서명·만료를 본다. 무엇이 틀렸는지는 돌려주지 않는다 — 호출부는 전부 같은 404 로 답한다. */
export function verifyPreviewToken(
  key: Buffer, token: string, nowMs: number,
): { attachmentId: string; accountId: string } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== BODY_BYTES + MAC_BYTES) return null;
  // 끝 글자의 남는 비트만 다른 표기는 같은 바이트로 풀린다 — 한 토큰에 한 표기만 받는다.
  if (raw.toString('base64url') !== token) return null;
  const body = raw.subarray(0, BODY_BYTES);
  if (!timingSafeEqual(raw.subarray(BODY_BYTES), mac(key, body))) return null;
  if (nowMs >= body.readUInt32BE(32) * 1000) return null;
  return { attachmentId: uuidString(body.subarray(0, 16)), accountId: uuidString(body.subarray(16, 32)) };
}

/**
 * 외부 리소스 허용목록(2026-10-02 결정: CDN·폰트만, fetch 금지). 차트 라이브러리를 CDN 으로
 * 부르는 디자인 안이 있어 스크립트·스타일은 연다. 이 목록을 넓히는 것은 격리면을 넓히는
 * 것이다 — security 검토를 거친다.
 */
const SCRIPT_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'];
const STYLE_HOSTS = [...SCRIPT_HOSTS, 'https://fonts.googleapis.com'];
const FONT_HOSTS = ['https://fonts.gstatic.com', ...SCRIPT_HOSTS];

/**
 * 미리보기 응답의 CSP. **첫 지시문 `sandbox` 가 격리의 전부다** — `allow-same-origin` 이
 * 없으므로 브라우저는 이 문서를 불투명(opaque) origin 으로 다룬다. 같은 호스트에서 내려도
 * 이 호스트의 저장소·쿠키에 닿지 못하고, 이 호스트로 보내는 요청은 교차 출처가 된다.
 * 이 단어 하나를 빼면 에이전트가 쓴 스크립트가 서버 origin 에서 돈다 — 시험이 지킨다.
 *
 * - `allow-scripts`: 시안은 대개 스크립트로 움직인다.
 * - `allow-popups`: 페이지 안 링크를 새 창으로 열게 한다(앱이 시스템 브라우저로 넘긴다).
 *   `allow-top-navigation`·`allow-forms`·`allow-modals` 는 주지 않는다.
 * - `connect-src 'none'`·`form-action 'none'`: 페이지가 밖으로 말을 거는 길을 닫는다.
 * - `frame-ancestors` 는 걸지 않는다: 데스크톱 앱의 origin 은 플랫폼마다 다르고, 이 URL 은
 *   로그인한 멤버만 60초짜리로 받는다 — 남이 끼워 넣어도 열 토큰이 없다.
 */
export const PREVIEW_CSP = [
  'sandbox allow-scripts allow-popups',
  "default-src 'none'",
  `script-src 'unsafe-inline' ${SCRIPT_HOSTS.join(' ')}`,
  `style-src 'unsafe-inline' ${STYLE_HOSTS.join(' ')}`,
  `font-src data: ${FONT_HOSTS.join(' ')}`,
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
