import { useEffect, useRef, useState } from 'react';
import { previewUrlFor } from '../lib/attachmentUploads';
import type { AttachmentRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { ImageLightbox } from './ImageLightbox';
import { useT } from '../i18n/useT';
import { useLatestKnownVersion } from './ArtifactPreview';
import { useActiveStore } from '../state/communities';

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
export function AttachmentThumb({ attachment, placeholderFile }: {
  attachment: AttachmentRow;
  /**
   * 방금 올린 그 파일. 서버 바이트가 올 때까지 이것으로 그린다 — 작성창 칩이 업로드를 끝낸
   * 순간 📎 로 꺼졌다 켜지지 않게 한다. 받아 오기가 실패하면 지금처럼 실패를 말한다.
   */
  placeholderFile?: File;
}) {
  const t = useT();
  const previewable = canPreview(attachment);
  const { url, failed } = useAttachmentUrl(attachment.id, previewable);
  if (!url && placeholderFile && previewable && !failed) return <LocalFileThumb file={placeholderFile} />;
  if (!url) {
    return (
      // 그림이 올 자리는 미리 그림 높이(h-6)로 잡는다 — 바이트가 도착하는 순간 11px 이모지가
      // 24px 그림으로 바뀌면서 칩 줄 전체가 밀려 내려간다. 처음부터 그릴 수 없는 첨부는
      // 자리를 잡지 않는다: 올 것이 없는데 비워 둔 여백이다.
      <span className={previewable ? 'inline-flex h-6 items-center gap-1' : 'inline-flex items-center gap-1'}>
        <span aria-hidden>📎</span>
        {failed && <span className="text-danger">{t('message.attachment.previewFailed')}</span>}
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
 * 올리는 중인 첨부의 미리보기 — **고른 파일**로 곧장 그린다. 서버 바이트는 아직 없고,
 * 다 올라가면 칩이 `AttachmentThumb`(실제로 붙은 것)으로 바뀐다. 그릴 수 있는 종류는
 * `canPreview` 와 같은 목록이다: 여기서만 더 그리면 올라간 뒤에 그림이 사라진다.
 */
export function LocalFileThumb({ file, dim = false }: { file: File; dim?: boolean }) {
  const previewable = canPreview({ contentType: file.type } as AttachmentRow);
  // 파일마다 하나인 URL 을 **렌더 중에** 받는다 — effect 로 미루면 첫 그림 전에 📎 가 한 번 낀다.
  // 해제는 첨부가 작성창에서 사라질 때 `attachmentUploads` 가 한다.
  const url = previewable ? previewUrlFor(file) : null;
  if (!url) {
    return (
      <span className={previewable ? 'inline-flex h-6 items-center' : 'inline-flex items-center'}>
        <span aria-hidden>📎</span>
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      data-testid="attachment-local-thumb"
      // 흐리게는 **올리는 중일 때만**이다. 다 올라간 뒤 자리 지킴으로 쓸 때는 진하게.
      className={`h-6 w-6 shrink-0 rounded-sm border border-border object-cover${dim ? ' opacity-60' : ''}`}
    />
  );
}

/** 확대 보기는 `ImageLightbox.tsx` 에 있다(배율·끌기·단축키, designer 3192efed). */
function Attachment({ attachment }: { attachment: AttachmentRow }) {
  const t = useT();
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
          aria-label={t('message.attachment.zoom', { filename: attachment.filename })}
          className="block cursor-zoom-in rounded border border-border"
        >
          {/*
            **세로만이 아니라 가로도 묶는다.** 높이만 묶어 두면(`max-h-64` + `max-w-full`)
            가로로 긴 스크린샷은 본문 폭을 그대로 채운다 — 한 줄짜리 글에 참고로 붙인 그림이
            화면의 절반을 먹고, 위아래 대화가 스크롤 밖으로 밀린다.
            본문의 그림은 **무엇이 붙었는지 알아보는 자리**이고, 읽는 자리는 확대 보기다
            (눌러서 크게 볼 길이 이미 있으므로 목록에서는 작아도 된다).
            `min(…,100%)` 로 적는 이유는 좁은 칸이다 — 스레드 패널에서는 `28rem` 보다 칸이
            먼저다. `max-w-full` 을 따로 얹으면 같은 `max-width` 를 두 클래스가 다투고,
            어느 쪽이 이길지는 생성된 CSS 순서에 달린다.
          */}
          <img
            src={url}
            alt={attachment.filename}
            data-testid="attachment-preview"
            className="max-h-56 max-w-[min(28rem,100%)] rounded"
          />
        </button>
        {zoomed && <ImageLightbox attachment={attachment} url={url} onClose={() => setZoomed(false)} />}
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
      {failed && <span className="text-danger">{t('message.attachment.loadFailed')}</span>}
    </button>
  );
}

/**
 * 미리보기(아티팩트) 카드(④, designer d8ca47be). 본문 아래 첨부 자리에 붙고 폭은 그림과 같은 28rem 이다.
 * **목록 안에서 페이지를 띄우지 않는다** — 축소 iframe 을 깔면 스크롤할 때마다 스크립트가 돌고, 격리면도
 * 열었을 때 하나만 있는 편이 낫다. 카드 전체가 누르는 자리다.
 *
 * 표지는 같은 글에 붙은 그림 첨부다(`coverAttachmentId`). 없으면 그림 칸을 비워 두지 않고 글 카드로만 그린다.
 * 표지는 `canPreview` 화이트리스트(svg 없음)를 지난 것만 `<img>`(blob)로 그린다(security ④ 조건).
 */
function ArtifactCard({ attachment, cover, from }: {
  attachment: AttachmentRow; cover: AttachmentRow | null; from: 'channel' | 'thread';
}) {
  const t = useT();
  const ref = attachment.artifact!;
  const latest = useLatestKnownVersion(ref.artifactId, ref.latestVersion);
  const coverOk = cover !== null && canPreview(cover);
  const { url: coverUrl } = useAttachmentUrl(cover?.id ?? '', coverOk);
  const newer = latest > ref.version;
  // 지금 패널에 떠 있는 카드 — 같은 안의 v1·v2 가 나란히 있을 때 무엇을 보고 있는지 보인다(designer c).
  const selected = useActiveStore((st) => st.artifactPreview?.id === attachment.id);
  // 최신 제목은 #1065(091) 서버부터 싣는다. 없으면 툴팁을 생략한다.
  const latestTitle = ref.latestTitle;
  return (
    <button
      type="button"
      onClick={() => getController().openArtifactPreview(attachment, from)}
      aria-label={t('artifact.card.open', { title: ref.title })}
      aria-pressed={selected}
      data-testid="artifact-card"
      data-selected={selected ? 'true' : 'false'}
      className={`block w-[min(28rem,100%)] overflow-hidden rounded border bg-surface text-left hover:bg-surface-sunken ${selected ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" data-testid="artifact-card-cover" className="aspect-video w-full border-b border-border object-cover" />
      )}
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium">{ref.title}</span>
          <span className="shrink-0 text-meta text-fg-subtle">{ref.version > 1
            // 고쳐 올린 안인지 첫 판인지 카드에서 보이게(designer a).
            ? t('artifact.card.versionWithPrev', { version: ref.version, prev: ref.version - 1 })
            : t('artifact.card.version', { version: ref.version })}</span>
          {newer && (
            <span
              className="ml-auto shrink-0 rounded-full border border-border px-1.5 text-meta text-fg-muted"
              data-testid="artifact-card-latest"
              title={latestTitle && latest === ref.latestVersion
                ? t('artifact.card.latestTitle', { version: latest, title: latestTitle })
                : undefined}
            >{t('artifact.card.latest', { version: latest })}</span>
          )}
        </span>
        {ref.summary && <span className="truncate text-meta text-fg-muted">{ref.summary}</span>}
        <span className="text-meta text-fg-subtle">{t('artifact.card.html')} · {formatSize(attachment.sizeBytes)}</span>
      </span>
    </button>
  );
}

export function Attachments({ attachments, from = 'channel' }: {
  attachments: AttachmentRow[];
  /** 이 목록이 놓인 칸 — 미리보기가 열린 동안 남길 칸을 정한다(`Workspace.tsx`). */
  from?: 'channel' | 'thread';
}) {
  if (!attachments.length) return null;
  // 미리보기의 표지는 카드 안에 그린다 — 따로 그림으로 한 번 더 보이면 같은 것이 두 번이다.
  const covers = new Set(attachments.map((a) => a.artifact?.coverAttachmentId).filter((v): v is string => !!v));
  return (
    <div className="mt-1 space-y-1">
      {attachments.filter((a) => !covers.has(a.id)).map((a) => (
        <div key={a.id}>
          {a.artifact
            ? <ArtifactCard attachment={a} from={from} cover={attachments.find((c) => c.id === a.artifact!.coverAttachmentId) ?? null} />
            : <Attachment attachment={a} />}
        </div>
      ))}
    </div>
  );
}
