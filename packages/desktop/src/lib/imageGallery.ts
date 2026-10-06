import type { AttachmentRow, MessageRow } from '@harkroom/shared';

/**
 * 그림 넘겨 보기의 **범위**(designer 사양 1, 2026-10-02) — 그림을 연 칸이 정한다.
 * - `channel`: 채널 본문. 최상위 글과 채널에도 올린 답글(`alsoInChannel`)만 넣는다 — 본문에 줄이 있는 글이다.
 * - `thread`: 스레드 패널. 루트와 그 답글.
 */
export type GalleryScope = { kind: 'channel' } | { kind: 'thread'; rootId: string };

export interface GalleryItem {
  attachment: AttachmentRow;
  message: MessageRow;
}

/**
 * 넘겨 볼 그림 목록. 글은 seq 순, 한 글 안에서는 첨부 순서다. `canPreview` 를 지난 그림만 넣고,
 * 미리보기 카드의 **표지**(`artifact.coverAttachmentId`)는 뺀다 — 카드 안에 그려지는 그림이라 본문 그림이 아니다.
 * 열 때 **한 번** 부른다 — 열려 있는 동안 새 글이 와도 순서가 흔들리지 않는다(사양 1).
 */
export function collectGallery(
  messages: readonly MessageRow[],
  scope: GalleryScope,
  canPreview: (a: AttachmentRow) => boolean,
): GalleryItem[] {
  const inScope = scope.kind === 'thread'
    ? (m: MessageRow) => m.id === scope.rootId || m.threadRootId === scope.rootId
    : (m: MessageRow) => !m.threadRootId || m.alsoInChannel === true;
  const items: GalleryItem[] = [];
  for (const message of [...messages].filter(inScope).sort((a, b) => a.seq - b.seq)) {
    const covers = new Set(message.attachments.map((a) => a.artifact?.coverAttachmentId).filter(Boolean));
    for (const attachment of message.attachments) {
      if (covers.has(attachment.id) || !canPreview(attachment)) continue;
      items.push({ attachment, message });
    }
  }
  return items;
}

/** 트랙패드 좌우 스와이프를 넘김으로 읽는 누적 거리(px, 사양 2). */
export const SWIPE_THRESHOLD = 80;
/** 이만큼 휠 이벤트가 없으면 손을 뗀 것으로 본다 — 한 번 넘기면 손을 뗄 때까지 다시 넘기지 않는다. */
export const SWIPE_IDLE_MS = 200;
