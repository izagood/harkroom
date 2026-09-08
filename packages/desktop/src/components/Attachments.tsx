import { useEffect, useState } from 'react';
import type { AttachmentRow } from '@murmur/shared';
import { getController } from '../state/controller';
import { Overlay } from './Overlay';

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
 * 두 번 읽히면 스크린리더에서 칩 하나가 파일 두 개처럼 들린다.
 *
 * 그릴 수 없으면 📎 로 남되 **"원래 미리보기가 없는 것"과 "받지 못한 것"을 가른다** — 둘을
 * 같은 📎 로 덮으면, 네트워크가 끊겨 그림이 빠진 자리를 사람이 "이 파일은 원래 이렇다"로
 * 읽고 그대로 보낸다. 본문 미리보기가 `(불러오기 실패)` 로 가르는 것과 같은 규칙이다.
 */
export function AttachmentThumb({ attachment }: { attachment: AttachmentRow }) {
  const previewable = canPreview(attachment);
  const { url, failed } = useAttachmentUrl(attachment.id, previewable);
  if (!url) {
    return (
      // 그림이 올 자리는 미리 그림 높이(h-6)로 잡는다 — 바이트가 도착하는 순간 11px 이모지가
      // 24px 그림으로 바뀌면서 칩 줄 전체가 밀려 내려간다. 처음부터 그릴 수 없는 첨부는
      // 자리를 잡지 않는다: 올 것이 없는데 비워 둔 여백이다.
      <span className={previewable ? 'inline-flex h-6 items-center gap-1' : 'inline-flex items-center gap-1'}>
        <span aria-hidden>📎</span>
        {failed && <span className="text-danger">(미리보기 실패)</span>}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      data-testid="attachment-thumb"
      className="h-6 w-6 shrink-0 rounded-sm border border-border object-cover"
    />
  );
}

/**
 * 확대 보기(#첨부 확대). 본문의 그림은 `max-h-64` 로 줄여 그리므로 스크린샷 속 글자는
 * 대개 읽히지 않는다 — 크게 볼 자리가 없으면 사람은 그림을 디스크에 저장해 시스템 뷰어로
 * 열고, 그때 채팅을 떠난다.
 *
 * 스크림 · Esc · 바깥 클릭은 **`Overlay` 가 정한다.** 여기서 다시 정하면 "겹쳐 열려도
 * 맨 위 하나만 닫힌다"는 규칙이 이 자리에서만 갈린다.
 *
 * **바이트를 다시 받지 않는다.** 확대할 그림은 이미 본문에 그려진 그것이므로 같은
 * objectURL 을 그대로 넘겨 쓴다. 다시 받으면 클릭마다 왕복이 붙고, URL 의 수명(revoke)을
 * 두 곳이 나눠 갖게 된다 — 그러면 닫는 쪽이 revoke 한 URL 을 본문이 계속 가리킨다.
 */
function Lightbox({ attachment, url, onClose }: {
  attachment: AttachmentRow;
  url: string;
  onClose: () => void;
}) {
  return (
    // 폭을 고정하지 않는다(기본값 `w-[42rem]` 를 물려받으면 작은 그림 옆에 빈 판이 남는다) —
    // 화면보다 큰 그림만 뷰포트에서 잘라 낸다.
    <Overlay label={attachment.filename} onClose={onClose} align="center" className="max-w-[92vw]">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate font-medium">{attachment.filename}</span>
        <span className="shrink-0 text-fg-subtle">{formatSize(attachment.sizeBytes)}</span>
        {/*
          이미지는 칩이 아니라 그림으로 그려지므로 **여기 말고는 저장할 자리가 없다.**
          저장이 칩 분기에만 붙어 있으면, 미리보기가 되는 첨부일수록 내려받을 길이 없다.
          실패 문구는 컨트롤러가 Notice 로 세운다(#257) — 여기서 다시 삼키지 않는다.
        */}
        <button
          className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken"
          onClick={() => void getController().saveAttachment(attachment)}
        >저장</button>
        <button
          className="shrink-0 rounded px-2 text-fg-subtle hover:bg-surface-sunken"
          onClick={onClose}
          aria-label="확대 보기 닫기"
        >×</button>
      </header>
      {/*
        `max-h-[80vh]` 로 세로를 제한한다 — 높이를 열어 두면 세로로 긴 스크린샷에서 그림이
        패널을 밀어내고 머리줄(이름 · 저장 · 닫기)이 화면 밖으로 나간다.
      */}
      <img
        src={url}
        alt={attachment.filename}
        data-testid="attachment-full"
        className="max-h-[80vh] max-w-full object-contain"
      />
    </Overlay>
  );
}

function Attachment({ attachment }: { attachment: AttachmentRow }) {
  const previewable = canPreview(attachment);
  const { url, failed } = useAttachmentUrl(attachment.id, previewable);
  const [zoomed, setZoomed] = useState(false);

  if (previewable && url) {
    return (
      <>
        {/*
          **그림 자체가 누르는 자리다.** 옆에 "크게 보기" 링크를 따로 두면, 사람이 이미
          손을 올려 둔 곳(그림) 밖에서 누를 곳을 다시 찾아야 한다.
          `div` 에 `onClick` 만 달지 않고 `button` 으로 두는 이유는 키보드다 — Tab 으로
          닿고 Enter · Space 로 열려야 마우스 없이도 그림을 볼 수 있다.
          이름은 버튼이 말한다(`aria-label`) — 그림의 `alt` 는 그대로 두지만, 버튼에
          이름이 없으면 스크린리더가 "버튼" 이라고만 읽는다.
        */}
        <button
          type="button"
          onClick={() => setZoomed(true)}
          aria-label={`크게 보기: ${attachment.filename}`}
          className="block cursor-zoom-in rounded border border-border"
        >
          <img
            src={url}
            alt={attachment.filename}
            className="max-h-64 max-w-full rounded"
          />
        </button>
        {zoomed && <Lightbox attachment={attachment} url={url} onClose={() => setZoomed(false)} />}
      </>
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
