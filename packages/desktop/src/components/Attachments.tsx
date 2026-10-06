import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { previewUrlFor } from '../lib/attachmentUploads';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import type { PendingUpload } from '../state/appStore';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { collectGallery, type GalleryItem, type GalleryScope } from '../lib/imageGallery';
import { stampLabel } from '../lib/day';
import { ImageLightbox } from './ImageLightbox';
import { useT, useLocale } from '../i18n/useT';
import { useLatestKnownVersion, noteArtifactOpener } from './ArtifactPreview';

/**
 * 그림을 연 **칸**의 넘겨 보기 범위 — 채널 본문(`ChannelPane`)과 스레드 패널(`ThreadPanel`)이 준다.
 * 없으면(그 밖의 자리) 지금처럼 그 그림 한 장만 본다.
 */
export const GalleryScopeContext = createContext<GalleryScope | null>(null);

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
 * 작성창에 붙인 첨부 하나 — **그림은 80×80 타일, 그림이 아닌 것은 같은 높이의 파일 카드**다
 * (designer 시안 24878e97, jaebin D1~D4 전부 추천). 24px 썸네일 옆에 이름을 늘어놓던 칩은
 * 미리보기 효과가 거의 없었다 — 스크린샷끼리는 24px 에서 서로 구별되지 않는다.
 *
 * - 이름·크기는 **호버·포커스 때만** 그림 아래 띠로 겹친다(`title` 도 단다). 그림을 가리지 않는다.
 * - × 는 오른쪽 위 모서리에 반쯤 걸친 원이고 **늘 보인다** — 빼기는 자주 하는 일이라 숨기면 못 찾는다.
 *   그림의 누르는 자리(확대)와 겹치지 않게 타일 밖으로 반 걸친다.
 * - 올리는 중·실패는 **늘 보인다.** 상태를 호버 뒤로 숨기면 실패한 채로 보낸다.
 *
 * 그림은 다 올라간 뒤 **서버의 바이트**로 그린다: 고른 파일이 아니라 실제로 붙은 것을 보여야 한다.
 * 그 바이트가 올 때까지는 고른 파일로 그린다(올리는 중에는 흐리게) — 안 그러면
 * `흐린 그림 → 📎 → 그림` 으로 한 번 꺼졌다 켜진다(designer 검토 A).
 */
export function PendingAttachmentTile({ upload, onRemove, onRetry }: {
  upload: PendingUpload;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const { file, row, status } = upload;
  const name = row?.filename ?? file.name;
  const size = formatSize(row?.sizeBytes ?? file.size);
  const pct = upload.fraction === null ? null : Math.round(upload.fraction * 100);
  const previewable = canPreview(row ?? ({ contentType: file.type } as AttachmentRow));
  const server = useAttachmentUrl(row?.id ?? '', previewable && !!row);
  // 파일마다 하나인 URL 을 **렌더 중에** 받는다 — effect 로 미루면 첫 그림 전에 📎 가 한 번 낀다.
  // 해제는 첨부가 작성창에서 사라질 때 `attachmentUploads` 가 한다.
  const local = previewable && !server.url && !server.failed ? previewUrlFor(file) : null;
  const url = server.url ?? local;
  const [zoomed, setZoomed] = useState(false);

  const progress = status === 'uploading' && (
    <span className="text-fg-subtle tabular-nums" role="status">
      {pct === null || pct >= 100 ? t('composer.attach.uploading') : t('composer.attach.uploadingPct', { pct })}
    </span>
  );
  const failed = status === 'failed' && (
    <span className="inline-flex items-center gap-1">
      <span className="text-danger">{t('composer.attach.failedShort')}</span>
      <button
        type="button"
        aria-label={`Retry ${name}`}
        className="rounded-sm px-1 font-medium text-accent hover:bg-surface-hover"
        // 커서를 지킨다 — 다시 누른 뒤에도 초안을 이어서 쓴다.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
      >
        {t('composer.attach.retry')}
      </button>
    </span>
  );
  const remove = (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      className="absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-meta leading-none text-fg-muted shadow-sm hover:bg-surface-hover hover:text-fg"
      onClick={onRemove}
    >
      ×
    </button>
  );
  const border = status === 'failed' ? 'border-danger' : 'border-border';

  if (!previewable) {
    // 그림이 아닌 첨부 — 보여 줄 그림이 없으니 이름·크기가 곧 미리보기다. 늘 보인다.
    return (
      <div
        data-testid="pending-attachment"
        data-status={status}
        title={`${name} · ${size}`}
        className={`relative flex h-20 w-52 shrink-0 items-center gap-2 rounded-card border bg-surface px-2.5 text-meta text-fg ${border}`}
      >
        <span aria-hidden className="text-title">📎</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="line-clamp-2 break-all font-medium">{name}</span>
          <span className="text-fg-subtle">{status === 'done' ? size : (progress || failed)}</span>
        </span>
        {remove}
      </div>
    );
  }

  return (
    <>
    <div
      data-testid="pending-attachment"
      data-status={status}
      title={`${name} · ${size}`}
      className={`group relative h-20 w-20 shrink-0 rounded-card border bg-surface-sunken text-meta ${border}`}
    >
      {url ? (
        <button
          type="button"
          aria-label={t('message.attachment.zoom', { filename: name })}
          className="block h-full w-full cursor-zoom-in overflow-hidden rounded-card focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => setZoomed(true)}
        >
          {/* 이름은 띠가 글자로 말한다 — alt 까지 이름이면 스크린리더가 같은 파일을 두 번 읽는다. */}
          <img
            src={url}
            alt=""
            data-testid={server.url ? 'attachment-thumb' : 'attachment-local-thumb'}
            className={`h-full w-full object-cover${status === 'uploading' ? ' opacity-60' : ''}`}
          />
        </button>
      ) : (
        // 받지 못한 그림은 "원래 미리보기가 없는 것"과 갈라 말한다 — 같은 📎 로 덮으면 끊긴
        // 자리를 사람이 "이 파일은 원래 이렇다"로 읽고 그대로 보낸다.
        <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-center">
          <span aria-hidden>📎</span>
          {server.failed && <span className="text-danger">{t('message.attachment.previewFailed')}</span>}
        </span>
      )}
      {/* 이름·크기 띠 — 호버·포커스 때만. 누르는 자리를 막지 않게 포인터는 통과시킨다. */}
      {status === 'done' && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col rounded-b-md bg-black/65 px-1.5 py-1 leading-tight text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <span className="truncate">{name}</span>
          <span className="text-white/75">{size}</span>
        </span>
      )}
      {/* 올리는 중·실패는 늘 보인다. */}
      {status !== 'done' && (
        <span className="absolute inset-x-0 bottom-0 flex justify-center rounded-b-md bg-surface/90 px-1 py-0.5">
          {progress || failed}
        </span>
      )}
      {status === 'uploading' && pct !== null && pct < 100 && (
        <span aria-hidden className="pointer-events-none absolute inset-x-1 top-1 h-1 overflow-hidden rounded-full bg-black/20">
          <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
        </span>
      )}
      {remove}
    </div>
      {/* 겹창은 타일 **밖에** 둔다 — 안에 두면 타일의 `title` 툴팁이 확대 보기 위에 뜬다. */}
      {zoomed && url && (
        <ImageLightbox
          attachment={row ?? ({ id: upload.localId, filename: name, sizeBytes: file.size, contentType: file.type } as AttachmentRow)}
          url={url}
          // 아직 서버에 없는 파일은 저장할 것이 없다 — 고른 그 파일이 사람 디스크에 있다.
          saveable={!!row}
          onClose={() => setZoomed(false)}
        />
      )}
    </>
  );
}

/** 확대 보기는 `ImageLightbox.tsx` 에 있다(배율·끌기·단축키, designer 3192efed). */
function Attachment({ attachment, message }: { attachment: AttachmentRow; message?: MessageRow }) {
  const t = useT();
  const previewable = canPreview(attachment);
  const { url, failed } = useAttachmentUrl(attachment.id, previewable);
  const [zoomed, setZoomed] = useState(false);
  const scope = useContext(GalleryScopeContext);
  /** 연 순간의 목록(사양 1: 열 때 한 번 찍는다). 칸 밖이거나 글을 모르면 null — 한 장 보기. */
  const [gallery, setGallery] = useState<{ items: GalleryItem[]; start: number } | null>(null);
  const openZoom = () => {
    if (scope && message) {
      const items = collectGallery(useActiveStore.getState().messages[message.channelId] ?? [], scope, canPreview);
      const start = items.findIndex((it) => it.attachment.id === attachment.id);
      if (start >= 0 && items.length > 1) { setGallery({ items, start }); return; }
    }
    setZoomed(true);
  };

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
          onClick={openZoom}
          aria-label={t('message.attachment.zoom', { filename: attachment.filename })}
          className="block cursor-zoom-in rounded-row border border-border"
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
            className="max-h-56 max-w-[min(28rem,100%)] rounded-row"
          />
        </button>
        {zoomed && <ImageLightbox attachment={attachment} url={url} onClose={() => setZoomed(false)} />}
        {gallery && (
          <ImageGallery items={gallery.items} start={gallery.start} startUrl={url} onClose={() => setGallery(null)} />
        )}
      </>
    );
  }
  return <FileChip attachment={attachment} failed={failed} />;
}

/**
 * 그림이 아닌 첨부의 카드. **누르면 무엇을 하는지 카드가 말한다**(designer 흐름 시안 b9e52c00): 오른쪽 끝의
 * `저장…` — 말줄임표는 "저장할 곳을 묻는다"는 뜻이다(macOS 관례). 누르면 저장 창이 뜨고, [취소]하면 아무 일도 없다.
 * 전에는 📎·이름·크기뿐이라 눌렀을 때 파일이 바로 생길 줄 몰랐다.
 *
 * 받는 동안(`받는 중…`)과 저장 창이 떠 있는 동안에는 `disabled`·`aria-busy` 다 — 두 번 누르면 두 번 받는다.
 */
function FileChip({ attachment, failed }: { attachment: AttachmentRow; failed: boolean }) {
  const t = useT();
  const saving = useActiveStore((s) => s.attachmentSaving[attachment.id]);
  return (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-2 rounded-row border border-border bg-surface px-2 py-1 text-body text-fg hover:bg-surface-sunken disabled:cursor-progress disabled:hover:bg-surface"
      onClick={() => void getController().saveAttachment(attachment)}
      disabled={!!saving}
      aria-busy={saving ? true : undefined}
      aria-label={t('message.attachment.saveNamed', { filename: attachment.filename })}
      title={t('message.attachment.saveNamed', { filename: attachment.filename })}
      data-testid="attachment-file-chip"
    >
      <span aria-hidden>📎</span>
      <span className="min-w-0 truncate font-medium">{attachment.filename}</span>
      <span className="shrink-0 text-fg-subtle">{formatSize(attachment.sizeBytes)}</span>
      {failed && <span className="text-danger">{t('message.attachment.loadFailed')}</span>}
      <span className="ml-1 shrink-0 text-meta text-fg-muted" aria-hidden data-testid="attachment-file-action">
        {saving === 'fetching' ? t('message.attachment.saving') : t('message.attachment.save')}
      </span>
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
      onClick={(e) => {
        // detail 0 = Enter·Space(키보드). 닫을 때 포커스를 돌려줄지가 이것으로 갈린다(`ArtifactPreview.tsx`).
        noteArtifactOpener(e.currentTarget, e.detail === 0);
        getController().openArtifactPreview(attachment, from);
      }}
      aria-label={t('artifact.card.open', { title: ref.title })}
      aria-pressed={selected}
      data-testid="artifact-card"
      data-selected={selected ? 'true' : 'false'}
      // `artifact-card` 는 포커스 링을 카드 바깥에 띄운다(index.css) — 선택 표시(카드 테두리)와 모양이 갈린다.
      className={`artifact-card group block w-[min(28rem,100%)] overflow-hidden rounded-card border bg-surface text-left hover:bg-surface-sunken ${selected ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
    >
      {coverUrl && (
        <img src={coverUrl} alt="" data-testid="artifact-card-cover" className="aspect-video w-full border-b border-border object-cover" />
      )}
      <span className="flex flex-col gap-0.5 px-3 py-2">
        <span className="flex items-center gap-2">
          {/* 눌러서 보는 시안이라는 표지(designer A안) — 표지 그림이 있어도 같은 모양이다. */}
          <svg aria-hidden="true" data-testid="artifact-card-icon" viewBox="0 0 16 16" width="16" height="16" className="shrink-0 text-fg-muted" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <path d="M1.5 5.5h13M6 5.5v8" />
          </svg>
          <span className="min-w-0 truncate font-medium">{ref.title}</span>
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
        <span className="flex items-center gap-2 text-meta">
          <span className={selected ? 'text-fg' : 'text-fg-muted group-hover:text-fg'} data-testid="artifact-card-action">
            {selected ? t('artifact.card.previewing') : t('artifact.card.openLabel')}
          </span>
          <span className="ml-auto shrink-0 text-fg-subtle">{t('artifact.card.html')} · {formatSize(attachment.sizeBytes)}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * 넘겨 보기(designer 사양, 2026-10-02). 장(`index`)과 장마다의 바이트를 쥔다 — 라이트박스는 한 장을 그릴 뿐이다.
 * 바이트: 연 그림은 본문이 받은 objectURL 을 그대로 쓰고(다시 받지 않는다), 나머지는 볼 때 받는다. 이웃(±1)은
 * 미리 받아 넘기는 순간 바로 보이게 한다. 여기서 만든 objectURL 은 닫을 때 revoke 한다 — 본문 것은 본문이 한다.
 */
export function ImageGallery({ items, start, startUrl, onClose }: {
  items: GalleryItem[];
  start: number;
  startUrl: string;
  onClose: () => void;
}) {
  const locale = useLocale();
  const [index, setIndex] = useState(start);
  const startId = items[start]?.attachment.id;
  const [urls, setUrls] = useState<Record<string, string>>(() => (startId ? { [startId]: startUrl } : {}));
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const asked = useRef(new Set<string>(startId ? [startId] : []));
  const owned = useRef<string[]>([]);
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
    for (const u of owned.current) URL.revokeObjectURL(u);
  }, []);

  const load = useCallback((id: string) => {
    if (asked.current.has(id)) return;
    asked.current.add(id);
    setFailed((f) => ({ ...f, [id]: false }));
    void getController().fetchAttachment(id).then((blob) => {
      const u = URL.createObjectURL(blob);
      if (!alive.current) { URL.revokeObjectURL(u); return; }
      owned.current.push(u);
      setUrls((m) => ({ ...m, [id]: u }));
    }).catch(() => {
      asked.current.delete(id);
      if (alive.current) setFailed((f) => ({ ...f, [id]: true }));
    });
  }, []);

  useEffect(() => {
    for (const i of [index, index - 1, index + 1]) {
      const it = items[i];
      if (it) load(it.attachment.id);
    }
  }, [index, items, load]);

  const item = items[index]!;
  const id = item.attachment.id;
  const author = useActiveStore((s) => s.accounts[item.message.authorId]);
  return (
    <ImageLightbox
      attachment={item.attachment}
      url={urls[id] ?? null}
      failed={!!failed[id]}
      onRetry={() => load(id)}
      onClose={onClose}
      nav={{
        index,
        total: items.length,
        onPrev: index > 0 ? () => setIndex(index - 1) : undefined,
        onNext: index < items.length - 1 ? () => setIndex(index + 1) : undefined,
        sender: author?.handle ?? '…',
        at: stampLabel(item.message.createdAt, locale),
        onGoTo: () => { onClose(); void getController().openMessage(item.message.id, item.message); },
      }}
    />
  );
}

export function Attachments({ attachments, from = 'channel', message }: {
  attachments: AttachmentRow[];
  /** 이 목록이 놓인 칸 — 미리보기가 열린 동안 남길 칸을 정한다(`Workspace.tsx`). */
  from?: 'channel' | 'thread';
  /** 이 첨부가 달린 글 — 있으면 확대 보기에서 같은 칸의 그림을 넘겨 본다. */
  message?: MessageRow;
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
            : <Attachment attachment={a} message={message} />}
        </div>
      ))}
    </div>
  );
}
