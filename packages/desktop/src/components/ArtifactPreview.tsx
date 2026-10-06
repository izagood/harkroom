import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentRow } from '@harkroom/shared';
import { getController } from '../state/controller';
import { useActiveStore } from '../state/communities';
import { ApiError } from '../lib/api';
import { useT } from '../i18n/useT';
import { formatSize } from './Attachments';
import { isMacOS, macTopBarMinHeight, macTrafficLightInset } from '../lib/platform';
import { allowPreviewOnce } from '../lib/previewAllowance';
import { PaneResizer } from './PaneResizer';
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
export function ArtifactPanel({ fill = false }: {
  /** 곁의 내용 칸이 고정 폭(스레드)일 때 남는 폭을 미리보기가 채운다(`Workspace.tsx` 수정 1). */
  fill?: boolean;
} = {}) {
  const t = useT();
  const attachment = useActiveStore((s) => s.artifactPreview);
  const [expanded, setExpanded] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const loads = useRef(0);
  const attempt = useRef(0);
  const [width, setStoredWidth] = useState(() => paneStorage.loadPreviewWidth());
  const setWidth = useCallback((next: number | null) => {
    setStoredWidth(next);
    paneStorage.savePreviewWidth(next);
  }, []);

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
    선택 표시가 닫은 뒤에도 남던 것(jaebin 신고 2026-10-05). 가게의 `artifactPreview` 는 닫으면 비지만, 누른
    카드에 포커스가 남아 있으면 Esc(키 입력) 뒤로 WebKit 이 그것을 `:focus-visible` 로 보고 전역 외곽선(2px
    주황)을 그린다 — 선택 테두리와 똑같아 보인다. 닫히는 순간 연 방식대로 포커스를 정리한다(`opener`).
  */
  const wasOpen = useRef(false);
  useEffect(() => {
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
    if (!attachment) return;
    // 페이지 안을 한 번 누르면 키 입력은 교차 origin iframe 으로 가고 Esc 는 앱에 오지 않는다 — 막을 길이 없다.
    // 그때 닫는 길은 머리줄의 ×다. 시험은 "프레임에 포커스가 없을 때"를 전제로 한다.
    const onKey = (e: KeyboardEvent) => {
      // 겹창(Overlay)이 먼저 받아 막았으면 그쪽 일이다.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (expanded) setExpanded(false);
      else getController().closeArtifactPreview();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [attachment, expanded]);

  if (!attachment) return null;
  const ref = attachment.artifact;
  const title = phase.kind === 'ready' ? phase.title : ref?.title ?? attachment.filename;

  return (
    <section
      ref={sectionRef}
      aria-label={t('artifact.panel.label')}
      data-testid="artifact-panel"
      data-expanded={expanded ? 'true' : 'false'}
      className={expanded
        ? 'fixed inset-0 z-40 flex flex-col bg-surface'
        : fill
          ? 'relative flex flex-1 flex-col border-l border-border bg-surface'
          : 'relative flex flex-col border-l border-border bg-surface'}
      /*
        폭은 사람이 끄는 값이다(스레드·터미널과 같은 손잡이). 왼쪽에 남길 자리는 곁의 칸이 무엇이냐로 갈린다 —
        채널이면 대화의 하한, 스레드(fill)면 스레드의 하한. fill 일 때는 남는 폭을 채우되 끈 폭보다 좁아지지
        않는다(`minWidth`) — 그래야 끌어 넓힌 만큼 스레드가 줄어든다. 창이 좁아지면 `paneMaxWidth` 가 이긴다.
      */
      style={expanded ? undefined : fill
        ? { minWidth: `min(${width ?? MIN_PREVIEW_WIDTH}px, ${paneMaxWidth(MIN_PREVIEW_WIDTH, MIN_THREAD_WIDTH)})` }
        : {
          width: width ?? PREVIEW_DEFAULT_CSS,
          minWidth: MIN_PREVIEW_WIDTH,
          maxWidth: paneMaxWidth(MIN_PREVIEW_WIDTH, MIN_CHANNEL_WIDTH),
        }}
    >
      {!expanded && (
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
        <span className="truncate font-medium" data-testid="artifact-panel-title">{title}</span>
        {ref && <span className="shrink-0 text-meta text-fg-subtle">{t('artifact.card.version', { version: ref.version })}</span>}
        <span className="ml-auto" />
        <button
          type="button"
          className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-row text-body text-fg-muted hover:bg-surface-sunken"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? t('artifact.panel.collapse') : t('artifact.panel.expand')}
          data-testid="artifact-panel-expand"
        >{expanded ? '⤡' : '⤢'}</button>
        <button
          type="button"
          className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-row text-name leading-none text-fg-muted hover:bg-surface-sunken"
          onClick={() => getController().closeArtifactPreview()}
          aria-label={t('artifact.panel.close')}
          data-testid="artifact-panel-close"
        >×</button>
      </header>
      <div className="relative min-h-0 flex-1 bg-surface-sunken">
        {phase.kind === 'ready' ? (
          <iframe
            key={phase.url}
            src={phase.url}
            title={title}
            data-testid="artifact-frame"
            // 서버 CSP sandbox 와 교집합 — 새 창(allow-popups)도 여기서 막힌다. 아래 주석 머리 참고.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0 bg-white"
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
                data-testid="artifact-panel-download-body"
              >{t('artifact.panel.download')}</button>
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
        {phase.kind === 'ready' && (
          <button
            type="button"
            className="ml-auto rounded-sm px-1 hover:bg-surface-sunken"
            onClick={() => load(attachment)}
            data-testid="artifact-panel-reload"
          >{t('artifact.panel.reload')}</button>
        )}
        <button
          type="button"
          className={`${phase.kind === 'ready' ? '' : 'ml-auto '}rounded-sm px-1 hover:bg-surface-sunken`}
          onClick={() => void getController().saveAttachment(attachment)}
          data-testid="artifact-panel-download"
        >{t('artifact.panel.download')}</button>
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
