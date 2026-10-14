import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvatarCrop } from '@harkroom/shared';
import { Overlay } from '../Overlay';
import { Button } from './primitives';
import { useT } from '../../i18n/useT';
import {
  AVATAR_SMALL_PX, ZOOM_MAX, ZOOM_MIN, cropToView, fitView, panBy, placement, renderCrop,
  viewToCrop, viewToRect, zoomAround, type CropView, type Size,
} from '../../lib/avatarCrop';

/** 편집 칸 한 변(화면 px)과 그 안의 원 지름. 원 밖은 막으로 덮어 「무엇이 잘리는지」를 보인다. */
const STAGE_PX = 280;
const CIRCLE_PX = 236;
const INSET = (STAGE_PX - CIRCLE_PX) / 2;
/** 방향키 한 번(화면 px). Shift 는 크게 — 시안 규칙. */
const STEP_PX = 4;
const STEP_BIG_PX = 20;
/** +/− 한 번의 배율. */
const ZOOM_STEP = 1.1;

/**
 * 미리보기 — 실제로 그리는 크기 셋(designer n1·nit). 첫 칸은 **이 창을 연 설정 화면의 크기**라 부르는 쪽이 넘긴다
 * (에이전트 설정 h-12 = 48, 내 프로필 h-10 = 40). 둘을 다 세우면 한쪽은 늘 그 화면에 없는 거짓 칸이고, 칸 넷이면 줄이 넘쳤다.
 * 나머지는 메시지 거터 h-8 · 멘션·목록 h-5.
 */
const PREVIEWS_REST = [
  { px: 32, key: 'avatarCrop.previewMessage' },
  { px: 20, key: 'avatarCrop.previewMention' },
] as const;

/**
 * 「사진 맞추기」 모달(designer 시안 A, jaebin 결정 A + S1).
 *
 * 사진을 고르면 곧바로 뜨고 **저장을 눌러야 올라간다** — 전에는 고르자마자 올라가 가운데가 잘린 채로 걸렸다.
 * 걸린 사진은 아바타·Adjust 로 다시 연다(원본과 지난 자리로). 이 창은 바이트를 올리지 않는다: 저장을 누르면
 * 잘라 낸 정사각형과 자리를 `onSave` 로 넘기고, 올리기·진행 막대는 지금처럼 설정 줄(`AvatarStatus`)이 맡는다.
 *
 * 셈은 `lib/avatarCrop.ts` 하나다 — 끌기·휠·슬라이더·키가 모두 같은 `CropView` 를 고치고, 편집 칸과 미리보기가
 * 같은 `placement` 로 그린다(보이는 것과 저장되는 것이 어긋나지 않게).
 */
export function AvatarCropDialog({
  src, isGif, initialCrop, name, settingsPx, onCancel, onSave, onPickOther,
}: {
  /** 원본을 가리키는 objectURL. 부르는 쪽이 만들고 치운다. */
  src: string;
  /** 움직이는 GIF 일 수 있으면 「첫 장만 남는다」를 알린다. */
  isGif: boolean;
  /** 지난번 자리. 새 사진·옛 사진이면 null(가운데·딱 맞는 크기). */
  initialCrop: AvatarCrop | null;
  /** 미리보기 메시지 줄의 이름. */
  name: string;
  /** 이 창을 연 설정 화면이 아바타를 그리는 크기(px). 미리보기 첫 칸이 된다. */
  settingsPx: number;
  onCancel(): void;
  onSave(result: { blob: Blob; crop: AvatarCrop }): void;
  /** 「다른 사진…」 — 파일 창을 다시 연다. 고르면 부르는 쪽이 `src` 를 바꿔 이 창을 다시 그린다. */
  onPickOther(): void;
}) {
  const t = useT();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<CropView | null>(null);
  const [saving, setSaving] = useState(false);
  /** 잘라 내기(캔버스)가 실패했다. 사진은 떠 있으니 「열 수 없다」와 다른 말이 필요하다(designer s2). */
  const [saveFailed, setSaveFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; view: CropView } | null>(null);

  // 원본이 바뀌면(다른 사진) 부르는 쪽이 `key={src}` 로 이 창을 새로 띄운다 — 여기서 effect 로 상태를 비우면
  // 빨리 뜬 그림의 load 가 그 effect 보다 먼저 와서 잰 크기가 지워지고 「여는 중」에 멈춘다(캡처로 확인).

  const onLoad = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    // 크기를 적지 않은 SVG 는 natural 크기가 0 이다 — 정사각형으로 본다(출력 크기로 그려 굳힌다).
    const s = { width: el.naturalWidth || 512, height: el.naturalHeight || 512 };
    setSize(s);
    setView(cropToView(s, initialCrop));
  }, [initialCrop]);

  // 열리면 편집 칸에 포커스(Overlay 는 안에 포커스가 이미 있으면 그대로 둔다).
  useEffect(() => { if (size) stageRef.current?.focus(); }, [size]);

  const update = useCallback((fn: (s: Size, v: CropView) => CropView) => {
    setView((v) => (v && size ? fn(size, v) : v));
  }, [size]);

  // 휠·트랙패드 핀치(ctrl+wheel 로 온다)는 커서 자리를 고정한다. React 의 onWheel 은 passive 라
  // 막을 수 없어 문서가 함께 굴러간다 — 그래서 직접 단다.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dx = e.clientX - r.left - STAGE_PX / 2;
      const dy = e.clientY - r.top - STAGE_PX / 2;
      update((s, v) => zoomAround(s, v, v.zoom * Math.exp(-e.deltaY * 0.0025), dx, dy, CIRCLE_PX));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [update, size]);

  const save = useCallback(async () => {
    if (!size || !view || !imgRef.current || saving) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      const blob = await renderCrop(imgRef.current, viewToRect(size, view));
      onSave({ blob, crop: viewToCrop(size, view) });
    } catch {
      // 조용히 버튼만 되살리면 사람은 저장이 된 줄 안다 — 저장 버튼 옆에 말한다.
      setSaveFailed(true);
      setSaving(false);
    }
  }, [size, view, saving, onSave]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? STEP_BIG_PX : STEP_PX;
    // 슬라이더 위의 방향키는 슬라이더의 것이다.
    if ((e.target as HTMLElement).tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
    let handled = true;
    switch (e.key) {
      // 방향키는 「사진을 그쪽으로 옮긴다」가 아니라 「원을 그쪽으로 옮긴다」 — 시안과 같다.
      case 'ArrowLeft': update((s, v) => panBy(s, v, step, 0, CIRCLE_PX)); break;
      case 'ArrowRight': update((s, v) => panBy(s, v, -step, 0, CIRCLE_PX)); break;
      case 'ArrowUp': update((s, v) => panBy(s, v, 0, step, CIRCLE_PX)); break;
      case 'ArrowDown': update((s, v) => panBy(s, v, 0, -step, CIRCLE_PX)); break;
      case '+': case '=': update((s, v) => zoomAround(s, v, v.zoom * ZOOM_STEP, 0, 0, CIRCLE_PX)); break;
      case '-': case '_': update((s, v) => zoomAround(s, v, v.zoom / ZOOM_STEP, 0, 0, CIRCLE_PX)); break;
      case '0': update((s) => fitView(s)); break;
      case 'Enter':
        // 버튼 위의 Enter 는 그 버튼의 것이다(취소에 포커스를 두고 Enter 를 쳤는데 저장되면 안 된다).
        if ((e.target as HTMLElement).tagName === 'BUTTON') { handled = false; break; }
        void save();
        break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, view };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !size) return;
    setView(panBy(size, d.view, e.clientX - d.x, e.clientY - d.y, CIRCLE_PX));
  };
  const endDrag = () => { drag.current = null; };

  const ready = size && view;
  const small = size ? Math.min(size.width, size.height) < AVATAR_SMALL_PX : false;

  const pic = (px: number, offset = 0) => {
    if (!ready) return null;
    const p = placement(size, view, px);
    return (
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{ left: p.left + offset, top: p.top + offset, width: p.width, height: p.height }}
      />
    );
  };

  return (
    <Overlay label={t('avatarCrop.title')} onClose={saving ? () => {} : onCancel} align="center" className="w-[min(620px,calc(100vw-32px))]">
      <div className="flex flex-col gap-4 p-4" onKeyDown={onKeyDown} data-testid="avatar-crop">
        <p className="text-name font-medium text-fg">{t('avatarCrop.title')}</p>
        <div className="flex flex-wrap gap-5">
          <div>
            <div
              ref={stageRef}
              tabIndex={0}
              role="group"
              aria-label={t('avatarCrop.stageAria')}
              data-testid="avatar-crop-stage"
              data-crop={ready ? JSON.stringify(viewToCrop(size, view)) : undefined}
              className="relative cursor-grab touch-none select-none overflow-hidden rounded-card bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
              style={{ width: STAGE_PX, height: STAGE_PX }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {/* 재는 용도의 원본. 보이지 않게 두고, 그리기는 아래 자리 잡은 사본이 한다. */}
              <img ref={imgRef} src={src} alt="" className="hidden" onLoad={onLoad} onError={() => setFailed(true)} />
              {pic(CIRCLE_PX, INSET)}
              {ready && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute rounded-avatar border-[1.5px] border-white/90"
                  // 틀 밖을 덮는 막. 그림자 하나로 칸 전체를 덮는다 — 라이트·다크 모두 사진 위라 같은 막을 쓴다.
                  // 틀은 원이 아니라 아바타와 같은 둥근 사각형(모바일 비율 10/36, #1361)이다 — 맞춘 그대로 보이게.
                  style={{ left: INSET, top: INSET, width: CIRCLE_PX, height: CIRCLE_PX, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.5)' }}
                />
              )}
              {!ready && (
                <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-meta text-fg-muted">
                  {failed ? t('avatarCrop.loadFailed') : t('avatarCrop.loading')}
                </p>
              )}
            </div>
            <label className="mt-3 flex items-center gap-2" style={{ width: STAGE_PX }}>
              <span aria-hidden className="w-4 text-center text-meta text-fg-muted">−</span>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={0.01}
                value={view?.zoom ?? ZOOM_MIN}
                disabled={!ready}
                aria-label={t('avatarCrop.zoom')}
                aria-valuetext={`${Math.round((view?.zoom ?? 1) * 100)}%`}
                data-testid="avatar-crop-zoom"
                className="flex-1 accent-accent"
                onChange={(e) => update((s, v) => zoomAround(s, v, Number(e.target.value), 0, 0, CIRCLE_PX))}
              />
              <span aria-hidden className="w-4 text-center text-meta text-fg-muted">+</span>
            </label>
            <p className="mt-1 text-meta text-fg-muted">{t('avatarCrop.hint')}</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-meta text-fg-muted">{t('avatarCrop.preview')}</p>
            <div className="mb-3 mt-1.5 flex flex-wrap items-end gap-4">
              {[{ px: settingsPx, key: 'avatarCrop.previewSettings' as const }, ...PREVIEWS_REST].map(({ px, key }) => (
                <figure key={px} className="m-0 text-center text-meta text-fg-muted">
                  <div className="relative mx-auto mb-1 overflow-hidden rounded-avatar bg-surface-sunken" style={{ width: px, height: px }}>
                    {pic(px)}
                  </div>
                  {t(key, { px })}
                </figure>
              ))}
            </div>
            <div className="flex items-start gap-2 rounded-card bg-surface-sunken px-2.5 py-2">
              <div className="relative shrink-0 overflow-hidden rounded-avatar bg-surface" style={{ width: 32, height: 32 }}>{pic(32)}</div>
              <div className="min-w-0">
                <span className="font-medium text-fg">{name}</span>
                <p className="text-fg">{t('avatarCrop.previewSample')}</p>
              </div>
            </div>
            {isGif && <p className="mt-2.5 text-meta text-fg-muted">{t('avatarCrop.gif')}</p>}
            {small && <p className="mt-2.5 text-meta text-fg-muted">{t('avatarCrop.small')}</p>}
            <button
              type="button"
              className="mt-2 text-meta font-medium text-fg-muted hover:text-fg disabled:opacity-50"
              disabled={saving}
              onClick={onPickOther}
            >
              {t('avatarCrop.other')}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="text-meta font-medium text-fg-muted hover:text-fg disabled:opacity-50"
            disabled={!ready || saving}
            onClick={() => update((s) => fitView(s))}
          >
            {t('avatarCrop.reset')}
          </button>
          <span className="flex flex-wrap items-center justify-end gap-2">
            {saveFailed && (
              <span role="alert" data-testid="avatar-crop-save-failed" className="text-meta text-danger">{t('avatarCrop.saveFailed')}</span>
            )}
            <Button disabled={saving} onClick={onCancel}>{t('avatarCrop.cancel')}</Button>
            <Button variant="primary" disabled={!ready || saving} onClick={() => void save()}>{t('avatarCrop.save')}</Button>
          </span>
        </div>
      </div>
    </Overlay>
  );
}
