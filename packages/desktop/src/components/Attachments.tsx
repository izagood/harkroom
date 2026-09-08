import { useEffect, useState } from 'react';
import type { AttachmentRow } from '@murmur/shared';
import { getController } from '../state/controller';

/**
 * 미리보기를 허용하는 타입. **화이트리스트다** — `image/*` 로 열면 `image/svg+xml` 이 들어오고,
 * SVG 는 `<script>` 를 담을 수 있어 이미지처럼 보이지만 이미지가 아니다. 파일명(`.png`)은
 * 판단 근거로 쓰지 않는다: 이름은 올린 사람이 정한다.
 */
const PREVIEWABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

/** 미리보기 판정은 **한 곳에서만** 한다 — 화이트리스트가 갈리면 한쪽만 SVG 를 그린다. */
export function canPreview(attachment: AttachmentRow): boolean {
  return PREVIEWABLE.includes(attachment.contentType);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  // 소수 한 자리면 1.2 KB 처럼 읽히고, 정수 자리가 커지면 소수는 잡음이다.
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * 첨부 바이트를 받아 objectURL 로 바꾼다. 토큰을 URL 에 넣지 않으려면(서버 로거가 URL 을
 * 기록한다) 헤더를 붙일 수 있는 fetch 를 거쳐야 하고, 그 결과를 화면에 쓰려면 blob 이어야 한다.
 * 언마운트에서 revoke 한다 — 안 하면 채널을 오래 열어 둘수록 메모리가 는다.
 * 실패 시 오류 상태를 돌려준다 — 조용히 강등하면 "불러오지 못했다"는 신호를 못 받는다.
 */
function useAttachmentUrl(id: string, enabled: boolean): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // id 가 바뀌면 실패 표시도 초기화한다 — 안 하면 한 번 실패한 자리가 다른 첨부를
    // 그리면서 "불러오기 실패" 를 계속 달고 있다.
    setFailed(false);
    let objectUrl: string | null = null;
    let alive = true;
    void getController().fetchAttachment(id).then((blob) => {
      if (!alive) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, enabled]);
  return { url, failed };
}

/**
 * 칩 안에 들어가는 작은 미리보기. **이름 옆에 놓이는 그림이므로 alt 는 비운다** — 이름을
 * 두 번 읽히면 스크린리더에서 칩 하나가 파일 두 개처럼 들린다. 그릴 수 없는 것(이미지가
 * 아니거나 아직 못 받았거나 실패)은 📎 로 남는다: 자리 크기는 같아서 글자가 흔들리지 않는다.
 */
export function AttachmentThumb({ attachment }: { attachment: AttachmentRow }) {
  const { url } = useAttachmentUrl(attachment.id, canPreview(attachment));
  if (!url) return <span aria-hidden>📎</span>;
  return (
    <img
      src={url}
      alt=""
      data-testid="attachment-thumb"
      className="h-6 w-6 shrink-0 rounded-sm border border-border object-cover"
    />
  );
}

function Attachment({ attachment }: { attachment: AttachmentRow }) {
  const previewable = canPreview(attachment);
  const { url, failed } = useAttachmentUrl(attachment.id, previewable);

  if (previewable && url) {
    return (
      <img
        src={url}
        alt={attachment.filename}
        className="max-h-64 max-w-full rounded border border-border"
      />
    );
  }
  return (
    <button
      className="inline-flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-body text-fg hover:bg-surface-sunken"
      onClick={() => void getController().saveAttachment(attachment)}
    >
      <span aria-hidden>📎</span>
      <span className="font-medium">{attachment.filename}</span>
      <span className="text-fg-subtle">{formatSize(attachment.sizeBytes)}</span>
      {failed && <span className="text-danger">(불러오기 실패)</span>}
    </button>
  );
}

export function Attachments({ attachments }: { attachments: AttachmentRow[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-1 space-y-1">
      {attachments.map((a) => <div key={a.id}><Attachment attachment={a} /></div>)}
    </div>
  );
}
