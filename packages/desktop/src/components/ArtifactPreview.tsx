import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useHostDocument } from '../lib/hostDocument';
import type { AttachmentRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { ApiError } from '../lib/api';
import { useT } from '../i18n/useT';
import { formatSize, useSaveButtonLabel } from './Attachments';
import { isMacOS, macTopBarMinHeight, macTrafficLightInset } from '../lib/platform';
import { allowPreviewOnce } from '../lib/previewAllowance';
import { PaneResizer } from './PaneResizer';
import { openWindow } from '../lib/windowActions';
import { Menu, type MenuItem } from './Menu';
import {
  PREVIEW_FIT_WIDTHS, PREVIEW_ZOOM_DEFAULT, canZoomIn, canZoomOut, effectiveScale, isDefaultZoom, previewZoomStorage,
  stepPreviewZoom, viewportWidth, type PreviewZoom,
} from '../lib/previewZoom';
import {
  paneStorage, paneMaxWidth, MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH, MIN_CHANNEL_WIDTH, MIN_THREAD_WIDTH, PREVIEW_DEFAULT_CSS,
} from '../lib/prefs';

/**
 * 미리보기(아티팩트) 화면 ④ — 에이전트가 `artifact.publish` 로 올린 HTML 을 앱 안에서 본다.
 * 사양: designer d8ca47be·abcc05cf, 구조·격리: harkroom 스레드 31121b84(#1045·#1050·#1065).
 *
 * ## 격리는 두 겹이다
 * 1. 서버가 `GET /preview/:token` 에 CSP `sandbox allow-scripts allow-popups`(allow-same-origin 없음)를 단다
 *    → 문서는 불투명 origin 에서 돈다(#1045).
 * 2. 여기 iframe 의 `sandbox="allow-scripts"` — 서버 값과 **교집합**이 적용되므로 팝업(새 창)도 막힌다.
 *    `allow-same-origin`·`allow-top-navigation`·`allow-popups`·`allow-forms` 를 주지 않는다. srcdoc 이 아니라
 *    서버 URL 을 띄우는 이유: srcdoc 은 앱(Tauri) origin 아래에서 돌아 IPC 주입 여부를 따져야 하고, 원격
 *    origin 은 Tauri capability 가 기본으로 막는다.
 *
 * ## 페이지가 다른 곳으로 가려 하면 막는다(security ④ 조건)
 * sandbox 는 **프레임 자신의 이동**은 막지 않는다 — 페이지가 `location = …` 으로 가짜 로그인 화면을 띄울 수
 * 있다. 교차 origin 프레임의 이동 대상은 앱이 읽을 수 없으므로, 첫 `load` 다음의 `load` 를 이동으로 보고
 * 프레임을 내리고 그 사실을 말한다([다시 불러오기]). 대상 URL 을 모르니 시스템 브라우저로 넘기지는 못한다 —
 * 새 창은 sandbox 가 이미 막는다.
 *
 * ## 토큰은 열 때마다 받는다
 * 서명 경로는 60초짜리다. 패널을 연 채 오래 두다가 다시 불러오면 **새로 받는다** — 만료를 오류로 보이지
 * 않는다(designer 기준). 그래서 경로를 상태에 오래 쥐지 않고 [다시 불러오기]가 언제나 `issuePreview` 를 부른다.
 */

/**
 * 패널을 연 카드와 연 방식. 닫을 때 포커스를 어디에 둘지가 이것으로 갈린다(designer 2026-10-05):
 * 마우스로 열었으면 놓는다 — 카드에 남은 포커스가 Esc 뒤 `:focus-visible` 링으로 그려져 선택 표시처럼 남았다.
 * 키보드로 열었으면 카드로 돌려준다 — 놓으면 키보드 사용자가 자리를 잃는다.
 */
let opener: { el: HTMLElement; byKeyboard: boolean } | null = null;
export function noteArtifactOpener(el: HTMLElement, byKeyboard: boolean): void {
  opener = { el, byKeyboard };
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; url: string; title: string }
  | { kind: 'navigated' }
  | { kind: 'error'; reason: 'tooLarge' | 'forbidden' | 'gone' | 'failed' };

function reasonOf(err: unknown): 'tooLarge' | 'forbidden' | 'gone' | 'failed' {
  if (err instanceof ApiError) {
    if (err.status === 413) return 'tooLarge';
    if (err.status === 403) return 'forbidden';
    if (err.status === 404) return 'gone';
  }
  return 'failed';
}

/**
 * 오른쪽 패널. 스레드 패널과 같은 자리에 형제로 선다(`Workspace.tsx`). ⤢ 로 창 전체를 덮고, Esc 는 한 단계씩
 * 닫는다(창 전체 → 패널 → 닫힘). 머리줄·아래 줄은 **iframe 밖에서 앱이 그린다** — 페이지가 앱 화면을 흉내
 * 내도 머리줄은 진짜라는 것이 보여야 한다.
 */
/** 「폭에 맞춤」 줄의 문구 — 키를 조각으로 짓지 않는다(안 쓰는 키 검사가 글자 그대로 찾는다). */
const FIT_LABEL = {
  1440: 'artifact.zoom.fit1440', 1280: 'artifact.zoom.fit1280', 768: 'artifact.zoom.fit768', 390: 'artifact.zoom.fit390',
} as const;

export function ArtifactPanel({ fill = false, windowed }: {
  /** 곁의 내용 칸이 고정 폭(스레드)일 때 남는 폭을 미리보기가 채운다(`Workspace.tsx` 수정 1). */
  fill?: boolean;
  /**
   * 미리보기 **새 창** 안이다(`AppWindowsHost`). 그 창이 쥔 판 하나를 그리고 창을 채운다 — 손잡이·⤢·⧉·× 가 없고,
   * × 자리에 창의 단추(`actions` — 📌·↩ 메인 창으로)가 선다. 머리줄이 곧 창 머리줄 하나다(designer C안, 2026-10-24):
   * 닫기는 OS(빨간 단추·⌘W)가 맡는다. 메인 패널의 가게 값(`artifactPreview`)·칸 바뀜 닫기·Esc 는 보지 않는다.
   */
  windowed?: { attachment: AttachmentRow; actions: ReactNode };
} = {}) {
  // 새 창 안이면 그 창의 문서를 듣는다(`lib/hostDocument`).
  const hostDoc = useHostDocument();
  const t = useT();
  const fromStore = useActiveStore((s) => s.artifactPreview);
  const attachment = windowed ? windowed.attachment : fromStore;
  // 저장 중(저장 창·받는 중)이면 [저장…]을 다시 못 누르고, 받는 동안은 칩과 같은 %를 말한다(designer #1475 n1).
  const save = useSaveButtonLabel(attachment?.id);
  const channelId = useActiveStore((s) => s.activeChannelId);
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const loads = useRef(0);
  const attempt = useRef(0);
  const [width, setStoredWidth] = useState(() => paneStorage.loadPreviewWidth());
  const setWidth = useCallback((next: number | null) => {
    setStoredWidth(next);
    paneStorage.savePreviewWidth(next);
  }, []);

  // 배율은 시안(artifactId)마다 기억한다 — 다음 버전도 같은 artifactId 라 이어받는다(`lib/previewZoom.ts`).
  // 키가 바뀐 첫 그림부터 저장값으로 선다(effect 로 미루면 100% 로 한 번 그렸다가 바뀐다).
  const zoomKey = attachment ? attachment.artifact?.artifactId ?? attachment.id : null;
  const [zoomState, setZoomState] = useState<{ key: string | null; z: PreviewZoom }>(() => ({
    key: zoomKey, z: zoomKey ? previewZoomStorage.load(zoomKey) : PREVIEW_ZOOM_DEFAULT,
  }));
  const zoom = zoomState.key === zoomKey ? zoomState.z : zoomKey ? previewZoomStorage.load(zoomKey) : PREVIEW_ZOOM_DEFAULT;
  useEffect(() => {
    setZoomState((cur) => cur.key === zoomKey ? cur : { key: zoomKey, z: zoomKey ? previewZoomStorage.load(zoomKey) : PREVIEW_ZOOM_DEFAULT });
  }, [zoomKey]);
  const setZoom = useCallback((z: PreviewZoom) => {
    setZoomState({ key: zoomKey, z });
    if (zoomKey) previewZoomStorage.save(zoomKey, z);
  }, [zoomKey]);
  // 페이지 상자의 폭 — 맞춤 배율과 「보는 폭」을 잰다. 배율 모드의 iframe 크기는 % 라 이 값 없이도 선다.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBoxWidth(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [attachment, expanded]);

  const load = useCallback((target: AttachmentRow) => {
    const mine = ++attempt.current;
    loads.current = 0;
    setPhase({ kind: 'loading' });
    getController().issuePreview(target.id).then(async (ticket) => {
      if (attempt.current !== mine) return;
      // src 를 넣기 **전에** 그 URL 하나를 내비게이션 훅에 한 번 허용해 둔다(A′). 실패하면 src 를 넣지 않는다 —
      // 넣으면 훅이 그 토큰 URL 을 시스템 브라우저로 넘긴다(`lib/previewAllowance.ts`).
      await allowPreviewOnce(ticket.url);
      if (attempt.current !== mine) return;
      setPhase({ kind: 'ready', url: ticket.url, title: ticket.title });
    }).catch((err: unknown) => {
      if (attempt.current !== mine) return;
      setPhase({ kind: 'error', reason: reasonOf(err) });
    });
  }, []);

  useEffect(() => {
    if (!attachment) return;
    setExpanded(false);
    load(attachment);
  }, [attachment, load]);

  /*
    선택 표시가 닫은 뒤에도 남던 것(소유자 신고 2026-10-05). 가게의 `artifactPreview` 는 닫으면 비지만, 누른
    카드에 포커스가 남아 있으면 Esc(키 입력) 뒤로 WebKit 이 그것을 `:focus-visible` 로 보고 전역 외곽선(2px
    주황)을 그린다 — 선택 테두리와 똑같아 보인다. 닫히는 순간 연 방식대로 포커스를 정리한다(`opener`).
  */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (windowed) return;
    if (attachment) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const o = opener;
    opener = null;
    if (o?.byKeyboard && o.el.isConnected) { o.el.focus(); return; }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-testid="artifact-card"]')) active.blur();
  }, [attachment]);

  /*
    카드가 있던 칸이 바뀌거나 사라지면 닫는다(designer 2026-10-05) — 채널을 옮기거나, 스레드를 열거나 바꾸거나
    닫으면. 채널에서 연 미리보기는 스레드 자리를 접어 두므로(`previewLayout`) 그대로 두면 새로 연 스레드가 보이지도
    않는다. 다른 카드를 누르는 것은 칸이 그대로이므로 닫지 않고 바꾼다.
  */
  const place = useActiveStore((s) => `${s.activeChannelId ?? ''}/${s.threadRootId ?? ''}`);
  const openedAt = useRef<string | null>(null);
  useEffect(() => {
    if (windowed) return;
    if (!attachment) { openedAt.current = null; return; }
    if (openedAt.current === null) { openedAt.current = place; return; }
    if (openedAt.current !== place) getController().closeArtifactPreview();
  }, [attachment, place]);

  // 보이는 폭은 저장된 숫자와 다를 수 있다(끈 적 없으면 CSS 기본 폭, fill 이면 남는 폭) — 끌기의 원점은 보이는
  // 폭이어야 손잡이가 바로 따라온다.
  const sectionRef = useRef<HTMLElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setMeasured(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill, attachment, expanded]);
  const dragWidth = Math.max(MIN_PREVIEW_WIDTH, fill ? Math.max(width ?? 0, measured) : (width ?? measured));

  useEffect(() => {
    if (!attachment || windowed) return;
    // 페이지 안을 한 번 누르면 키 입력은 교차 origin iframe 으로 가고 Esc 는 앱에 오지 않는다 — 막을 길이 없다.
    // 그때 닫는 길은 머리줄의 ×다. 시험은 "프레임에 포커스가 없을 때"를 전제로 한다.
    const onKey = (e: KeyboardEvent) => {
      // 겹창(Overlay)이 먼저 받아 막았으면 그쪽 일이다.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (expanded) setExpanded(false);
      else getController().closeArtifactPreview();
    };
    hostDoc.addEventListener('keydown', onKey);
    return () => hostDoc.removeEventListener('keydown', onKey);
  }, [attachment, expanded]);

  /*
    ⌘+/⌘−/⌘0 은 **새 창·⤢ 창 전체에서만** 미리보기 배율이다(designer 결정 표 #5). 옆 패널에서는 지금처럼 앱 배율이다 —
    채팅이 곁에 있는데 그 키를 가로채면 앱 배율 손잡이가 둘로 갈린다. 캡처 단계에서 받아 막는다: 메인 창은
    `Workspace` 가 `defaultPrevented` 를 보고 물러나고, 새 창은 메인으로 넘기는 가드(`AppWindowsHost`, window
    버블)까지 가지 않는다. 페이지 안을 눌러 포커스가 iframe 에 있으면 키가 오지 않는다 — 그때는 머리줄 단추다.
  */
  useEffect(() => {
    if (!attachment || !(expanded || windowed)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const dir = e.key === '=' || e.key === '+' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
      if (dir === 0 && e.key !== '0') return;
      e.preventDefault();
      e.stopPropagation();
      setZoom(dir === 0 ? PREVIEW_ZOOM_DEFAULT : stepPreviewZoom(zoom, dir, boxWidth));
    };
    hostDoc.addEventListener('keydown', onKey, true);
    return () => hostDoc.removeEventListener('keydown', onKey, true);
  }, [attachment, expanded, windowed, zoom, boxWidth, setZoom]);

  if (!attachment) return null;
  const ref = attachment.artifact;
  const title = phase.kind === 'ready' ? phase.title : ref?.title ?? attachment.filename;
  const scale = effectiveScale(zoom, boxWidth);
  const pct = Math.round(scale * 100);
  const zoomReady = phase.kind === 'ready';
  // 단축키 표기는 그 키가 미리보기 배율일 때만 — 옆 패널에서는 ⌘키가 앱 배율 몫이다(designer 시안 v1 메뉴 절).
  const keys = expanded || !!windowed;
  const zoomItems: MenuItem[] = [
    { label: t('artifact.zoom.reset'), onSelect: () => setZoom(PREVIEW_ZOOM_DEFAULT), shortcut: keys ? '⌘0' : undefined },
    { label: t('artifact.zoom.in'), onSelect: () => setZoom(stepPreviewZoom(zoom, 1, boxWidth)), disabled: !canZoomIn(zoom, boxWidth), shortcut: keys ? '⌘+' : undefined },
    { label: t('artifact.zoom.out'), onSelect: () => setZoom(stepPreviewZoom(zoom, -1, boxWidth)), disabled: !canZoomOut(zoom, boxWidth), shortcut: keys ? '⌘−' : undefined },
    ...PREVIEW_FIT_WIDTHS.map((w, i): MenuItem => {
      const on = zoom.kind === 'fit' && zoom.width === w;
      const label = t(FIT_LABEL[w]);
      return { label: on ? `✓ ${label}` : label, onSelect: () => setZoom({ kind: 'fit', width: w }), checkable: !on, separatorBefore: i === 0 };
    }),
  ];
  // 꼬리 줄에 지금 상태를 말로 — 축소하면 배치가 바뀌는 이유를 사람이 알게 한다. 기본(100%)이면 아무 말도 없다.
  const zoomNote = !zoomReady || isDefaultZoom(zoom) ? null
    : zoom.kind === 'fit' ? t('artifact.zoom.fitted', { width: zoom.width })
    : boxWidth > 0 ? t('artifact.zoom.viewWidth', { width: viewportWidth(zoom, boxWidth) }) : null;
  const zoomBtn = 'inline-flex h-full min-w-6 items-center justify-center px-1 text-fg-muted hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40';
  /*
    iframe 은 줄인 만큼 넓고 높게 그린 뒤 `transform` 으로 줄인다(`lib/previewZoom.ts` 머리). 배율 모드는 % 라 상자를
    재지 않아도 맞고, 맞춤 모드는 목표 폭을 px 로 주고 상자보다 좁으면(100% 로 멈춘 경우) 가운데 세운다.
    기본(100%)은 지금과 똑같은 그림이다 — 속성을 하나도 더 달지 않는다.
  */
  const frameStyle = isDefaultZoom(zoom) ? undefined : {
    position: 'absolute' as const,
    top: 0,
    left: zoom.kind === 'fit' && boxWidth > zoom.width ? Math.round((boxWidth - zoom.width) / 2) : 0,
    width: zoom.kind === 'fit' ? `${zoom.width}px` : `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: '0 0',
  };

  return (
    <section
      ref={sectionRef}
      aria-label={t('artifact.panel.label')}
      data-testid="artifact-panel"
      data-expanded={expanded ? 'true' : 'false'}
      data-windowed={windowed ? 'true' : undefined}
      className={windowed
        ? 'relative flex min-h-0 flex-1 flex-col bg-surface'
        : expanded
        ? 'fixed inset-0 z-40 flex flex-col bg-surface'
        : fill
          ? 'relative flex flex-1 flex-col border-l border-border bg-surface'
          : 'relative flex flex-col border-l border-border bg-surface'}
      /*
        폭은 사람이 끄는 값이다(스레드·터미널과 같은 손잡이). 왼쪽에 남길 자리는 곁의 칸이 무엇이냐로 갈린다 —
        채널이면 대화의 하한, 스레드(fill)면 스레드의 하한. fill 일 때는 남는 폭을 채우되 끈 폭보다 좁아지지
        않는다(`minWidth`) — 그래야 끌어 넓힌 만큼 스레드가 줄어든다. 창이 좁아지면 `paneMaxWidth` 가 이긴다.
      */
      style={expanded || windowed ? undefined : fill
        ? { minWidth: `min(${width ?? MIN_PREVIEW_WIDTH}px, ${paneMaxWidth(MIN_PREVIEW_WIDTH, MIN_THREAD_WIDTH)})` }
        : {
          width: width ?? PREVIEW_DEFAULT_CSS,
          minWidth: MIN_PREVIEW_WIDTH,
          maxWidth: paneMaxWidth(MIN_PREVIEW_WIDTH, MIN_CHANNEL_WIDTH),
        }}
    >
      {!expanded && !windowed && (
        <PaneResizer
          label={t('artifact.panel.resize')}
          width={dragWidth}
          min={MIN_PREVIEW_WIDTH}
          max={MAX_PREVIEW_WIDTH}
          minRoomLeft={fill ? MIN_THREAD_WIDTH : MIN_CHANNEL_WIDTH}
          onWidth={setWidth}
          onReset={() => setWidth(null)}
        />
      )}
      {/*
        창 전체로 펼치면 이 머리줄이 창의 좌상단이다 — macOS 는 신호등이 콘텐츠 위에 뜨므로(titleBarStyle Overlay)
        그 폭을 비우고, 창을 끌 자리가 되도록 drag region 을 단다(designer 수정 2). 버튼은 drag 를 받지 않는다.
      */}
      <header
        className={`flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 ${expanded && isMacOS() ? 'min-h-[40px]' : 'pl-3'}`}
        // 펼치면 창 왼쪽 끝이 곧 이 머리줄이다 — 신호등 폭(78pt)을 배율로 나눠 비운다(`macTrafficLightInset`).
        style={expanded ? { ...macTrafficLightInset(0, '0px'), ...macTopBarMinHeight() } : undefined}
        {...(expanded ? { 'data-tauri-drag-region': true } : {})}
        data-testid="artifact-panel-header"
      >
        <span className="min-w-0 truncate font-medium" data-testid="artifact-panel-title">{title}</span>
        {ref && <span className="shrink-0 text-meta text-fg-subtle">{t('artifact.card.version', { version: ref.version })}</span>}
        <span className="ml-auto" />
        {/* 배율 [− % +] — % 를 누르면 100%·폭에 맞춤 메뉴(designer 시안 v1 C안). 페이지가 없을 때(불러오는 중·오류·이동
            막힘)는 흐리게 둔다. */}
        <div
          role="group"
          aria-label={t('artifact.zoom.label')}
          className="flex h-7 shrink-0 items-stretch overflow-visible rounded-row border border-border text-meta"
          data-testid="artifact-zoom"
          data-scale={pct}
        >
          <button
            type="button"
            className={`${zoomBtn} rounded-l-row`}
            onClick={() => setZoom(stepPreviewZoom(zoom, -1, boxWidth))}
            disabled={!zoomReady || !canZoomOut(zoom, boxWidth)}
            aria-label={t('artifact.zoom.out')}
            data-testid="artifact-zoom-out"
          >−</button>
          <div className="relative flex">
            <Menu
              placement="bottom"
              className="right-0"
              items={zoomItems}
              renderTrigger={(props) => (
                <button
                  type="button"
                  {...props}
                  disabled={!zoomReady}
                  className="inline-flex min-w-[52px] items-center justify-center gap-0.5 border-x border-border px-1 tabular-nums text-fg hover:bg-surface-sunken disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label={t('artifact.zoom.menu', { pct })}
                  data-testid="artifact-zoom-menu"
                >{pct}%<span aria-hidden="true" className="text-fg-subtle">▾</span></button>
              )}
            />
          </div>
          <button
            type="button"
            className={`${zoomBtn} rounded-r-row`}
            onClick={() => setZoom(stepPreviewZoom(zoom, 1, boxWidth))}
            disabled={!zoomReady || !canZoomIn(zoom, boxWidth)}
            aria-label={t('artifact.zoom.in')}
            data-testid="artifact-zoom-in"
          >+</button>
        </div>
        {!windowed && (
          <button
            type="button"
            className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-row text-body text-fg-muted hover:bg-surface-sunken"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t('artifact.panel.collapse') : t('artifact.panel.expand')}
            data-testid="artifact-panel-expand"
          >{expanded ? '⤡' : '⤢'}</button>
        )}
        {/* ⧉ 새 창으로 떼어 낸다 — 스레드 패널 머리의 ⧉ 와 같은 글리프·자리(× 왼쪽). **옮긴다**(W1): 창이 열리면
            이 패널은 닫는다. 창은 **이 판**에 머문다(`AppWindowTarget` 의 artifact 주석).
            닫기는 **다음 프레임**이다(소유자 신고 2026-10-22·23): 패널을 닫으면 곁의 스레드가 넓어져 글 높이가 줄고
            scrollTop 이 새 최대값으로 잘린다. 같은 작업 안에서 `window.open` 이 새 웹뷰를 만들면 WKWebView 의 화면 쪽
            스크롤 위치가 그 잘림을 받지 못하고 옛 값에 남는다 — 글이 위로 밀리고 아래가 비거나(차이가 작을 때),
            목록이 통째로 빈다(클 때). 스크롤하면 다시 맞는다. WKWebView 탐침에서 같은 작업이면 3/3 어긋났고 한 프레임
            미루면 3/3 맞았다(웹 3610 · 화면 3821 → 3610). */}
        {!windowed && channelId && (
          <button
            type="button"
            className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-row text-body text-fg-muted hover:bg-surface-sunken"
            onClick={() => {
              const r = openWindow({ kind: 'artifact', channelId, attachmentId: attachment.id }, { attachment });
              if (r.kind === 'opened' || r.kind === 'focused') requestAnimationFrame(() => getController().closeArtifactPreview());
            }}
            title={t('window.openArtifact')}
            aria-label={t('window.openArtifact')}
            data-testid="artifact-pop-out"
          >⧉</button>
        )}
        {windowed ? (
          <div className="flex shrink-0 items-center gap-1 text-meta" data-testid="artifact-window-actions">{windowed.actions}</div>
        ) : (
          <button
            type="button"
            className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-row text-name leading-none text-fg-muted hover:bg-surface-sunken"
            onClick={() => getController().closeArtifactPreview()}
            aria-label={t('artifact.panel.close')}
            data-testid="artifact-panel-close"
          >×</button>
        )}
      </header>
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-sunken">
        {phase.kind === 'ready' ? (
          <iframe
            key={phase.url}
            src={phase.url}
            title={title}
            data-testid="artifact-frame"
            // 서버 CSP sandbox 와 교집합 — 새 창(allow-popups)도 여기서 막힌다. 아래 주석 머리 참고.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className={frameStyle ? 'border-0 bg-white' : 'h-full w-full border-0 bg-white'}
            style={frameStyle}
            onLoad={() => {
              loads.current += 1;
              // 첫 load 는 우리가 띄운 문서다. 그 뒤의 load 는 페이지가 스스로 다른 곳으로 간 것이다.
              if (loads.current > 1) setPhase({ kind: 'navigated' });
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-body text-fg-muted" data-testid="artifact-panel-state" data-state={phase.kind === 'error' ? phase.reason : phase.kind}>
            {phase.kind === 'loading' && <span>{t('artifact.panel.loading')}</span>}
            {phase.kind === 'navigated' && <span>{t('artifact.panel.navigated')}</span>}
            {phase.kind === 'error' && (
              <span>{phase.reason === 'tooLarge'
                ? t('artifact.panel.tooLarge', { size: formatSize(attachment.sizeBytes) })
                : t(`artifact.panel.${phase.reason}`)}</span>
            )}
            {phase.kind === 'error' && phase.reason === 'tooLarge' && (
              // 한도 초과에서 할 수 있는 일은 이것 하나다 — 아래 줄 구석에만 두지 않는다(designer f).
              <button
                type="button"
                className="rounded-row border border-border px-2 py-0.5 text-meta hover:bg-surface"
                onClick={() => void getController().saveAttachment(attachment)}
                disabled={save.busy}
                aria-busy={save.busy ? true : undefined}
                data-testid="artifact-panel-download-body"
              >{save.label}</button>
            )}
            {(phase.kind === 'navigated' || (phase.kind === 'error' && phase.reason === 'failed')) && (
              <button
                type="button"
                className="rounded-row border border-border px-2 py-0.5 text-meta hover:bg-surface"
                onClick={() => load(attachment)}
                data-testid="artifact-panel-reload"
              >{t('artifact.panel.reload')}</button>
            )}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-meta text-fg-subtle">
        {/* 왼쪽에는 출처를 밝히는 말만 둔다 — 버튼이 붙으면 한 문장처럼 읽힌다(designer d). */}
        <span>{t('artifact.panel.madeBy')}</span>
        {zoomNote && <span className="ml-auto truncate font-medium text-accent" data-testid="artifact-zoom-note">{zoomNote}</span>}
        {phase.kind === 'ready' && (
          <button
            type="button"
            className={`${zoomNote ? '' : 'ml-auto '}rounded-sm px-1 hover:bg-surface-sunken`}
            onClick={() => load(attachment)}
            data-testid="artifact-panel-reload"
          >{t('artifact.panel.reload')}</button>
        )}
        <button
          type="button"
          className={`${phase.kind === 'ready' ? '' : 'ml-auto '}rounded-sm px-1 hover:bg-surface-sunken`}
          onClick={() => void getController().saveAttachment(attachment)}
          disabled={save.busy}
          aria-busy={save.busy ? true : undefined}
          data-testid="artifact-panel-download"
        >{save.label}</button>
      </footer>
    </section>
  );
}

/**
 * 같은 미리보기의 **알려진 가장 높은 버전**. 서버의 `latestVersion` 은 목록을 읽은 순간 값이라(#1050) 새 버전
 * 글이 실시간으로 와도 옛 글의 값은 그대로다 — 그래서 지금 메모리에 있는 모든 글의 첨부를 함께 본다.
 */
export function useLatestKnownVersion(artifactId: string, fromServer: number): number {
  return useActiveStore((s) => {
    let best = fromServer;
    for (const list of Object.values(s.messages)) {
      for (const m of list ?? []) {
        for (const a of m.attachments ?? []) {
          if (a.artifact?.artifactId === artifactId && a.artifact.version > best) best = a.artifact.version;
        }
      }
    }
    return best;
  });
}
