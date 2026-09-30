import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type Ref } from 'react';
import { useStore } from 'zustand';
import { communityLabel, useCommunityRegistry, type CommunityEntry } from '../state/communities';
import { switchCommunity } from '../state/controller';
import { blockingUnreadCount } from '../state/unread';
import { useT } from '../i18n/useT';

/**
 * 레일 맨 위의 커뮤니티 타일 + 전환 팝오버(2026-09-30, 레일 통합 안 A).
 *
 * ## 왜 레일이 하나가 됐나
 *
 * 전에는 커뮤니티가 둘 이상이면 `CommunityRail`(56px)이 `Rail`(70px) 왼쪽에 하나 더 섰다.
 * 두 기둥 모두 아래 대부분이 비어 있었고, 커뮤니티를 하나 더 붙이는 순간 본문이 56px
 * 좁아졌다. 이제 커뮤니티 수와 무관하게 레일은 하나이고, 전환은 이 타일의 팝오버가 한다.
 * 모양은 1개일 때나 여럿일 때나 같고 팝오버의 행 수만 다르다.
 *
 * ## 열림 — 호버는 미리보기, 클릭은 고정 (jaebin 결정)
 *
 * - 포인터를 올리면 **클릭했을 때와 똑같은 팝오버**가 미리 선다. 벗어나면 닫힌다.
 * - 누르면 고정된다. 바깥을 누르거나 Esc 로 닫는다. 고정된 채로 다시 누르면 닫힌다.
 * - 타일에서 팝오버로 포인터를 옮기는 사이에 닫히지 않게 `HOVER_CLOSE_MS` 만큼 기다린다.
 *   팝오버는 타일의 DOM 자식이라 그 안에 들어오면 다시 "안"이다.
 * - 호버 미리보기는 **포커스를 옮기지 않는다** — 지나가던 포인터가 입력 중인 컴포저의
 *   포커스를 빼앗으면 안 된다. 고정으로 열 때만 지금 커뮤니티 행에 포커스를 둔다.
 *
 * ## 배지
 *
 * 지금 커뮤니티의 수는 Home 칸 배지가 이미 센다. 다른 커뮤니티에 나를 기다리는 것이 있으면
 * 타일 오른쪽 위에 **점 하나**만 찍고, 커뮤니티별 수는 팝오버 행에서 본다 — 레일에 숫자
 * 둘이 서면 어느 쪽의 수인지 헷갈린다. 세는 규칙은 `blockingUnreadCount` 하나다(독 배지와 같다).
 */

/** 호버에서 열기까지. 레일을 스쳐 지나가는 포인터마다 팝오버가 번쩍이지 않게 한다
 *  (120ms 는 칸 위를 지나가는 손에도 열렸다 — designer 검토로 250ms). */
export const HOVER_OPEN_MS = 250;
/** 호버에서 닫기까지. 타일 → 팝오버 사이 틈을 건너는 동안 닫히지 않게 한다. */
export const HOVER_CLOSE_MS = 200;

/** 단축키로 번호를 주는 커뮤니티 수. ⌥⌘1~⌥⌘9. */
const SHORTCUT_MAX = 9;

type Mode = 'closed' | 'hover' | 'pinned';

const FOCUS_RING = 'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2';

export function CommunitySwitcher({ onManage }: {
  /** 「커뮤니티 추가」·「커뮤니티 관리…」가 가는 곳(설정 › 커뮤니티). */
  onManage: () => void;
}) {
  const t = useT();
  const entries = useCommunityRegistry((r) => r.entries);
  const activeId = useCommunityRegistry((r) => r.activeId);
  const active = entries.find((e) => e.id === activeId);
  const others = useMemo(() => entries.filter((e) => e.id !== activeId), [entries, activeId]);
  const [mode, setMode] = useState<Mode>('closed');
  /** 고정을 연 것이 포인터인가. 포인터면 행이 아니라 메뉴 자체에 포커스를 둬서 행에
   *  포커스 테두리가 서지 않게 한다(면만으로 지금 커뮤니티가 보인다). 키보드면 행에 둔다. */
  const [byPointer, setByPointer] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tileRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const close = useCallback((returnFocus = false) => {
    clearTimers();
    setMode('closed');
    if (returnFocus) tileRef.current?.focus();
  }, [clearTimers]);

  // 열려 있는 동안: Esc 는 어느 모드든 닫고, 바깥 누르기는 고정된 것을 닫는다(호버는
  // 포인터가 떠나면 어차피 닫힌다).
  useEffect(() => {
    if (mode === 'closed') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close(mode === 'pinned');
    };
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [mode, close]);

  // 고정으로 열리면 포커스를 안으로 — ↑↓ 로 바로 고를 수 있다. 키보드로 열었으면 지금
  // 커뮤니티 행에, 포인터로 열었으면 메뉴 자체에(행에 테두리를 세우지 않는다).
  useEffect(() => {
    if (mode !== 'pinned') return;
    if (byPointer) { menuRef.current?.focus(); return; }
    const current = wrapRef.current?.querySelector<HTMLElement>('[data-current="true"]')
      ?? wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    current?.focus();
  }, [mode, byPointer]);

  useCommunityShortcuts(entries, activeId);

  if (!active) return null;

  const onEnter = (): void => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (mode !== 'closed' || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setMode((m) => (m === 'closed' ? 'hover' : m));
    }, HOVER_OPEN_MS);
  };
  const onLeave = (): void => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (mode !== 'hover') return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setMode((m) => (m === 'hover' ? 'closed' : m));
    }, HOVER_CLOSE_MS);
  };
  const onTileClick = (e: ReactMouseEvent): void => {
    clearTimers();
    // `detail` 은 클릭 횟수다 — 키보드(Enter·Space)로 누른 버튼은 0 이다.
    setByPointer(e.detail > 0);
    setMode((m) => (m === 'pinned' ? 'closed' : 'pinned'));
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    if (items.length === 0) return;
    e.preventDefault();
    // 포인터로 열어 포커스가 메뉴 자체에 있으면 지금 커뮤니티 행에서 출발한다.
    const current = items.findIndex((el) => el.dataset.current === 'true');
    const found = items.indexOf(document.activeElement as HTMLElement);
    const at = found >= 0 ? found : current;
    const next = e.key === 'ArrowDown'
      ? items[(at + 1) % items.length]
      : items[(at - 1 + items.length) % items.length];
    next?.focus();
  };

  const numbered = entries.length > 1;

  return (
    /*
      **이 감싸개는 `relative` 가 아니다** — 팝오버의 기준이 레일 몸통(`Rail` 의 `relative`)이
      되어야 레일 **오른쪽 바깥**에 열 수 있다. 타일 바로 아래에 열면 Home·DM·Agents 칸을
      덮고, 호버로 열리니 Home 을 누르러 가던 손이 커뮤니티 행을 누르게 된다(designer 검토).
      팝오버는 여전히 이 감싸개의 DOM 자식이라 포인터가 그 안에 들어가면 "안"이다.
    */
    <div ref={wrapRef} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <CommunityTile
        ref={tileRef}
        entry={active}
        others={others}
        open={mode !== 'closed'}
        onClick={onTileClick}
      />
      {mode !== 'closed' && (
        <div
          role="menu"
          data-testid="community-switcher"
          data-mode={mode}
          aria-label={t('rail.community.label')}
          ref={menuRef}
          tabIndex={-1}
          /* 메뉴 자체는 포인터로 열었을 때 포커스를 받아 두는 자리일 뿐이라 링을 그리지 않는다.
             유틸리티(`outline-none`)는 레이어 밖의 전역 `:focus-visible`(index.css)에 지므로
             인라인으로 막는다. */
          style={{ outline: 'none' }}
          onKeyDown={onMenuKeyDown}
          /* 레일 몸통 기준: `left-full` 은 몸통의 padding box 오른쪽(= 레일 70px − 오른쪽 테두리
             1px)이라 7px 을 더해 레일 경계에서 6px 띄운다. `top-2` 는 몸통의 `pt-2` 와 같아
             팝오버 위쪽 끝이 타일 위쪽 끝에 맞는다. */
          className="absolute left-full top-2 z-50 ml-[7px] w-[288px] rounded-lg border border-border bg-surface-raised p-1.5 shadow-lg"
        >
          <div className="px-2 pb-1 pt-1.5 text-meta font-medium uppercase tracking-wide text-fg-subtle">
            {t('rail.community.title')}
          </div>
          {entries.map((entry, i) => (
            <CommunityRow
              key={entry.id}
              entry={entry}
              current={entry.id === activeId}
              shortcut={numbered && i < SHORTCUT_MAX ? `⌥⌘${i + 1}` : null}
              onSelect={() => {
                close();
                // 전환 자체는 동기로 끝난다(레지스트리). 이 프로미스는 보관본의 `active` 를
                // 옮기는 일이고, 그 실패는 `sessionStore.save` 가 자기 자리에서 말한다(#212).
                if (entry.id !== activeId) void switchCommunity(entry.id);
              }}
            />
          ))}
          <div className="mx-1.5 my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            data-testid="community-switcher-add"
            onClick={() => { close(); onManage(); }}
            className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-body text-fg hover:bg-surface-hover focus:bg-surface-hover ${FOCUS_RING}`}
          >
            <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-name">+</span>
            {t('rail.community.add')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="community-switcher-manage"
            onClick={() => { close(); onManage(); }}
            className={`flex w-full items-center rounded-md px-2 py-1.5 text-left text-meta text-fg-muted hover:bg-surface-hover focus:bg-surface-hover ${FOCUS_RING}`}
          >
            {t('rail.community.manage')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * ⌥⌘1~9 로 커뮤니티를 바꾼다. ⌘1~5 는 레일 칸이 이미 쓰고 있어(`RAIL_CELLS`) 그 약속을
 * 깨지 않는다. ⌥ 를 누르면 macOS 에서 `e.key` 가 `¡`·`™` 같은 글자로 바뀌므로 **`e.code`
 * 로 읽는다.** 입력 칸 예외를 두지 않는 이유: ⌥⌘숫자는 사람이 타이핑하는 글자가 아니다.
 */
function useCommunityShortcuts(entries: CommunityEntry[], activeId: string): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.altKey) return;
      const m = /^Digit([1-9])$/.exec(e.code);
      if (!m) return;
      const entry = entries[Number(m[1]) - 1];
      if (!entry) return;
      e.preventDefault();
      if (entry.id !== activeId) void switchCommunity(entry.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [entries, activeId]);
}

/**
 * 다른 커뮤니티들의 "나를 기다리는 것" 합. 커뮤니티마다 스토어가 따로라 엔트리 수만큼
 * 구독한다(`useDockBadge` 와 같은 방식).
 */
function useOthersBlocking(others: CommunityEntry[]): number {
  const sum = (): number => others.reduce((n, e) => n + blockingUnreadCount(e.store.getState().unread), 0);
  const [count, setCount] = useState(sum);
  useEffect(() => {
    const recompute = (): void => setCount(others.reduce((n, e) => n + blockingUnreadCount(e.store.getState().unread), 0));
    recompute();
    const offs = others.map((e) => e.store.subscribe(recompute));
    return () => { for (const off of offs) off(); };
  }, [others]);
  return count;
}

/** 이니셜은 **코드 포인트 단위**로 자른다 — `label[0]` 은 이모지를 반쪽만 잘라 깨진 글자를 그린다. */
function initialOf(label: string): string {
  return Array.from(label)[0]?.toUpperCase() ?? '?';
}

function hostOf(entry: CommunityEntry): string | null {
  if (!entry.baseUrl) return null;
  try { return new URL(entry.baseUrl).host || null; } catch { return null; }
}

/**
 * 레일 맨 위 타일(지금 커뮤니티). 연결 상태는 **자기 커뮤니티의 스토어에서 직접 읽는다** —
 * 전역 플래그 하나로 합치면 "셋 중 하나가 끊겼다"가 "끊겼다"로 뭉친다(#166).
 *
 * 상태·점을 색으로만 말하지 않고 접근 가능한 이름에 싣는다. 안 읽음 점은 오른쪽 위,
 * 끊김 점은 오른쪽 아래라 둘이 같이 떠도 겹치지 않는다.
 */
function CommunityTile({ ref, entry, others, open, onClick }: {
  ref: Ref<HTMLButtonElement>;
  entry: CommunityEntry;
  others: CommunityEntry[];
  open: boolean;
  onClick: (e: ReactMouseEvent) => void;
}) {
  const t = useT();
  const connected = useStore(entry.store, (s) => s.connected);
  const iconUrl = useStore(entry.store, (s) => s.workspaceIconUrl);
  const othersBlocking = useOthersBlocking(others);
  const label = communityLabel(entry);
  const base = t('rail.community.tile', {
    name: label,
    state: t(connected ? 'rail.community.connected' : 'rail.community.disconnected'),
  });
  return (
    <button
      ref={ref}
      type="button"
      data-testid="rail-community-mark"
      aria-label={othersBlocking > 0 ? t('rail.community.tileOthers', { tile: base, count: othersBlocking }) : base}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
      // `text-sm` 은 4단이 아니라 **h-9 원에 묶인 머리글자**다 — `initial` 하나가 이 버튼의
      // 내용 전부이고 크기가 원의 지름에서 따라 나온다(`Identity.tsx` 와 같은 근거).
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-fg-on-strong ${FOCUS_RING}
        ${open ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-rail' : ''}
        ${connected ? '' : 'border-2 border-danger'}`}
    >
      {/* 사진이 있으면 타일을 채운다. 이름은 aria-label 이 말하므로 alt 는 비운다. */}
      {iconUrl
        ? <img src={iconUrl} alt="" data-testid={`community-icon-${entry.id}`} className="h-full w-full rounded-xl object-cover" />
        : initialOf(label)}
      {othersBlocking > 0 && (
        <span
          aria-hidden="true"
          data-testid="rail-community-dot"
          className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface-rail bg-accent"
        />
      )}
      {!connected && (
        <span
          aria-hidden="true"
          data-testid="rail-community-offline"
          className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full border-2 border-surface-rail bg-danger"
        />
      )}
    </button>
  );
}

/**
 * 팝오버 행 하나 — 아이콘 · 이름 · 주소 · (다른 커뮤니티면) 나를 기다리는 것 수 · 단축키.
 * 지금 커뮤니티는 면으로 표시하고 수를 적지 않는다(Home 배지가 이미 센다). 끊겼으면 수
 * 자리에 "연결 끊김"을 글자로 적는다.
 */
function CommunityRow({ entry, current, shortcut, onSelect }: {
  entry: CommunityEntry;
  current: boolean;
  shortcut: string | null;
  onSelect: () => void;
}) {
  const t = useT();
  const connected = useStore(entry.store, (s) => s.connected);
  const iconUrl = useStore(entry.store, (s) => s.workspaceIconUrl);
  const blocking = useStore(entry.store, (s) => blockingUnreadCount(s.unread));
  const label = communityLabel(entry);
  const host = hostOf(entry);
  const state = t(connected ? 'rail.community.connected' : 'rail.community.disconnected');
  const name = !current && blocking > 0
    ? t('rail.cell.withCount', {
      name: t('rail.community.tile', { name: label, state }),
      count: t('rail.cell.blocking', { count: blocking }),
    })
    : t('rail.community.tile', { name: label, state });
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={`community-tile-${entry.id}`}
      data-current={current ? 'true' : undefined}
      aria-current={current ? 'true' : undefined}
      aria-label={name}
      aria-keyshortcuts={shortcut ? shortcut.replace('⌥⌘', 'Alt+Meta+') : undefined}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${FOCUS_RING}
        ${current ? 'bg-surface-hover' : 'hover:bg-surface-hover focus:bg-surface-hover'}`}
    >
      <span
        aria-hidden="true"
        className={`flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg text-meta font-bold
          ${current ? 'bg-accent text-fg-on-strong' : 'bg-surface-sunken text-fg-muted'}`}
      >
        {iconUrl
          ? <img src={iconUrl} alt="" data-testid={`community-row-icon-${entry.id}`} className="h-full w-full object-cover" />
          : initialOf(label)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-medium text-fg">{label}</span>
        {host && host !== label && <span className="block truncate text-meta text-fg-subtle">{host}</span>}
      </span>
      {!connected
        ? <span data-testid={`community-offline-${entry.id}`} className="shrink-0 whitespace-nowrap text-meta text-danger">{state}</span>
        : !current && blocking > 0 && (
          <span
            aria-hidden="true"
            data-testid={`community-count-${entry.id}`}
            className="shrink-0 rounded-full bg-accent px-1.5 text-meta font-bold text-fg-on-strong"
          >
            {blocking}
          </span>
        )}
      {shortcut && <span aria-hidden="true" className="shrink-0 whitespace-nowrap font-mono text-meta text-fg-subtle">{shortcut}</span>}
    </button>
  );
}
