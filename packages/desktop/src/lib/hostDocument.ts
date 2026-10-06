import { createContext, useContext } from 'react';

/**
 * 이 화면이 **그려지고 있는 문서**(채널·스레드 새 창).
 *
 * 새 창은 메인의 React 트리가 포털로 그린다(`AppWindowsHost`). 그래서 새 창 안의 메뉴·작성창·겹창이
 * `document.addEventListener` 로 바깥 클릭·Esc·Tab 을 들으면 **메인 창의 문서**를 듣는다 — 새 창에서
 * 일어난 클릭은 거기 오지 않아 메뉴가 안 닫히고, 반대로 메인을 누르면 새 창의 메뉴가 닫힌다.
 * 문서 단위 리스너를 다는 화면은 `document` 대신 이것을 쓴다. 공급자가 없으면 메인 문서다.
 */
export const HostDocumentContext = createContext<Document | null>(null);

export function useHostDocument(): Document {
  return useContext(HostDocumentContext) ?? document;
}

/**
 * 그 문서가 그려지는 **창**. 떠 있는 것(메뉴·카드·말풍선)을 창 안으로 자를 때 `window.innerWidth/Height` 대신
 * 이것을 쓴다 — 전역 `window` 는 늘 메인 창이라, 작은 새 창에서 메인 크기로 자르면 창 밖으로 나간다
 * (2026-10-06 F1). 창이 없는 문서(시험의 `createHTMLDocument`)면 메인 창이다.
 */
export function viewOf(doc: Document): Window {
  return doc.defaultView ?? window;
}

/** 이 화면이 그려지는 창(`viewOf(useHostDocument())`). */
export function useHostView(): Window {
  return viewOf(useHostDocument());
}
