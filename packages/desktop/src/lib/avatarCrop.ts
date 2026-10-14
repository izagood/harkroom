import type { AvatarCrop } from '@harkroom/shared';

/**
 * 사진 맞추기의 셈(designer 시안 avatar-crop.html, A 모달 + S1).
 *
 * 화면과 떼어 둔다 — 끌기·휠·키가 모두 같은 「원 가운데가 원본의 어디인가 + 몇 배인가」 두 값을 고치고,
 * 그 두 값에서 미리보기·저장할 자리가 나온다. 셈이 화면 안에 섞이면 조작마다 조금씩 다른 식이 생긴다.
 *
 * 모든 좌표는 **원본 픽셀**이다. 서버에 남기는 `AvatarCrop` 만 비율이다(원본 크기를 서버가 모른다).
 */

/** 확대 범위. 1 = 원본의 짧은 변이 원에 꼭 맞는 배율(지금 앱이 자르던 모양). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** 올리는 정사각형 한 변. 가장 큰 자리(설정 64px)의 레티나 두 배를 넉넉히 넘는다. */
export const AVATAR_OUT_PX = 512;
/** 짧은 변이 이보다 작으면 「흐릿할 수 있다」고만 알린다(막지 않는다). */
export const AVATAR_SMALL_PX = 128;

/**
 * 「사진 맞추기」에서 저장을 눌렀을 때 넘기는 것. `cropped` 는 잘라 낸 정사각형 바이트, `source` 는 원본 —
 * 새로 고른 파일이거나(올려야 한다) 이미 걸린 첨부(다시 맞추기·옛 사진)다.
 */
export interface AvatarSave {
  cropped: Blob;
  crop: AvatarCrop;
  source: { kind: 'file'; file: File } | { kind: 'attached'; attachmentId: string };
}

export interface Size { width: number; height: number }

/** 편집 상태. `cx`·`cy` = 원 가운데가 가리키는 원본 픽셀, `zoom` = 1~4. */
export interface CropView { cx: number; cy: number; zoom: number }

/** 원본 픽셀의 정사각형(왼쪽 위 + 한 변). */
export interface CropRect { x: number; y: number; size: number }

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 배율 `zoom` 에서 원 안에 들어오는 정사각형 한 변(원본 픽셀). */
export function sideAt(img: Size, zoom: number): number {
  return Math.min(img.width, img.height) / clampNum(zoom, ZOOM_MIN, ZOOM_MAX);
}

/**
 * 원 안에 빈 곳이 생기지 않게 가운데를 묶는다 — 정사각형이 원본 밖으로 나가지 않는 범위.
 * 시안 규칙: 「사진은 원 밖으로 빠질 수 없다」.
 */
export function clampView(img: Size, v: CropView): CropView {
  const zoom = clampNum(v.zoom, ZOOM_MIN, ZOOM_MAX);
  const half = sideAt(img, zoom) / 2;
  return {
    zoom,
    cx: clampNum(v.cx, half, img.width - half),
    cy: clampNum(v.cy, half, img.height - half),
  };
}

/** 초기화 = 가운데·최소 배율. 지금 앱(`object-cover`)이 자르던 모양과 같다. */
export function fitView(img: Size): CropView {
  return { cx: img.width / 2, cy: img.height / 2, zoom: ZOOM_MIN };
}

export function viewToRect(img: Size, v: CropView): CropRect {
  const size = sideAt(img, v.zoom);
  return { x: v.cx - size / 2, y: v.cy - size / 2, size };
}

/** 서버에 남길 비율. `x`·`y` 는 폭·높이로, `size` 는 짧은 변으로 나눈다(`AvatarCrop` 주석). */
export function viewToCrop(img: Size, v: CropView): AvatarCrop {
  const r = viewToRect(img, v);
  const short = Math.min(img.width, img.height);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    x: clampNum(round(r.x / img.width), 0, 1),
    y: clampNum(round(r.y / img.height), 0, 1),
    size: clampNum(round(r.size / short), 1e-6, 1),
  };
}

/** 남겨 둔 비율에서 편집 상태로. 없으면(옛 사진) 초기 모양. 원본 크기가 바뀌었어도 범위 안으로 묶는다. */
export function cropToView(img: Size, crop: AvatarCrop | null): CropView {
  if (!crop) return fitView(img);
  const short = Math.min(img.width, img.height);
  const size = crop.size * short;
  return clampView(img, {
    cx: crop.x * img.width + size / 2,
    cy: crop.y * img.height + size / 2,
    zoom: size > 0 ? short / size : ZOOM_MIN,
  });
}

/**
 * 화면의 한 점(편집 칸 가운데로부터 `dx`·`dy` 화면 픽셀)을 고정한 채 배율을 바꾼다 — 휠·핀치는 커서 자리,
 * 슬라이더·키는 가운데(0,0). `stagePx` 는 원의 지름(화면 픽셀).
 */
export function zoomAround(img: Size, v: CropView, nextZoom: number, dx: number, dy: number, stagePx: number): CropView {
  const s0 = stagePx / sideAt(img, v.zoom);
  const px = v.cx + dx / s0;
  const py = v.cy + dy / s0;
  const zoom = clampNum(nextZoom, ZOOM_MIN, ZOOM_MAX);
  const s1 = stagePx / sideAt(img, zoom);
  return clampView(img, { zoom, cx: px - dx / s1, cy: py - dy / s1 });
}

/** 화면 픽셀만큼 사진을 끈다(끈 방향으로 사진이 움직이므로 가운데는 반대로 간다). */
export function panBy(img: Size, v: CropView, dx: number, dy: number, stagePx: number): CropView {
  const s = stagePx / sideAt(img, v.zoom);
  return clampView(img, { ...v, cx: v.cx - dx / s, cy: v.cy - dy / s });
}

/**
 * 원 지름 `px` 짜리 원 안에 사진을 그릴 CSS 값(왼쪽 위·폭·높이, 화면 픽셀). 편집 칸과 미리보기가 같은 식을 쓴다 —
 * 미리보기가 따로 셈하면 저장되는 것과 보이는 것이 어긋날 수 있다.
 */
export function placement(img: Size, v: CropView, px: number): { left: number; top: number; width: number; height: number } {
  const r = viewToRect(img, v);
  const s = px / r.size;
  return { left: -r.x * s, top: -r.y * s, width: img.width * s, height: img.height * s };
}

/**
 * 고른 자리를 `AVATAR_OUT_PX` 정사각형으로 잘라 바이트로 만든다(S1 — 그리는 쪽은 하나도 안 고친다).
 * WebP 를 먼저 청하고, 엔진이 못 만들면(돌려준 형식이 다르면) PNG 로 다시 만든다. GIF 는 첫 장만 남는다 —
 * 화면이 미리 알린다. SVG 는 이 크기로 그려 굳힌다.
 */
export async function renderCrop(img: CanvasImageSource, rect: CropRect): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_OUT_PX;
  canvas.height = AVATAR_OUT_PX;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas 2d unavailable');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, rect.x, rect.y, rect.size, rect.size, 0, 0, AVATAR_OUT_PX, AVATAR_OUT_PX);
  const toBlob = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await toBlob('image/webp', 0.9);
  if (webp && webp.type === 'image/webp') return webp;
  const png = await toBlob('image/png');
  if (!png) throw new Error('canvas export failed');
  return png;
}
