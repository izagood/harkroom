/**
 * 미리보기(아티팩트) 배율 — designer 시안 v1 C안(스레드 ee707114, jaebin 「추천대로」 2026-10-27).
 *
 * ## 왜 transform 인가
 * 미리보기는 교차 origin·sandbox iframe 이라 앱이 페이지 안에 CSS `zoom` 을 넣을 수 없다. 그래서 iframe 상자를
 * `transform: scale(s)` 로 줄이고 그만큼(÷ s) 넓게 그린다. 그러면 **줄일수록 페이지가 넓은 화면을 본다** —
 * 반응형 시안은 데스크톱 배치로 바뀐다. 이 기능의 쓸모 대부분이 여기서 나온다.
 *
 * ## 두 가지 상태
 * - `scale`: 단추(−/+)·⌘키로 고른 배율. 보는 폭은 상자 폭 ÷ 배율이라 패널을 끌면 같이 바뀐다.
 * - `fit`: 「폭에 맞춤」 — 페이지가 늘 그 폭의 화면을 본다. 배율은 상자 폭 ÷ 목표 폭이고 **100% 를 넘지 않는다**
 *   — 상자가 더 넓으면 100% 로 가운데 선다(390 맞춤을 넓은 패널에서 폰 폭으로 보는 길).
 *
 * 기억은 시안(artifactId)마다 기기 로컬이다 — 다음 버전도 같은 artifactId 라 그대로 이어받는다.
 */

/** 브라우저식 단계(designer 결정 표 #2). 앱 배율표(`zoom.ts`, 70~)는 축소 폭이 모자라 따로 둔다. */
export const PREVIEW_ZOOM_STEPS: readonly number[] = [50, 67, 75, 80, 90, 100, 110, 125, 150, 200];
export const PREVIEW_ZOOM_MIN = 50;
export const PREVIEW_ZOOM_MAX = 200;
/** 「폭에 맞춤」 목표 폭 — 데스크톱·노트북·태블릿·폰. */
export const PREVIEW_FIT_WIDTHS = [1440, 1280, 768, 390] as const;

export type PreviewZoom = { kind: 'scale'; pct: number } | { kind: 'fit'; width: number };
export const PREVIEW_ZOOM_DEFAULT: PreviewZoom = { kind: 'scale', pct: 100 };

export const isDefaultZoom = (z: PreviewZoom): boolean => z.kind === 'scale' && z.pct === 100;

/** 지금 실제 배율(1 = 100%). 맞춤인데 상자를 아직 못 쟀으면(0) 1 로 둔다 — 그림이 사라지는 것보다 낫다. */
export function effectiveScale(z: PreviewZoom, boxWidth: number): number {
  if (z.kind === 'scale') return z.pct / 100;
  if (boxWidth <= 0) return 1;
  return Math.min(1, boxWidth / z.width);
}

/** 페이지가 보는 폭(px). 맞춤이면 목표 폭 그대로, 배율이면 상자 폭 ÷ 배율. */
export function viewportWidth(z: PreviewZoom, boxWidth: number): number {
  if (z.kind === 'fit') return z.width;
  return Math.round(boxWidth / (z.pct / 100));
}

/**
 * 한 단계 키우기·줄이기. 지금 배율(맞춤이면 그때 계산된 값)에서 **엄격히** 다음 단계로 간다 — 맞춤으로 36% 인
 * 상태에서 + 를 누르면 50%, − 는 50% 에서 멈춘다(맞춤 36% 에서 − 를 누르면 50% 로 커지지 않고 그대로).
 */
export function stepPreviewZoom(z: PreviewZoom, direction: 1 | -1, boxWidth: number): PreviewZoom {
  const now = Math.round(effectiveScale(z, boxWidth) * 100);
  if (direction === 1) {
    const next = PREVIEW_ZOOM_STEPS.find((s) => s > now);
    return next === undefined ? z : { kind: 'scale', pct: next };
  }
  const prev = [...PREVIEW_ZOOM_STEPS].reverse().find((s) => s < now);
  return prev === undefined ? z : { kind: 'scale', pct: prev };
}

export const canZoomIn = (z: PreviewZoom, boxWidth: number): boolean =>
  Math.round(effectiveScale(z, boxWidth) * 100) < PREVIEW_ZOOM_MAX;
export const canZoomOut = (z: PreviewZoom, boxWidth: number): boolean =>
  Math.round(effectiveScale(z, boxWidth) * 100) > PREVIEW_ZOOM_MIN;

/** 저장된 값을 믿지 않는다 — 단계표에 없는 배율·목록에 없는 폭은 버린다. */
export function normalizePreviewZoom(v: unknown): PreviewZoom | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.kind === 'scale' && typeof o.pct === 'number' && PREVIEW_ZOOM_STEPS.includes(o.pct)) return { kind: 'scale', pct: o.pct };
  if (o.kind === 'fit' && typeof o.width === 'number' && (PREVIEW_FIT_WIDTHS as readonly number[]).includes(o.width)) {
    return { kind: 'fit', width: o.width };
  }
  return null;
}

const KEY = 'harkroom.previewZoom';
/** 시안마다 한 줄이라 끝없이 쌓이지 않게 최근 것만 남긴다. */
export const PREVIEW_ZOOM_REMEMBERED = 200;

type Saved = Record<string, { z: PreviewZoom; at: number }>;

function readAll(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Saved : {};
  } catch {
    return {};
  }
}

export const previewZoomStorage = {
  load(artifactId: string): PreviewZoom {
    return normalizePreviewZoom(readAll()[artifactId]?.z) ?? PREVIEW_ZOOM_DEFAULT;
  },
  /** 기본값(100%)은 줄을 지운다 — 「기억 안 한 것」과 같다. */
  save(artifactId: string, z: PreviewZoom, now = Date.now()): void {
    const all = readAll();
    if (isDefaultZoom(z)) delete all[artifactId];
    else all[artifactId] = { z, at: now };
    const keys = Object.keys(all);
    if (keys.length > PREVIEW_ZOOM_REMEMBERED) {
      keys.sort((a, b) => (all[b]?.at ?? 0) - (all[a]?.at ?? 0));
      for (const k of keys.slice(PREVIEW_ZOOM_REMEMBERED)) delete all[k];
    }
    try {
      if (Object.keys(all).length === 0) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(all));
    } catch { /* 저장 불가 환경 허용 */ }
  },
};
