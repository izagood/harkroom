import type { Pool } from 'pg';
import type { StorageBackend } from '../storage/local.js';

/**
 * 아바타로 받아 줄 이미지 타입. `Attachments.tsx:10` 의 `PREVIEWABLE` 화이트리스트와 같은
 * 집합이다 — 화면이 그리지 못하는 타입을 저장해 두면 '설정했는데 안 보이는' 아바타가 된다.
 *
 * **SVG 는 없다.** `attachmentRoutes.ts` 의 `NEVER_INLINE` 이 막는 바로 그것이다: SVG 는
 * `<script>` 를 담을 수 있어 이미지처럼 보이지만 이미지가 아니고, 매직 바이트로 구분할 수도
 * 없다(그냥 XML 텍스트다).
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
): Promise<{ id: string; storageKey: string } | null> {
  const res = await pool.query(
    `select id, storage_key as "storageKey" from attachment
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
