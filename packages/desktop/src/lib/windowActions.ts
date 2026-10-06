import { getActiveStore } from '../state/communities';
import { usePrefsStore } from '../state/prefsStore';
import { detectLocale, isLocale, translator } from '../i18n';
import { MAX_APP_WINDOWS, openAppWindow, type AppWindowTarget, type OpenResult } from './appWindows';

/**
 * 새 창을 여는 **손짓들이 모이는 곳**(패널 ⧉ · 메시지 ⋯ · ⌘-클릭 · ⌘⇧O · 사이드바).
 * 문이 여럿이어도 결과(이미 띄운 것은 앞으로, 9번째는 안내)는 하나여야 해서 한 함수로 모은다.
 *
 * 9번째는 **조용히 닫지 않는다**(C6) — 사람이 누른 것이 아무 일도 안 일으키면 클릭이 먹지 않은
 * 것으로 읽는다. 앱 전체 통지 줄(`notice`)로 이유를 말한다.
 */
export function openWindow(target: AppWindowTarget): OpenResult {
  const result = openAppWindow(target);
  if (result.kind === 'limit' || result.kind === 'blocked') {
    const pref = usePrefsStore.getState().locale;
    const t = translator(isLocale(pref) ? pref : detectLocale());
    getActiveStore().getState().set({
      notice: result.kind === 'limit' ? t('window.limit', { count: MAX_APP_WINDOWS }) : t('window.blocked'),
    });
  }
  return result;
}

/** ⌘-클릭(macOS)·Ctrl-클릭(그 밖)이면 새 창으로 열라는 뜻이다. */
export function wantsNewWindow(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

/**
 * 「스레드 열기」 손짓 하나 — 그냥 누르면 **이 창의** 자리(메인 패널·채널 창 패널), ⌘-클릭이면 새 스레드 창
 * (판 3: 답글 N·툴바·삭제된 머리 자리표시자 모두 같은 규칙). 스레드 창 안에서는 ⌘-클릭도 그냥 누른 것과 같다.
 */
export function openThreadFrom(
  e: { metaKey: boolean; ctrlKey: boolean },
  view: { kind: string; openThread(rootId: string, opts?: { focusMessageId?: string }): void },
  channelId: string,
  rootId: string,
  opts?: { focusMessageId?: string },
): void {
  if (view.kind !== 'thread' && wantsNewWindow(e)) {
    openWindow({ kind: 'thread', channelId, rootId });
    return;
  }
  if (opts) view.openThread(rootId, opts);
  else view.openThread(rootId);
}
