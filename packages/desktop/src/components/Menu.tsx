import { useState, useRef, useEffect, useCallback, useLayoutEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/**
 * 트리거에 붙일 속성. 소비자가 자기 요소에 그대로 펼친다.
 *
 * **왜 프리미티브가 트리거를 직접 렌더하지 않는가**: 트리거 방식이 소비자마다 다르다.
 * 계정 메뉴(#113)는 클릭이고, 채널 컨텍스트 메뉴(#111)는 우클릭이다. 프리미티브가
 * `<button onClick>` 을 강제하면 #111 은 이것을 못 쓰고 메뉴를 다시 만들게 된다 —
 * 그 중복을 피하는 것이 이 프리미티브를 만든 이유다(#113 이슈가 그렇게 적었다).
 * 그래서 트리거 **요소**는 소비자가 만들고, 접근성 속성과 ref 는 여기서 준다.
 */
export interface MenuTriggerProps {
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  /**
   * 우클릭으로 커서 위치에 연다(#111). `openOnContextMenu` 를 준 소비자에게만 넘어온다 —
   * 안 준 소비자에게는 `undefined` 라 우클릭 동작이 붙지 않는다.
   */
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

interface MenuPosition {
  x: number;
  y: number;
}

interface MenuProps {
  /** 트리거 요소를 만든다. 받은 props 를 그 요소에 그대로 펼쳐라. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
  items: MenuItem[];
  /**
   * 메뉴가 트리거의 위로 열릴지 아래로 열릴지. 기본은 위('top') 다 — 첫 소비자가
   * 사이드바 **푸터**라 아래로 열면 화면 밖으로 나간다. 커서 위치에 여는 것(#111)은
   * 이 열거형으로 표현되지 않는다 — 그 요구가 실제로 생길 때 좌표 기반 배치를 더한다
   * (지금 추측으로 만들면 틀린 추상이 된다).
   *
   * `openOnContextMenu` 로 열린 경우에는 이 값이 무시되고 커서 좌표가 쓰인다.
   */
  placement?: 'top' | 'bottom';
  /**
   * 우클릭 진입점을 켠다(#111). 좌표는 소비자가 주지 않는다 — `contextmenu` 이벤트의
   * `clientX`/`clientY` 를 쓴다. 초판은 `position?: MenuPosition` 이었는데 소비자가
   * `{x: 0, y: 0}` 같은 **무시되는 더미**를 넘겨야 했다. 값이 쓰이지 않는 데이터는
   * 플래그로 적어야 읽는 사람이 속지 않는다.
   */
  openOnContextMenu?: boolean;
  className?: string;
}

export function Menu({ renderTrigger, items, placement = 'top', openOnContextMenu = false, className = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [openAt, setOpenAt] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
    setOpenAt(null);
    triggerRef.current?.focus();
  }, []);

  const enabledIndexes = items.flatMap((item, i) => (item.disabled ? [] : [i]));

  // 열리면 첫 활성 항목으로 포커스를 옮긴다 — 키보드로 연 사람이 곧바로 ↑/↓ 를 쓸 수 있어야
  // 하고, Escape·화살표 처리가 메뉴 안의 포커스에 달려 있다.
  useLayoutEffect(() => {
    if (!open) return;
    itemRefs.current[enabledIndexes[0] ?? 0]?.focus();
    // enabledIndexes 는 매 렌더 새 배열이라 의존성에 넣으면 매 렌더 재실행된다 — 열림 전이만 본다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 바깥 클릭으로 닫는다. document 리스너라 **네이티브** MouseEvent 다 — React 의 합성
  // 이벤트 타입을 쓰면 캐스트로 타입을 속이게 된다(초판이 그랬다).
  // 우클릭으로 여는 경우에도 이 리스너가 그 이벤트를 잡지 않는다 — 순서가 보장한다:
  // `mousedown`(button=2) 이 먼저 오고 `contextmenu` 가 뒤에 오는데, 메뉴는 후자에서
  // 열린다. 즉 여는 시점에는 이 리스너가 아직 붙어 있지 않다.
  //
  // 초판은 `e.button !== 0` 로 우클릭을 통째로 무시했는데, 그러면 메뉴가 열린 상태에서
  // **다른 곳을 우클릭해도 닫히지 않는다.** jsdom 은 `contextMenu` 만 발사해서 그
  // 차이가 테스트에 드러나지 않는다.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, close]);

  /** 메뉴 안에서의 키보드 이동. 항목 버튼에 직접 걸어 리스너 재부착을 피한다. */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLElement>, index: number): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (!enabledIndexes.length) return;
    const at = enabledIndexes.indexOf(index);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = enabledIndexes[(((at === -1 ? 0 : at) + step) + enabledIndexes.length) % enabledIndexes.length]!;
    itemRefs.current[next]?.focus();
  };

  const triggerProps: MenuTriggerProps = {
    ref: (el) => { triggerRef.current = el; },
    onClick: () => setOpen((v) => !v),
    onContextMenu: openOnContextMenu
      ? (e: ReactMouseEvent<HTMLElement>) => {
          // 브라우저 기본 메뉴를 막는다.
          e.preventDefault();
          setOpen(true);
          setOpenAt({ x: e.clientX, y: e.clientY });
        }
      : undefined,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
  };

  /**
   * 좌표로 열렸을 때만 인라인 스타일을 쓴다. **좌표가 없으면 예전 Tailwind 클래스를
   * 그대로 둔다** — 초판은 두 경로를 모두 인라인 스타일로 바꾸면서 `left: 0`/`right: 0`
   * 을 새로 넣었고, 그건 기존 소비자(#113 계정 메뉴, #121 메시지 툴바)의 가로 정렬을
   * 바꾼다. 좌표를 안 준 소비자는 지금과 똑같이 동작해야 한다.
   *
   * 화면 밖으로 나가지 않게 자른다. 메뉴 높이는 항목 수에 따라 다르니 실제 높이를 재서
   * 자르는 것이 정확하지만, 여는 순간에는 아직 렌더되지 않았다. 항목 하나가 약 28px 이라
   * 항목 수로 어림한다 — 300px 같은 고정값은 항목 셋짜리 메뉴를 화면 아래에서
   * 불필요하게 위로 밀어 올린다.
   */
  const MENU_WIDTH = 128;
  const EDGE_GAP = 8;
  const menuStyle = openAt
    ? (() => {
        const height = items.length * 28 + 8;
        const x = Math.max(EDGE_GAP, Math.min(openAt.x, window.innerWidth - MENU_WIDTH - EDGE_GAP));
        const y = Math.max(EDGE_GAP, Math.min(openAt.y, window.innerHeight - height - EDGE_GAP));
        return { position: 'fixed' as const, left: x, top: y };
      })()
    : undefined;

  return (
    <>
      {renderTrigger(triggerProps)}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
          className={`${openAt ? '' : `absolute ${placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`} z-10 min-w-32 rounded border border-border bg-surface-raised py-1 shadow-lg ${className}`}
          style={menuStyle}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[index] = el; }}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { if (!item.disabled) { item.onSelect(); close(); } }}
              onKeyDown={(e) => onMenuKeyDown(e, index)}
              className={`flex w-full px-3 py-1.5 text-left text-sm ${
                item.disabled ? 'cursor-not-allowed text-fg-subtle' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
