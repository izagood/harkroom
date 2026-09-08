import { useEffect, useState } from 'react';
import type { AttachmentRow } from '@murmur/shared';
import { getController } from '../state/controller';

/**
 * 미리보기를 허용하는 타입. **화이트리스트다** — `image/*` 로 열면 `image/svg+xml` 이 들어오고,
 * SVG 는 `<script>` 를 담을 수 있어 이미지처럼 보이지만 이미지가 아니다. 파일명(`.png`)은
 * 판단 근거로 쓰지 않는다: 이름은 올린 사람이 정한다.
 */
const PREVIEWABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];

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
 * 좁은 자리(컴포저의 대기 칩)에 세우는 **작은** 미리보기. 이름과 크기만 보이면 방금 붙인
 * 것이 의도한 그림인지 알 수 없다 — 붙여넣은 스크린샷은 `screenshot-20260908-151256.png`
 * 처럼 서로 구별되지 않는 이름을 달고 오기 때문에, 잘못 고른 것을 보내고 나서야 안다.
 *
 * 미리보기 판단은 `Attachment` 와 **같은 화이트리스트**를 쓴다 — 여기만 느슨하면 SVG 가
 * 컴포저로 새어 들어온다. 그림이 아니거나 아직 못 받았으면 지금까지처럼 📎 로 남고,
 * 자리 크기는 같게 잡는다: 바이트가 도착하는 순간 칩 폭이 튀면 옆의 × 를 누르려던 손이
 * 빗나간다.
 *
 * 옆에 파일명이 이미 있으므로 그림 자체는 장식이다(`alt=""`) — alt 에 이름을 또 넣으면
 * 스크린리더가 같은 이름을 두 번 읽는다.
 */
export function AttachmentThumb({ attachment }: { attachment: AttachmentRow }) {
  const canPreview = PREVIEWABLE.includes(attachment.contentType);
  const { url, failed } = useAttachmentUrl(attachment.id, canPreview);

  if (canPreview && url) {
    return (
      <img
        src={url}
        alt=""
        data-testid="attachment-thumb"
        className="h-6 w-6 shrink-0 rounded-sm border border-border object-cover"
      />
    );
  }
  // 그리지 못한 이유는 둘이다: 그릴 수 없는 타입이거나, 받다 실패했거나. 둘 다 📎 로만
  // 덮으면 구분이 사라진다(#257 과 같은 이유). 칩에 문장을 더 넣으면 한 줄이 무너지므로
  // 여기서는 짧게만 말한다 — 파일 자체는 이미 서버에 올라가 있고, 보내는 데는 지장이 없다.
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1">
      <span aria-hidden>📎</span>
      {failed && <span className="text-danger">(미리보기 실패)</span>}
    </span>
  );
}

function Attachment({ attachment }: { attachment: AttachmentRow }) {
  const canPreview = PREVIEWABLE.includes(attachment.contentType);
  const { url, failed } = useAttachmentUrl(attachment.id, canPreview);

  if (canPreview && url) {
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
      className="inline-flex items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-[13px] text-fg hover:bg-surface-sunken"
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
