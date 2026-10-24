import { useEffect, useRef } from 'react';
import { usePrefsStore } from '../state/prefsStore';
import { appWindowLabel, useAppWindows } from './appWindows';
import { createZoomer } from './zoom';

/**
 * 저장된 배율을 웹뷰에 건다 — `useColorMode` 와 같은 자리(`App`)에서 한 번 걸고, 값이
 * 바뀔 때마다 다시 건다.
 *
 * **부팅 때 거는 것이 이 훅의 핵심이다.** 웹뷰 배율은 네이티브에 저장되지 않는다 — 앱을
 * 껐다 켜면 1.0 으로 돌아간다. 설정 화면에서 고른 값만 `localStorage` 에 남고 화면은
 * 원래대로인 상태가 되면, 사람은 설정이 저장되지 않았다고 읽는다.
 *
 * 배율을 바꾸면 뷰포트의 CSS px 크기가 달라지므로(창의 물리 크기는 그대로다) 크기를
 * 스스로 다시 재는 자리 — `terminalSink` 의 `ResizeObserver`, `PaneResizer` 의
 * `getBoundingClientRect` — 는 따로 알리지 않아도 뒤따라온다.
 *
 * **열린 새 창에도 같은 배율을 건다** — 창이 열릴 때 지금 배율로, 배율이 바뀌면 모든 창이 같이. 새 창은
 * 자기 JS 가 없어 스스로 걸 수 없다(`createZoomer` 머리 주석).
 */
export function useZoom() {
  const zoom = usePrefsStore((s) => s.zoom);
  // 적용기는 한 번만 만든다 — "같은 값을 두 번 걸지 않는다" 는 기억이 그 안에 있어서,
  // 매 렌더마다 새로 만들면 그 기억이 사라져 IPC 가 렌더마다 나간다.
  const zoomer = useRef(createZoomer());
  // 키를 한 줄로 이어 구독한다 — 배열을 그대로 고르면 장부가 바뀔 때마다(고정·폭) 새 배열이라 효과가 매번 돈다.
  const popupKeys = useAppWindows((s) => s.entries.map((e) => e.key).join('\n'));

  useEffect(() => {
    void zoomer.current.apply(zoom, popupKeys ? popupKeys.split('\n').map(appWindowLabel) : []);
  }, [zoom, popupKeys]);
}
