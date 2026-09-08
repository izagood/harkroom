import { useState, useRef, useEffect, useCallback, useLayoutEffect, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /**
   * 이 항목과 같은 일을 하는 단축키(#488 A1). 오른쪽 끝에 흐리게 선다.
   *
   * **아이콘 슬롯은 두지 않았다.** #488 문서가 계정 메뉴에서 12px 글리프를 "정보가 아니라
   * 장식"이라고 명시해 뺐고, 남긴 것은 `⌘,` 하나다 — 그것은 장식이 아니라 **가르치는
   * 정보**이기 때문이다(메뉴는 단축키를 가르치는 자리다). 그래서 프리미티브에도 가르치는
   * 쪽만 슬롯으로 낸다.
   *
   * 접근성 이름에서는 **빠진다** — `aria-hidden` 이다. 항목의 이름은 `Settings` 이지
   * `Settings ⌘,` 가 아니고, 스크린리더는 글리프를 "커맨드 콤마"로 읽지 못한다.
   */
  shortcut?: string;
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
  /**
   * 항목 위에 서는 머리(#488 A1). 계정 메뉴가 "지금 이게 누구인가"를 말해야 해서 생겼다 —
   * 얼굴 · 이름 · `@handle` · 어느 워크스페이스인지.
   *
   * **항목이 아니다.** `MenuItem` 으로 넣으면 눌리는 것이 되고 화살표 이동에도 걸린다 —
   * 머리는 읽는 것이지 고르는 것이 아니다. 그래서 `role="menuitem"` 밖에 둔다.
   */
  header?: ReactNode;
  className?: string;
}

/**
 * 항목의 포커스 표시(#488 B3). 정본 문서가 "시스템 파란 포커스 링"을 결함으로 적었고
 * 고친 모습을 **"포커스 링은 앱의 강조색이다"** 라고 못박았다.
 *
 * **`outline-none` 만 두면 안 된다.** 그것은 파란 링을 지우는 동시에 키보드로 옮기는
 * 사람에게서 "지금 어디에 있는지"를 통째로 빼앗는다 — 메뉴는 ↑/↓ 로 도는 자리라
 * 그 표시가 없으면 쓸 수 없는 것이 된다. 그래서 기본 링은 끄고 **`focus-visible` 에만**
 * 우리 링을 다시 켠다: 브라우저가 "이 포커스는 키보드에서 왔다"고 판정한 경우에만
 * 그리는 의사 클래스라, 마우스 클릭 뒤에 남던 사각형은 사라지고 화살표 이동에서는 선다.
 * `focus` 가 아니라 `focus-visible` 인 것이 이 결함의 핵심이다.
 *
 * 링은 안쪽에 그린다(`-outline-offset-1`). 항목은 메뉴 테두리에 가로로 꽉 차서, 바깥으로
 * 밀어낸 링은 메뉴 밖으로 잘려 나가고 위아래 항목끼리 겹친다.
 *
 * 색은 토큰(`outline-accent` → `--color-accent`)이다. 하드코딩한 색을 쓰면 라이트에서
 * 고른 값이 다크에서 안 맞는다 — 이 저장소가 색 이름을 화면 코드에서 없앤 이유가 그것이다.
 *
 * **`focus-visible:outline-solid` 가 왜 붙어 있는가**(빼면 링이 안 그려진다): Tailwind v4 의
 * `outline-none` 은 `--tw-outline-style: none` 을 남기고, `outline-2` 는 굵기만 정하면서
 * 스타일을 `outline-style: var(--tw-outline-style)` 로 그 변수에서 읽는다. 그래서 둘만
 * 쓰면 `focus-visible` 에서도 스타일이 `none` 으로 계산되어 2px 가 보이지 않는다.
 * 변수를 `solid` 로 되돌리는 한 클래스가 있어야 링이 실제로 선다.
 */
const MENU_ITEM_FOCUS = 'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-1';

export function Menu({ renderTrigger, items, placement = 'top', openOnContextMenu = false, header, className = '' }: MenuProps) {
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
        // 머리가 있으면 그만큼 더 높다(약 44px). 좌표로 여는 소비자(#111)는 아직 머리를
        // 쓰지 않지만, 어림값을 항목 수에만 매어 두면 다음 소비자가 조용히 화면 밖으로 나간다.
        const height = items.length * 28 + (header ? 44 : 0) + 8;
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
          {/*
            머리와 항목은 **같은 가로 축**에 선다 — 둘 다 `px-3` 이다. 항목만 넓히면
            (예: `px-4`) 이름이 머리의 이름보다 오른쪽으로 밀려 두 줄이 어긋나 보인다.
            좁아 보이던 것은 가로가 아니라 **세로**였다: 항목이 `py-1.5`(6px) 라 줄 높이가
            29px 밖에 안 됐고, 그래서 글자가 테두리에 눌린 것처럼 왼쪽 위로 쏠려 읽혔다.
            `py-2`(8px) 로 올려 33px 을 준다 — 머리(`pb-2 pt-1`)와 같은 8px 축을 쓰고,
            줄끼리 붙지 않으면서 네 줄짜리 메뉴가 길어지지도 않는 최소치다.
          */}
          {header && (
            <div className="border-b border-border px-3 pb-2 pt-1">{header}</div>
          )}
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(el) => { itemRefs.current[index] = el; }}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { if (!item.disabled) { item.onSelect(); close(); } }}
              onKeyDown={(e) => onMenuKeyDown(e, index)}
              // 항목은 본문단(앱 기본값 13px), 단축키는 이미 아랫단 11px 이다 — 고르려면
              // 항목을 읽어야 하고 단축키는 한 번 배우면 안 읽는다.
              className={`flex w-full items-center gap-4 px-3 py-2 text-left ${MENU_ITEM_FOCUS} ${
                item.disabled ? 'cursor-not-allowed text-fg-subtle' : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
              }`}
            >
              <span>{item.label}</span>
              {item.shortcut && (
                <span aria-hidden="true" className="ml-auto text-[11px] text-fg-subtle">{item.shortcut}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
