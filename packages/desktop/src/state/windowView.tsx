import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useActiveStore } from './communities';
import { getController, type OpenThreadOpts } from './controller';

/**
 * **이 창이 보고 있는 것**(채널·스레드 새 창, 완료 조건 ②).
 *
 * 스토어의 `activeChannelId`·`threadRootId` 는 **메인 창의** 자리다. 새 창은 스토어를 메인과
 * 같이 쓰지만(`lib/appWindows.ts` — 연결·알림이 하나여야 한다) 보는 자리는 따로 가진다:
 * 스레드 창은 그 스레드 하나, 채널 창은 그 채널과 **자기 스레드 패널**(W4)이다.
 *
 * 그래서 채널·스레드를 그리는 화면(`ChannelPane`·`ThreadPanel`·`TypingLine`·`MessageItem` 의
 * 「스레드 열기」)은 스토어가 아니라 이 컨텍스트를 읽는다. 공급자가 없으면 메인 창이다 —
 * 지금까지와 한 글자도 다르지 않게 스토어를 읽고 컨트롤러를 부른다.
 */
export type WindowKind = 'main' | 'thread' | 'channel';

export interface WindowView {
  kind: WindowKind;
  channelId: string | null;
  threadRootId: string | null;
  /**
   * 「새 메시지」 구분선(C5: 창마다 연 시점에 고정). 메인은 스토어의 `dividerSeq` 를 쓰므로 비워 둔다.
   * 새 창은 열 때의 읽음 위치를 얼려 여기에 싣는다.
   */
  dividerSeq?: number;
  /**
   * 스레드 패널 폭을 **이 창이** 쥘 때(채널 창, designer #1174). 없으면 메인처럼 `paneStorage` 를 쓴다.
   * `reserveLeft` 는 채널 열에 남길 최소 폭이다.
   */
  pane?: { width: number; min: number; reserveLeft: number; onWidth(next: number): void };
  /** 이 창에서 스레드를 연다. 채널 창이면 자기 패널(W4), 메인이면 지금까지대로. */
  openThread(rootId: string, opts?: OpenThreadOpts): void;
  /** 이 창의 스레드를 닫는다. 스레드 창이면 창을 닫는다. */
  closeThread(): void;
}

const WindowViewContext = createContext<WindowView | null>(null);

export function WindowViewProvider({ value, children }: { value: WindowView; children: ReactNode }) {
  return <WindowViewContext.Provider value={value}>{children}</WindowViewContext.Provider>;
}

/** 메인 창의 자리 — 스토어 그대로다. 공급자가 없을 때 쓴다. */
const MAIN_ACTIONS = {
  // 인자를 그대로 넘긴다 — `opts` 가 없을 때 `undefined` 를 덧붙이지 않는다(호출 모양이 예전과 같다).
  openThread: (...args: [rootId: string, opts?: OpenThreadOpts]) => { void getController().openThread(...args); },
  closeThread: () => { getController().closeThread(); },
};

export function useWindowView(): WindowView {
  const provided = useContext(WindowViewContext);
  // 훅 순서를 지키려고 공급자가 있어도 구독한다. 값은 둘 다 원시값이라 다시 그리는 일이 늘지 않는다.
  const channelId = useActiveStore((s) => s.activeChannelId);
  const threadRootId = useActiveStore((s) => s.threadRootId);
  const main = useMemo<WindowView>(
    () => ({ kind: 'main', channelId, threadRootId, ...MAIN_ACTIONS }),
    [channelId, threadRootId],
  );
  return provided ?? main;
}

/** 메인 창인가 — 메인에만 있는 것(이력·뒤로 가기·사이드바)을 가를 때. */
export function useIsMainWindow(): boolean {
  return useContext(WindowViewContext) === null;
}
