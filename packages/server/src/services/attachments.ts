import type { Pool, PoolClient } from 'pg';
import type { ChannelFileRow } from '@murmur/shared';
import { basename } from 'node:path';

/** 서버 내부에서 쓰는 행. `storageKey` 는 여기까지만 산다. */
export interface StoredAttachment {
  id: string;
  messageId: string | null;
  uploaderId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
}

// message 와 join 하는 쿼리가 있으므로 모든 컬럼에 테이블 별칭을 붙인다 — 없으면 `id` 가
// 모호해져 런타임에만 터진다(타입 검사가 잡아 주지 않는다).
const COLS = `a.id, a.message_id as "messageId", a.uploader_id as "uploaderId", a.filename,
  a.content_type as "contentType", a.size_bytes::int as "sizeBytes", a.storage_key as "storageKey"`;

/**
 * 사용자 파일명을 표시용 이름으로 좁힌다. 경로 성분을 떼고 남은 것만 쓴다 — 이름이 경로로
 * 해석되는 자리는 스토리지 키가 아니라 여기서 미리 없앤다(두 겹으로 막는다).
 */
export function displayName(raw: string): string {
  // 제어문자를 지운다 — 파일명에 개행이 들어가면 Content-Disposition 헤더를 쪼갤 수 있다.
  // 공백은 정상 문자이므로 남긴다.
  const name = basename(raw.replace(/\\/g, '/'))
    .split('').filter((ch) => ch.codePointAt(0)! >= 0x20 && ch.codePointAt(0)! !== 0x7f).join('')
    .trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : 'file';
}

export async function recordUpload(
  pool: Pool,
  input: { uploaderId: string; filename: string; contentType: string; sizeBytes: number; storageKey: string },
): Promise<StoredAttachment> {
  const res = await pool.query(
    `insert into attachment (uploader_id, filename, content_type, size_bytes, storage_key)
     values ($1, $2, $3, $4, $5)
     returning id, message_id as "messageId", uploader_id as "uploaderId", filename,
       content_type as "contentType", size_bytes::int as "sizeBytes", storage_key as "storageKey"`,
    [input.uploaderId, displayName(input.filename), input.contentType, input.sizeBytes, input.storageKey],
  );
  return res.rows[0];
}

export type AttachFailure = 'not_found' | 'not_yours' | 'already_attached';

/**
 * 업로드들을 메시지에 붙인다. 메시지 생성과 같은 트랜잭션에서 돌아야 한다 — 따로 돌면
 * 메시지는 있는데 첨부가 없는 순간이 보인다.
 *
 * 거절 사유를 셋으로 나누는 이유는 라우트가 구분하기 위해서가 아니라(전부 400 이다),
 * 각 조건이 왜 필요한지 코드에 남기기 위해서다.
 */
export async function attachToMessage(
  client: PoolClient, args: { messageId: string; actorId: string; attachmentIds: string[] },
): Promise<AttachFailure | null> {
  if (!args.attachmentIds.length) return null;

  const found = await client.query(
    `select id, uploader_id, message_id from attachment where id = any($1::uuid[]) for update`,
    [args.attachmentIds],
  );
  if (found.rowCount !== args.attachmentIds.length) return 'not_found';
  for (const row of found.rows) {
    // 남의 업로드를 붙이면 올린 적 없는 파일을 자기 것으로 게시할 수 있다.
    if (row.uploader_id !== args.actorId) return 'not_yours';
    // 한 업로드가 여러 메시지에 붙으면 하나를 지울 때 다른 쪽이 깨진다.
    if (row.message_id !== null) return 'already_attached';
  }

  // 주어진 순서를 보존한다 — 사용자가 고른 순서가 화면 순서여야 한다.
  await client.query(
    `update attachment a set message_id = $1, attached_at = now()
     from unnest($2::uuid[]) with ordinality as t(id, ord)
     where a.id = t.id`,
    [args.messageId, args.attachmentIds],
  );
  return null;
}

/**
 * 이 채널에 오간 첨부 한 페이지(#232). 최신 메시지부터다.
 *
 * **`message` 에서 시작해 `attachment` 로 들어간다.** 방향이 규칙이다: 이렇게 하면
 * `message_channel_seq (channel_id, seq)` 를 역방향으로 훑으면서 `attachment_message_idx
 * (message_id)` 로 들어가므로 채널 기준 인덱스를 새로 만들지 않아도 된다. 반대로
 * `attachment` 부터 훑으면 채널 조건이 조인 뒤에 걸려 첨부 전체를 읽는다.
 *
 * `deleted_at is null` 은 빼면 안 된다. 삭제는 하드 삭제가 아니라 소프트 삭제이고
 * (`findDownloadTarget` 도 같은 기준이다), 이 조건이 없으면 지운 메시지의 파일명이 목록에
 * 그대로 남는다 — 그건 삭제가 삭제가 아닌 것이다.
 *
 * `limit` 이 세는 것은 **메시지 수다, 첨부 수가 아니다.** 커서가 seq 하나뿐이라 한 메시지의
 * 첨부가 페이지 경계에서 쪼개지면 다음 페이지(`before = 그 seq`)가 남은 첨부를 건너뛴다 —
 * 즉 행으로 자르면 파일이 조용히 사라진다. 메시지 단위로 자르면 그 구멍이 없고, 한 메시지의
 * 첨부는 10개로 제한되므로(messageRoutes) 페이지 크기도 함께 묶인다.
 */
export async function listChannelFiles(
  pool: Pool, channelId: string, opts: { before?: number; limit?: number } = {},
): Promise<{ files: ChannelFileRow[]; hasMore: boolean }> {
  const limit = opts.limit ?? 50;
  const res = await pool.query(
    `with page as (
       select m.id, m.seq, m.author_id, m.created_at
       from message m
       where m.channel_id = $1
         and m.deleted_at is null
         and ($2::bigint is null or m.seq < $2)
         and exists (select 1 from attachment a where a.message_id = m.id)
       order by m.seq desc
       limit $3
     )
     select a.id, a.filename, a.content_type as "contentType", a.size_bytes::int as "sizeBytes",
            p.id as "messageId", p.seq::int as "messageSeq", p.author_id as "authorId",
            p.created_at as "createdAt"
     from page p join attachment a on a.message_id = p.id
     -- 한 메시지 안의 순서는 메시지 목록(messages.ts 의 ATTACHMENTS)과 같은 기준이다.
     -- 두 화면이 같은 첨부를 다른 순서로 보여 주면 어느 쪽이 맞는지 판단할 근거가 없다.
     order by p.seq desc, a.attached_at, a.created_at, a.id`,
    [channelId, opts.before ?? null, limit],
  );
  const files: ChannelFileRow[] = res.rows.map((row) => ({
    id: row.id, filename: row.filename, contentType: row.contentType, sizeBytes: row.sizeBytes,
    messageId: row.messageId, messageSeq: row.messageSeq, authorId: row.authorId,
    createdAt: new Date(row.createdAt).toISOString(),
  }));
  // 'hasMore' 는 이 페이지보다 오래된 첨부가 남았는가다. 메시지 목록과 같은 뜻으로 쓴다.
  const oldest = files.length ? files[files.length - 1]!.messageSeq : null;
  const hasMore = oldest === null ? false : Boolean((await pool.query(
    `select 1 from message m
     where m.channel_id = $1 and m.deleted_at is null and m.seq < $2
       and exists (select 1 from attachment a where a.message_id = m.id)
     limit 1`,
    [channelId, oldest],
  )).rowCount);
  return { files, hasMore };
}

export interface DownloadTarget {
  attachment: StoredAttachment;
  /** null 이면 아직 메시지에 붙지 않은 업로드다 — 업로더만 볼 수 있다. */
  channelId: string | null;
}

/**
 * 내려받을 대상을 찾는다. 삭제된 메시지의 첨부는 없는 것으로 취급한다 — 아니면 삭제가
 * 삭제가 아니다(본문은 사라졌는데 파일은 남는다).
 */
export async function findDownloadTarget(
  pool: Pool, attachmentId: string,
): Promise<DownloadTarget | null> {
  const res = await pool.query(
    `select ${COLS}, m.channel_id as "channelId", m.deleted_at as "deletedAt"
     from attachment a left join message m on m.id = a.message_id
     where a.id = $1`,
    [attachmentId],
  );
  if (!res.rowCount) return null;
  const row = res.rows[0];
  if (row.messageId !== null && (row.channelId === null || row.deletedAt !== null)) return null;
  return {
    attachment: {
      id: row.id, messageId: row.messageId, uploaderId: row.uploaderId, filename: row.filename,
      contentType: row.contentType, sizeBytes: row.sizeBytes, storageKey: row.storageKey,
    },
    channelId: row.messageId === null ? null : row.channelId,
  };
}
