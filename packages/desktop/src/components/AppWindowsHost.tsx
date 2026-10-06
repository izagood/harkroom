import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActiveStore, useCommunityRegistry } from '../state/communities';
import { getController } from '../state/controller';
import { WindowViewProvider, type WindowView } from '../state/windowView';
import {
  closeAppWindow, markAppWindowGone, persistAppWindows, restoreAppWindows, setAppWindowPinned, setAppWindowScope, syncRootAttributes,
  useAppWindows, type AppWindowEntry,
} from '../lib/appWindows';
import { displayBody } from '../lib/mention';
import { ThreadPanel } from './ThreadPanel';
import { ChannelPane } from './ChannelPane';
import { ChannelSettingsSheet } from './ChannelSettingsSheet';
import { useT } from '../i18n/useT';
import { HostDocumentContext } from '../lib/hostDocument';
import { isFileDrag } from '../lib/fileDrag';

/**
 * 열린 새 창마다 **포털을 단다**(채널·스레드 새 창). 메인 창의 React 트리 안에 있으므로 스토어·
 * 컨트롤러·연결이 메인과 하나다 — 새 창은 그리기만 한다(`lib/appWindows.ts` 머리 주석).
 *
 * 마운트 자리는 `Workspace` 다: 로그인·접속이 끝난 뒤에만 그릴 것이 있다.
 */
export function AppWindowsHost() {
  const entries = useAppWindows((s) => s.entries);
  const communityId = useCommunityRegistry((s) => s.activeId);

  /**
   * 커뮤니티가 정해지면 그 커뮤니티의 지난 창을 복원한다(W2). 다른 커뮤니티로 옮기면 그 전 창들은
   * **닫는다** — 창은 활성 커뮤니티의 스토어를 그리므로, 남겨 두면 남의 서버 대화가 엉뚱하게 비친다.
   * 닫힌 창은 복원 목록에 남아 그 커뮤니티로 돌아올 때 다시 열린다.
   */
  useEffect(() => {
    // 범위를 **먼저** 옮긴다 — 아래에서 닫는 옛 창들의 늦은 저장이 옛 커뮤니티 목록을 지우지 않게.
    setAppWindowScope(communityId);
    for (const e of useAppWindows.getState().entries) {
      if (e.communityId !== communityId) { e.win.close(); }
    }
    restoreAppWindows(communityId);
  }, [communityId]);

  // 창을 옮기는 것에는 이벤트가 없다 — 열린 창이 있는 동안 위치를 가끔 적어 둔다(복원 자리).
  const any = entries.length > 0;
  useEffect(() => {
    if (!any) return;
    const id = setInterval(persistAppWindows, 10_000);
    return () => clearInterval(id);
  }, [any]);

  return <>{entries.map((e) => <AppWindowPortal key={e.key} entry={e} />)}</>;
}

function AppWindowPortal({ entry }: { entry: AppWindowEntry }) {
  const doc = entry.win.document;
  // 창 문서의 뿌리. 한 번 만들고 창이 사는 동안 둔다.
  const root = useMemo(() => {
    const el = doc.createElement('div');
    el.id = 'hk-window-root';
    el.className = 'flex h-screen w-screen overflow-hidden bg-surface text-fg';
    return el;
  }, [doc]);
  useLayoutEffect(() => {
    doc.body.style.margin = '0';
    doc.body.appendChild(root);
    return () => { root.remove(); };
  }, [doc, root]);

  // 테마(라이트·다크)·글자 척도는 `<html>` 의 클래스·data·style 에 걸려 있다. 메인이 바뀌면 따라간다.
  useEffect(() => {
    const sync = () => syncRootAttributes(doc);
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, [doc]);

  useWindowGuards(entry.win);

  return createPortal(
    <HostDocumentContext.Provider value={doc}>
    <div className="flex min-w-0 flex-1 flex-col">
      <WindowBar entry={entry} />
      {entry.target.kind === 'thread'
        ? <ThreadWindow entry={entry} channelId={entry.target.channelId} rootId={entry.target.rootId} />
        : <ChannelWindow entry={entry} channelId={entry.target.channelId} />}
    </div>
    </HostDocumentContext.Provider>,
    root,
  );
}

type LoadState = 'loading' | 'ok' | 'gone';

/** 스레드 창(420×680): 패널과 같은 화면·입력창이 창을 채운다(판 3). */
function ThreadWindow({ entry, channelId, rootId }: { entry: AppWindowEntry; channelId: string; rootId: string }) {
  const t = useT();
  const [state, setState] = useState<LoadState>('loading');
  useEffect(() => {
    let live = true;
    getController().loadThreadForWindow(channelId, rootId)
      .then((ok) => { if (live) setState(ok ? 'ok' : 'gone'); if (!ok) markAppWindowGone(entry.key); })
      .catch(() => { if (live) setState('gone'); });
    return () => { live = false; };
  }, [channelId, rootId]);

  useWindowTitle(entry, channelId, rootId);
  useReadWhenFocused(entry, channelId, rootId);

  const view = useMemo<WindowView>(() => ({
    kind: 'thread',
    channelId,
    threadRootId: rootId,
    // 스레드 창 안에서 다른 스레드로 가는 손짓(링크 등)은 메인 창이 받는다 — 이 창은 이 스레드 하나다.
    openThread: (other, opts) => { void getController().openThread(other, { channelId, ...opts }); },
    closeThread: () => closeAppWindow(entry.target),
  }), [channelId, rootId, entry.target]);

  if (state !== 'ok') {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-fg-subtle" data-testid="window-empty">
        {state === 'loading' ? t('window.loading') : t('window.threadGone')}
      </div>
    );
  }
  return (
    <WindowViewProvider value={view}>
      <ThreadPanel />
    </WindowViewProvider>
  );
}

/** 창 제목줄: 「#채널 · 루트 첫 줄」(판 3). DM 이면 상대 이름. 루트를 아직 모르면 채널만. */
function useWindowTitle(entry: AppWindowEntry, channelId: string, rootId?: string): void {
  const where = useActiveStore((s) => {
    const channel = s.channels.find((c) => c.id === channelId);
    if (channel) return `#${channel.name}`;
    const dm = s.dms.find((d) => d.id === channelId);
    if (dm) return dm.memberIds.filter((id) => id !== s.me?.id).map((id) => s.accounts[id]?.handle ?? '…').join(', ');
    return 'Harkroom';
  });
  const first = useActiveStore((s) => {
    if (!rootId) return '';
    const root = (s.messages[channelId] ?? []).find((m) => m.id === rootId);
    if (!root) return '';
    const line = displayBody(root, s.accounts, s.groups, s.teams ?? []).split('\n')[0]?.trim() ?? '';
    return line.length > 60 ? `${line.slice(0, 60)}…` : line;
  });
  useEffect(() => {
    entry.win.document.title = first ? `${where} · ${first}` : where;
  }, [entry, where, first]);
}

/**
 * 창이 **포커스이고 보일 때** 읽음을 올린다(판 3 4a·C5). 열 때 이미 포커스면 한 번, 그 뒤로는 포커스를
 * 얻을 때마다. 뒤에 깔린 창은 배지를 남긴다 — 사람이 보지 않은 것을 읽었다고 하지 않는다.
 */
function useReadWhenFocused(entry: AppWindowEntry, channelId: string, rootId?: string): void {
  // 보고 있는 동안 새로 온 것도 읽는다 — 이 창 몫의 미읽음 수가 바뀔 때마다 다시 잰다.
  const pending = useActiveStore((s) => s.unread.filter((e) => e.channelId === channelId && !e.readAt
    && (!rootId || e.threadRootId === rootId || e.messageId === rootId)).length);
  useEffect(() => {
    const w = entry.win;
    const mark = () => {
      if (w.document.visibilityState === 'visible' && w.document.hasFocus()) getController().markWindowRead(channelId, rootId);
    };
    mark();
    w.addEventListener('focus', mark);
    return () => w.removeEventListener('focus', mark);
  }, [entry, channelId, rootId, pending]);
}

/**
 * 창 머리의 얇은 줄 — 「메인 창으로 되돌리기」(판 3 C4). 누르면 이 창을 닫고 메인이 같은 자리를 연다
 * (채널 창이면 그 채널, 스레드 창이면 그 채널의 그 스레드). 📌 항상 위는 다음 단계에서 이 줄에 선다.
 */
function WindowBar({ entry }: { entry: AppWindowEntry }) {
  const t = useT();
  const back = () => {
    const target = entry.target;
    closeAppWindow(target);
    const c = getController();
    if (target.kind === 'thread') void c.openThread(target.rootId, { channelId: target.channelId });
    else void c.openChannel(target.channelId);
  };
  return (
    <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border bg-surface px-2 py-1 text-meta">
      {/* 📌 항상 위(W3): 기본 끔, 창마다 켠다. 켜진 것이 눈에 보여야 한다 — 눌린 모양과 aria-pressed. */}
      <button
        data-testid="window-pin"
        aria-pressed={entry.pinned}
        title={t(entry.pinned ? 'window.unpin' : 'window.pin')}
        aria-label={t(entry.pinned ? 'window.unpin' : 'window.pin')}
        className={`rounded-row px-2 py-0.5 hover:bg-surface-sunken ${entry.pinned ? 'bg-surface-sunken text-fg' : 'text-fg-subtle'}`}
        onClick={() => { void setAppWindowPinned(entry.key, !entry.pinned); }}
      >
        📌
      </button>
      <button
        data-testid="window-back-to-main"
        className="rounded-row px-2 py-0.5 text-fg-muted hover:bg-surface-sunken"
        onClick={back}
      >
        ↩ {t('window.backToMain')}
      </button>
    </div>
  );
}

/**
 * 채널 창(820×720): 메인의 채널 화면 그대로, 사이드바·레일 없이 **자기 스레드 패널**을 갖는다(W4).
 * 「새 메시지」 구분선은 창을 연 시점의 읽음 위치로 얼린다(C5) — 메인의 구분선을 움직이지 않는다.
 */
function ChannelWindow({ entry, channelId }: { entry: AppWindowEntry; channelId: string }) {
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const divider = useRef(useActiveStore.getState().reads[channelId]?.lastReadSeq ?? 0).current;
  useEffect(() => { void getController().loadChannelForWindow(channelId).catch(() => undefined); }, [channelId]);

  useWindowTitle(entry, channelId);
  useReadWhenFocused(entry, channelId);

  const view = useMemo<WindowView>(() => ({
    kind: 'channel',
    channelId,
    threadRootId,
    dividerSeq: divider,
    openThread: (rootId, opts) => {
      // 다른 채널의 스레드(링크·대기 줄)는 이 창의 패널이 그릴 수 없다 — 메인이 받는다.
      if (opts?.channelId && opts.channelId !== channelId) { void getController().openThread(rootId, opts); return; }
      setThreadRootId(rootId);
      void getController().loadThreadForWindow(channelId, rootId).then((ok) => { if (!ok) setThreadRootId(null); }).catch(() => undefined);
    },
    closeThread: () => setThreadRootId(null),
  }), [channelId, threadRootId, divider]);

  return (
    <WindowViewProvider value={view}>
      <div className="flex min-h-0 min-w-0 flex-1">
        <ChannelPane />
        {threadRootId && <ThreadPanel />}
      </div>
      {/* 이 창에서 연 채널 설정 시트는 이 창에 뜬다(판 3 C2). 메인은 이 채널의 시트를 그리지 않는다. */}
      <ChannelSettingsSheet onlyFor={channelId} />
    </WindowViewProvider>
  );
}

/**
 * 메인 창에 걸린 창 단위 장치를 새 창에도 건다.
 *
 * - **파일 끌어 놓기 가드**(`useFileDropGuard` 와 같은 규칙): 작성창 밖에 떨어진 파일이 창을 그 파일로
 *   갈아치우지 못하게 기본 동작만 걷는다. 작성창의 첨부 경로는 그대로 산다.
 * - **앱 단축키는 메인이 받는다**: ⌘K(찾기)·⌘F·⌘[·⌘]·⌘\\·⌘,·⌘=/-/0 은 `Workspace`·`useZoom` 이 메인 문서에서
 *   듣는다. 새 창에서 누르면 메인을 앞으로 가져와 같은 키를 메인 문서로 넘긴다 — 결과(찾기 팔레트 등)가
 *   메인에 뜬다. 복사·붙여넣기·실행 취소처럼 글을 다루는 키는 넘기지 않는다.
 */
const FORWARDED_KEYS = new Set(['k', 'f', '[', ']', '\\', ',', '=', '-', '0']);
function useWindowGuards(win: Window): void {
  useEffect(() => {
    const over = (e: DragEvent) => { if (isFileDrag(e.dataTransfer)) e.preventDefault(); };
    const drop = (e: DragEvent) => { if (isFileDrag(e.dataTransfer)) e.preventDefault(); };
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !FORWARDED_KEYS.has(e.key.toLowerCase())) return;
      e.preventDefault();
      window.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true,
      }));
    };
    win.addEventListener('dragover', over);
    win.addEventListener('drop', drop);
    win.addEventListener('keydown', key);
    return () => {
      win.removeEventListener('dragover', over);
      win.removeEventListener('drop', drop);
      win.removeEventListener('keydown', key);
    };
  }, [win]);
}
