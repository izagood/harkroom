import type { Pool } from 'pg';
import type { StorageBackend } from '../storage/local.js';

/**
 * 매직 바이트로 판정하는 이진 이미지 타입. `Attachments.tsx:10` 의 `PREVIEWABLE`
 * 화이트리스트와 같은 집합이다 — 화면이 그리지 못하는 타입을 저장해 두면 '설정했는데
 * 안 보이는' 아바타가 된다.
 *
 * SVG 는 여기 없다. 매직 바이트가 없어서다(그냥 XML 텍스트다) — 판정은 `looksLikeSvg` 가
 * 따로 한다.
 */
const IMAGE_SIGNATURES: { type: string; matches: (head: Buffer) => boolean }[] = [
  { type: 'image/png', matches: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  // JPEG 은 SOI(ffd8) 뒤에 마커가 하나 더 온다. ffd8 두 바이트만 보면 우연히 맞는 이진 파일이 늘어난다.
  { type: 'image/jpeg', matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  { type: 'image/gif', matches: (h) => h.subarray(0, 6).toString('latin1') === 'GIF87a' || h.subarray(0, 6).toString('latin1') === 'GIF89a' },
  // RIFF 컨테이너는 WEBP 말고도 쓰이므로(WAV 등) 8~11 바이트의 폼 타입까지 봐야 한다.
  { type: 'image/webp', matches: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
  // ISO-BMFF: 4~7 이 'ftyp', 8~11 이 브랜드. avis 는 애니메이션 AVIF 다.
  {
    type: 'image/avif',
    matches: (h) => h.subarray(4, 8).toString('latin1') === 'ftyp'
      && ['avif', 'avis'].includes(h.subarray(8, 12).toString('latin1')),
  },
];

/** 매직 바이트 판정에 필요한 최소 길이. AVIF 브랜드가 11번째 바이트까지 간다. */
export const IMAGE_HEAD_BYTES = 12;

/**
 * **저장된 바이트로** 이미지 여부를 판정한다. 이미지가 아니면 null.
 *
 * 업로드 라우트는 클라이언트가 준 `contentType` 을 일부러 믿지 않고 저장만 한다 — 내려줄 때
 * `nosniff` + `attachment` 로 무력화하기 때문이다. 아바타는 그 무력화를 통과해 `<img>` 로
 * 그려지므로, 여기서는 **서버가 실제로 검사해야 한다.** 문자열만 보고 통과시키면 실제로는
 * HTML 인 파일이 모든 계정에게 자동으로 내려간다 — 아무도 안 여는 첨부보다 나쁘다.
 */
export function sniffImageType(head: Buffer): string | null {
  if (head.length < IMAGE_HEAD_BYTES) return null;
  return IMAGE_SIGNATURES.find((sig) => sig.matches(head))?.type ?? null;
}

/**
 * SVG 아바타로 받아 줄 최대 크기. **SVG 만 이 상한이 있다** — 이진 이미지는 앞 12바이트로
 * 판정이 끝나지만 SVG 는 아래 검사를 위해 파일 전체를 문자열로 올려야 하고, 그 비용에는
 * 상한이 필요하다. 아바타로 쓰는 벡터 그림은 보통 수십 KiB 다.
 */
export const SVG_MAX_BYTES = 256 * 1024;

/**
 * 스크립트가 될 수 있는 조각. **화이트리스트가 아니라 블랙리스트인 것을 알고 쓴다** —
 * 실행을 막는 것은 이 정규식이 아니라 아래 주석이 말하는 렌더 경로이고, 이것은 그 위에
 * 한 겹 더 얹는 것이다. 그래서 파일 **전체**를 본다(앞부분만 보는 검사는 통과했다는
 * 잘못된 확신만 준다).
 */
const SVG_UNSAFE = /<\s*(script|foreignObject)\b|\son[a-z]{2,}\s*=|javascript:/i;

/**
 * 바이트가 SVG 문서인지 본다. **`sniffImageType` 과 같은 자리에 서는 판정이다** — 클라이언트가
 * 말한 `contentType` 은 여기서도 믿지 않는다.
 *
 * SVG 를 받는 이유: 사람이 프로필 사진으로 흔히 가진 파일이고, 거절할 때조차 화면은 그것을
 * 고를 수 없게 만들어 두어서 **아무 일도 일어나지 않은 것처럼** 보였다.
 *
 * 받아도 되는 이유: 아바타가 그려지는 경로가 `Identity.tsx` 의 `<img src={objectURL}>`
 * 하나뿐이다. `<img>` 안의 SVG 는 스크립트를 실행하지 않고 외부 리소스도 못 부른다.
 * 서빙 헤더도 그대로다 — `nosniff` + `content-disposition: attachment` 라 주소창으로
 * 직접 열어도 문서로 실행되지 않는다. 즉 `attachmentRoutes.ts` 의 `NEVER_INLINE` 은
 * **여전히 유효하고**, 여기서 예외를 뚫는 것이 아니다: 그 목록이 막는 것은 `inline` 으로
 * 내주는 일이고, 아바타는 inline 으로 내주지 않는다.
 *
 * 그 위에 두 가지를 더 본다:
 * - 문서의 뿌리가 정말 `<svg>` 인가. 아니면 XML 처럼 생긴 HTML 일 수 있다.
 * - DOCTYPE 의 내부 서브셋(`[ ... ]`)은 거절한다. 엔티티를 선언할 수 있는 자리이고,
 *   XXE·엔티티 폭탄이 들어온다면 그 문을 지난다.
 */
export function looksLikeSvg(bytes: Buffer): boolean {
  return startsLikeSvg(bytes) && !SVG_UNSAFE.test(bytes.toString('utf8'));
}

/**
 * 문서의 **뿌리가 `<svg>` 인지만** 본다(스크립트 검사는 하지 않는다). 그래서 파일 앞부분만
 * 있어도 답할 수 있고, 상한을 넘긴 파일이 "SVG 이긴 하다"를 판정하는 데 쓴다 —
 * 그 구분이 없으면 큰 SVG 를 든 사람이 "SVG 만 쓸 수 있습니다"를 듣는다.
 *
 * 이것만으로 받아 주면 안 된다. 받아 주는 판정은 `looksLikeSvg` 다.
 */
export function startsLikeSvg(bytes: Buffer): boolean {
  // UTF-16 로 저장된 XML 은 통과하지 못한다. 흔치 않고, 받아 주면 검사해야 할 인코딩이 는다.
  let rest = bytes.toString('utf8').replace(/^\ufeff/, '').trimStart();
  // 프롤로그(XML 선언·주석·DOCTYPE)를 지나 첫 원소까지 간다. 없는 것이 보통이지만,
  // 그리기 도구가 붙여 주는 것도 흔하다 — 그걸로 거절하면 멀쩡한 파일이 튕긴다.
  for (;;) {
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return false;
      rest = rest.slice(end + 2).trimStart();
    } else if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return false;
      rest = rest.slice(end + 3).trimStart();
    } else if (/^<!doctype\s/i.test(rest)) {
      const end = rest.indexOf('>');
      if (end < 0 || rest.slice(0, end).includes('[')) return false;
      rest = rest.slice(end + 1).trimStart();
    } else {
      break;
    }
  }
  return /^<svg[\s/>]/i.test(rest);
}

/**
 * 아바타 판정 결과. **거절은 이유를 들고 온다** — 예전에는 `null` 하나여서 라우트가 무엇이든
 * `not_an_image` 로 옮겼고, 상한을 넘긴 SVG 를 든 사람이 "SVG 만 쓸 수 있습니다"를 들었다.
 * 문구를 여기 두는 이유: 두 라우트가 같은 거절을 하고, 한쪽만 고쳐지면 다시 어긋난다.
 */
export type AvatarTypeResult =
  | { type: string; error?: undefined }
  | { type: null; error: { code: 'not_an_image' | 'svg_too_large'; message: string } };

/** 받아 주는 목록을 적어 둔다 — 목록이 바뀌었을 때 제일 먼저 눈에 띄는 자리다. */
const NOT_AN_IMAGE: AvatarTypeResult = {
  type: null,
  error: { code: 'not_an_image', message: 'avatar must be a png, jpeg, gif, webp, avif, or svg image' },
};

const SVG_TOO_LARGE: AvatarTypeResult = {
  type: null,
  error: { code: 'svg_too_large', message: `svg avatar must be at most ${SVG_MAX_BYTES} bytes` },
};

/**
 * 상한을 넘긴 파일에서 "SVG 이긴 한가"를 보려고 읽는 앞부분. 뿌리 원소까지만 필요하지만,
 * 그리기 도구가 붙이는 XML 선언·주석·DOCTYPE 이 그 앞에 길게 오는 일이 있어 넉넉히 잡는다.
 */
const SVG_PROBE_BYTES = 4096;

/**
 * 업로드 하나의 **저장된 바이트로** 아바타 타입을 정한다. 아바타가 아니면 이유를 돌려준다.
 *
 * 두 라우트(`me`·에이전트)가 같은 판정을 한다. 판정을 양쪽에 한 벌씩 두면 한쪽만 넓어지고,
 * 이 저장소에서 판정 복제가 반복해 결함을 만들었다(#253·#299·#315).
 */
export async function detectAvatarType(
  storage: StorageBackend, source: { storageKey: string; sizeBytes: number },
): Promise<AvatarTypeResult> {
  // 상한을 넘는 파일은 SVG 로 받지 않는다. 앞부분만 읽고 통과시키면 뒤쪽에 무엇이 있는지
  // 모른 채 받아 주는 셈이다 — 대신 앞부분으로 **거절 이유**만 가른다.
  const oversize = source.sizeBytes > SVG_MAX_BYTES;
  const want = oversize ? SVG_PROBE_BYTES : Math.max(source.sizeBytes, IMAGE_HEAD_BYTES);
  const bytes = await readHead(storage, source.storageKey, want);
  const binary = sniffImageType(bytes);
  if (binary) return { type: binary };
  if (oversize) return startsLikeSvg(bytes) ? SVG_TOO_LARGE : NOT_AN_IMAGE;
  return looksLikeSvg(bytes) ? { type: 'image/svg+xml' } : NOT_AN_IMAGE;
}

/** 스토리지에서 앞 `want` 바이트만 읽는다. 판정에 파일 전체를 메모리에 올릴 이유가 없다. */
export async function readHead(storage: StorageBackend, key: string, want: number): Promise<Buffer> {
  const stream = await storage.read(key);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size >= want) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, want);
}

/**
 * 아바타로 쓸 수 있는 업로드를 찾는다. **자기가 올렸고 아직 어떤 메시지에도 붙지 않은 것**만이다.
 *
 * - 남의 업로드를 막는 이유: 막지 않으면 id 를 맞힌 사람이 남이 올린 파일을 자기 얼굴로 걸 수 있다.
 * - 메시지에 붙은 첨부를 막는 이유: `attachment.message_id` 가 `on delete cascade`(006)다.
 *   그 메시지를 지우면 첨부 **행 자체**가 사라지고, 아바타를 걸어 둔 계정은 그 순간 깨진다.
 */
export async function findAvatarSource(
  pool: Pool, attachmentId: string, uploaderId: string,
): Promise<{ id: string; storageKey: string; sizeBytes: number } | null> {
  const res = await pool.query(
    // `sizeBytes` 를 함께 읽는다 — `detectAvatarType` 이 SVG 상한을 판정하는 데 쓴다.
    // 스토리지를 다시 stat 하지 않는다: 크기는 업로드가 이미 세어 행에 적어 둔 사실이다.
    `select id, storage_key as "storageKey", size_bytes::int as "sizeBytes" from attachment
      where id = $1 and uploader_id = $2 and message_id is null`,
    [attachmentId, uploaderId],
  );
  return res.rowCount ? res.rows[0] : null;
}

/**
 * 아바타를 건다(또는 null 로 지운다). 세우는 경우 판정한 타입을 첨부 행에 **덮어쓴다** —
 * 그래야 내려줄 때 클라이언트가 보낸 문자열이 아니라 서버가 확인한 사실을 헤더에 싣는다.
 * 한 트랜잭션인 이유: 타입만 고쳐지고 계정이 안 걸리면 아무도 안 쓰는 수정이 남는다.
 */
export async function setAccountAvatar(
  pool: Pool, accountId: string, avatar: { attachmentId: string; contentType: string } | null,
): Promise<void> {
  if (!avatar) {
    await pool.query(`update account set avatar_attachment_id = null where id = $1`, [accountId]);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`update attachment set content_type = $2 where id = $1`, [avatar.attachmentId, avatar.contentType]);
    await client.query(`update account set avatar_attachment_id = $2 where id = $1`, [accountId, avatar.attachmentId]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export interface AvatarTarget {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}

/** 그 계정이 지금 걸어 둔 아바타의 바이트를 찾는다. 없으면 null. */
export async function findAvatarTarget(pool: Pool, accountId: string): Promise<AvatarTarget | null> {
  const res = await pool.query(
    `select a.storage_key as "storageKey", a.content_type as "contentType", a.size_bytes::int as "sizeBytes"
       from account acc join attachment a on a.id = acc.avatar_attachment_id
      where acc.id = $1`,
    [accountId],
  );
  return res.rowCount ? res.rows[0] : null;
}
