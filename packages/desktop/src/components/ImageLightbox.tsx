import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttachmentRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { Overlay } from './Overlay';
import { useT } from '../i18n/useT';
import { formatSize } from './Attachments';
import { clampScale, fitScale, percent, pinchFactor, scrollToKeep, stepDown, stepUp } from '../lib/imageZoom';
import { SWIPE_IDLE_MS, SWIPE_THRESHOLD } from '../lib/imageGallery';

/**
 * 넘겨 보기(designer 사양, 2026-10-02) — 같은 칸의 그림이 둘 이상이면 준다. 장은 `index`(0부터)다.
 * 끝에서는 **멈춘다**(돌아가지 않는다): 부르는 쪽이 첫·끝에서 `onPrev`/`onNext` 를 주지 않는다.
 */
export interface LightboxNav {
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** 보낸 사람 이름 · 시각(이미 다듬은 글자). */
  sender: string;
  at: string;
  /** [글로 가기] — 닫고 그 글을 연다. */
  onGoTo: () => void;
}

/**
 * 확대 보기(라이트박스) — designer 사양 3192efed(2026-10-02).
 *
 * 왜 바뀌었나: 예전엔 그림 한 장을 `max-h-[80vh] object-contain` 으로 그렸다. 세로로 긴 캡처는 높이에 맞춰 줄어
 * 폭이 수십 px 가 됐고 확대할 길이 없었다(jaebin "확대도 안되고 엄청 작게 보여"). 그래서
 * - 처음 배율은 **폭 맞춤**(`fitScale`, 높이는 보지 않는다)이고 세로로 스크롤한다. 맨 위부터 보인다.
 * - 크기는 `transform` 이 아니라 그림의 **실제 폭·높이**로 바꾼다 — 스크롤 칸이 그대로 움직여 스크롤바가 남고
 *   끌기·화살표·Space·Home/End 가 같은 칸을 움직인다.
 * - 클릭은 맞춤 ↔ 100%(누른 자리를 커서 밑에), ⌘+/⌘−/⌘0/⌘1, 트랙패드 핀치(ctrl+휠)·⌘+휠은 커서 중심 연속 확대.
 *   **그냥 휠은 스크롤이다** — 확대로 빼앗지 않는다.
 * - Esc 는 확대 상태면 먼저 맞춤으로, 맞춤이면 닫는다. ×·바깥 클릭은 바로 닫는다(`Overlay` 규칙).
 *
 * 바이트는 다시 받지 않는다 — 본문이 이미 받은 objectURL 을 그대로 쓴다(Attachments.tsx 의 같은 이유).
 */
export function ImageLightbox({ attachment, url, failed = false, onRetry, onClose, nav, saveable = true }: {
  attachment: AttachmentRow;
  /** null = 아직 받는 중(넘겨 본 장의 바이트가 안 왔다). */
  url: string | null;
  failed?: boolean;
  onRetry?: () => void;
  onClose: () => void;
  /** 작성창에서 아직 올라가지 않은 파일은 저장할 것이 없다 — 고른 그 파일이 사람 디스크에 있다. */
  saveable?: boolean;
  nav?: LightboxNav;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1);
  // null = 맞춤을 따라간다(창 크기가 바뀌면 같이 바뀐다). 숫자 = 사람이 고른 배율.
  const [manual, setManual] = useState<number | null>(null);
  const scale = manual ?? fit;
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const measure = useCallback(() => {
    const body = bodyRef.current;
    if (!body || !natural) return;
    setFit(fitScale(body.clientWidth, natural.w));
  }, [natural]);

  useLayoutEffect(() => { measure(); }, [measure]);

  // 장을 넘기면 **언제나 폭 맞춤·맨 위**로 연다(사양 3) — 앞 그림의 배율·스크롤을 남기지 않는다.
  const firstAttachment = useRef(attachment.id);
  useLayoutEffect(() => {
    if (firstAttachment.current === attachment.id) return;
    firstAttachment.current = attachment.id;
    setManual(null);
    setNatural(null);
    const body = bodyRef.current;
    if (body) { body.scrollTop = 0; body.scrollLeft = 0; }
  }, [attachment.id]);

  /** 가로로 넘치는가 — 넘치면 ←/→·좌우 스와이프는 스크롤이고 장을 넘기지 않는다(사양 2). */
  const overflowsX = (): boolean => {
    const body = bodyRef.current;
    return !!natural && !!body && natural.w * scale > body.clientWidth + 1;
  };
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !bodyRef.current) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // 배율을 바꾼 뒤 그 렌더에서 스크롤을 맞춘다 — 한 점을 커서 밑에 두기(`scrollToKeep`).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const want = pendingScroll.current;
    if (!body || !want) return;
    pendingScroll.current = null;
    body.scrollLeft = want.left;
    body.scrollTop = want.top;
  }, [scale]);

  // 포커스는 본문 칸에 둔다 — 화살표·Space·Home/End 가 바로 스크롤하고, Enter 로 [저장]이 눌리는 일이 없다.
  useEffect(() => { bodyRef.current?.focus(); }, []);

  /** 배율을 바꾼다. `at` 은 본문 칸 안의 기준점(px) — 없으면 칸 가운데. */
  const zoomTo = useCallback((next: number | 'fit', at?: { x: number; y: number }) => {
    const body = bodyRef.current;
    const to = next === 'fit' ? fit : clampScale(next, fit);
    if (body) {
      const ox = at?.x ?? body.clientWidth / 2;
      const oy = at?.y ?? body.clientHeight / 2;
      pendingScroll.current = {
        left: scrollToKeep(body.scrollLeft, ox, scale, to),
        top: scrollToKeep(body.scrollTop, oy, scale, to),
      };
    }
    setManual(next === 'fit' ? null : to);
  }, [fit, scale]);

  const isFit = manual === null || Math.abs(manual - fit) < 1e-6;

  // ⌘ 단축키와 Esc 는 **문서 캡처 단계**에서 받는다 — `Overlay` 의 Esc(닫기)는 문서 버블 단계라, 확대 상태의
  // Esc 를 여기서 멈춰야 "먼저 맞춤으로" 가 된다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isFit) return;
        e.preventDefault();
        e.stopPropagation();
        zoomTo('fit');
        return;
      }
      if (nav && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && !(e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)) {
        // 확대 중이고 가로로 넘치면 스크롤에 맡긴다 — Esc 로 맞춤에 돌아간 뒤 넘긴다(#1099 키보드 스크롤과 안 부딪친다).
        if (overflowsX()) return;
        e.preventDefault();
        e.stopPropagation();
        (e.key === 'ArrowLeft' ? nav.onPrev : nav.onNext)?.();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      let handled = true;
      if (e.key === '+' || e.key === '=') zoomTo(stepUp(scale, fit));
      else if (e.key === '-' || e.key === '_') zoomTo(stepDown(scale, fit));
      else if (e.key === '0') zoomTo('fit');
      else if (e.key === '1') zoomTo(1);
      else handled = false;
      if (handled) {
        // **앱 전체 배율(Workspace 의 ⌘+/⌘−/⌘0)까지 내려가지 않게 멈춘다**(designer 수정 1) — 같은 문서의 버블
        // 리스너라 preventDefault 만으로는 돈다. 그림을 키우려다 앱 글자가 같이 커지고 닫아도 남았다.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isFit, scale, fit, zoomTo, nav, natural]);

  // 트랙패드 좌우 스와이프의 누적 — 한 번 넘기면 손을 뗄 때(휠이 잠시 멎을 때)까지 다시 넘기지 않는다.
  const swipe = useRef<{ dx: number; fired: boolean; timer: ReturnType<typeof setTimeout> | null }>({ dx: 0, fired: false, timer: null });
  useEffect(() => () => { if (swipe.current.timer) clearTimeout(swipe.current.timer); }, []);

  // 핀치(ctrl+휠)·⌘+휠만 확대다. passive 가 아니어야 막을 수 있다 — React 의 onWheel 은 passive 라 직접 단다.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        // 좌우 스와이프는 **맞춤이고 가로로 움직일 것이 없을 때만** 넘김이다. 그 밖은 지금처럼 스크롤.
        if (!nav || nav.total < 2 || Math.abs(e.deltaX) <= Math.abs(e.deltaY) || overflowsX()) return;
        e.preventDefault();
        const s = swipe.current;
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(() => { s.dx = 0; s.fired = false; s.timer = null; }, SWIPE_IDLE_MS);
        if (s.fired) return;
        s.dx += e.deltaX;
        if (Math.abs(s.dx) < SWIPE_THRESHOLD) return;
        s.fired = true;
        (s.dx > 0 ? nav.onNext : nav.onPrev)?.();
        return;
      }
      e.preventDefault();
      const rect = body.getBoundingClientRect();
      zoomTo(scale * pinchFactor(e.deltaY), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, [scale, zoomTo, nav, natural]);

  const overflows = !!natural && !!bodyRef.current
    && (natural.w * scale > bodyRef.current.clientWidth + 1 || natural.h * scale > bodyRef.current.clientHeight + 1);

  const onPointerDown = (e: React.PointerEvent) => {
    const body = bodyRef.current;
    if (!body || e.button !== 0) return;
    // 칸을 붙잡는다 — 빠르게 끌어 마우스가 칸 밖으로 나가도 끌기가 끊기지 않는다(designer b).
    body.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: body.scrollLeft, top: body.scrollTop, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const body = bodyRef.current;
    if (!d || !body) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // 4px 를 넘게 움직여야 끌기다 — 그 아래는 클릭(배율 바꾸기)으로 남긴다.
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    if (!d.moved) { d.moved = true; setDragging(true); }
    body.scrollLeft = d.left - dx;
    body.scrollTop = d.top - dy;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d || d.moved) return;
    // 그림 위를 눌렀을 때만 배율을 바꾼다 — 작은 그림 옆 빈 자리를 눌러 배율이 바뀌면 안 된다(designer c).
    if (!(e.target instanceof HTMLImageElement)) return;
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    // 클릭: 맞춤 ↔ 100%. 100% 로 갈 때 누른 자리가 커서 밑에 온다.
    zoomTo(isFit ? 1 : 'fit', { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  // 맞춤이 곧 100% 인 그림(작은 그림)은 눌러도 바뀌는 것이 없다 — 그때는 기본 커서(designer a).
  const nothingToToggle = Math.abs(fit - 1) < 1e-6 && Math.abs(scale - 1) < 1e-6;
  const cursor = dragging ? 'grabbing'
    : overflows && !isFit ? 'grab'
      : nothingToToggle ? 'default'
        : isFit ? 'zoom-in' : 'zoom-out';
  const arrow = 'absolute top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-surface/70 text-title '
    + 'text-fg shadow-float opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100';
  const btn = 'shrink-0 rounded-row px-1.5 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken disabled:opacity-40';

  return (
    // 판 크기는 창의 92vw × 88vh 다. 머리줄은 고정이고 그 아래 본문 칸이 스크롤된다.
    <Overlay label={attachment.filename} onClose={onClose} align="center" className="h-[88vh] w-[92vw]">
      <header className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 items-center gap-0.5" data-testid="zoom-controls">
          <button type="button" className={btn} onClick={() => zoomTo(stepDown(scale, fit))}
            aria-label={t('message.attachment.zoomOut')} data-testid="zoom-out">−</button>
          <button type="button" className="min-w-[4.5rem] shrink-0 rounded-sm px-1 text-meta tabular-nums text-fg hover:bg-surface-sunken"
            onClick={() => zoomTo(isFit ? 1 : 'fit')} data-testid="zoom-level" aria-live="polite">
            {isFit ? t('message.attachment.zoomFitLevel', { percent: percent(fit) }) : percent(scale)}
          </button>
          <button type="button" className={btn} onClick={() => zoomTo(stepUp(scale, fit))}
            aria-label={t('message.attachment.zoomIn')} data-testid="zoom-in">+</button>
          <button type="button" className={btn} onClick={() => zoomTo('fit')} disabled={isFit}
            aria-label={t('message.attachment.zoomFit')} data-testid="zoom-fit">{t('message.attachment.zoomFitShort')}</button>
          <button type="button" className={btn} onClick={() => zoomTo(1)} disabled={Math.abs(scale - 1) < 1e-6}
            aria-label={t('message.attachment.zoomActual')} data-testid="zoom-actual">100%</button>
        </div>
        {nav && nav.total > 1 && (
          <span className="shrink-0 text-meta tabular-nums text-fg-muted" data-testid="gallery-position">
            {nav.index + 1} / {nav.total}
          </span>
        )}
        <span className="min-w-0 truncate font-medium">{attachment.filename}</span>
        <span className="shrink-0 text-fg-subtle">{formatSize(attachment.sizeBytes)}</span>
        {saveable && (
          <button
            className="ml-auto shrink-0 rounded-row border border-border px-2 py-0.5 text-meta text-fg-muted hover:bg-surface-sunken"
            onClick={() => void getController().saveAttachment(attachment)}
          >{t('message.attachment.save')}</button>
        )}
        <button
          className={`${saveable ? '' : 'ml-auto '}shrink-0 rounded-row px-2 text-fg-subtle hover:bg-surface-sunken`}
          onClick={onClose}
          aria-label={t('message.attachment.closeZoom')}
        >×</button>
      </div>
      {nav && (
        // 이 그림이 어느 글의 것인지 — 보낸 사람 · 시각 · [글로 가기](사양 4).
        <div className="mt-0.5 flex items-center gap-1.5 text-meta text-fg-subtle" data-testid="gallery-source">
          <span className="min-w-0 truncate">{nav.sender}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{nav.at}</span>
          <button type="button" className="shrink-0 rounded-sm px-1 text-fg-muted underline-offset-2 hover:underline"
            onClick={nav.onGoTo} data-testid="gallery-goto">{t('message.attachment.goToMessage')}</button>
        </div>
      )}
      {nav && nav.total > 1 && (
        <span className="sr-only" aria-live="polite" data-testid="gallery-announce">
          {t('message.attachment.galleryAnnounce', { index: nav.index + 1, total: nav.total, sender: nav.sender })}
        </span>
      )}
      </header>
      <div className="group relative flex min-h-0 flex-1">
      <div
        ref={bodyRef}
        tabIndex={0}
        data-testid="zoom-body"
        className="min-h-0 flex-1 overflow-auto outline-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
      >
        {/* 그림이 칸보다 작으면 가운데, 크면 왼쪽 위부터 — `m-auto` 가 둘 다 한다. */}
        <div className="flex min-h-full min-w-full">
          {!url ? (
            // 넘겨 본 장의 바이트가 아직 안 왔거나 못 받았다(사양 4).
            <div className="m-auto flex flex-col items-center gap-2 text-meta text-fg-muted" data-testid="gallery-pending">
              {failed ? (
                <>
                  <span className="text-danger">{t('message.attachment.loadFailedLong')}</span>
                  {onRetry && (
                    <button type="button" className="rounded-row border border-border px-2 py-0.5 hover:bg-surface-sunken"
                      onClick={onRetry} data-testid="gallery-retry">{t('message.attachment.retry')}</button>
                  )}
                </>
              ) : (
                <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-fg-muted" role="status"
                  aria-label={t('message.attachment.loading')} />
              )}
            </div>
          ) : (
          <img
            key={attachment.id}
            src={url}
            alt={attachment.filename}
            data-testid="attachment-full"
            data-scale={scale.toFixed(3)}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            className="m-auto block max-w-none select-none"
            style={natural ? { width: natural.w * scale, height: natural.h * scale } : { maxWidth: '100%' }}
          />
          )}
        </div>
      </div>
      {nav && nav.total > 1 && (
        <>
          {/* 판 좌우 가장자리 가운데의 36px 원형 버튼 — 마우스가 판 위에 있을 때만 진하다. 첫·끝에서는 그쪽을 숨긴다. */}
          {nav.onPrev && (
            <button type="button" onClick={nav.onPrev} aria-label={t('message.attachment.prev')} data-testid="gallery-prev"
              className={`${arrow} left-3`}>‹</button>
          )}
          {nav.onNext && (
            <button type="button" onClick={nav.onNext} aria-label={t('message.attachment.next')} data-testid="gallery-next"
              className={`${arrow} right-3`}>›</button>
          )}
        </>
      )}
      </div>
    </Overlay>
  );
}
