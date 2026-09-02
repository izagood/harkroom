import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode } from 'react';

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
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
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
   */
  placement?: 'top' | 'bottom';
  className?: string;
}

export function Menu({ renderTrigger, items, placement = 'top', className = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
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
    'aria-haspopup': 'menu',
    'aria-expanded': open,
  };

  return (
    <>
      {renderTrigger(triggerProps)}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
          className={`absolute ${placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'} z-10 min-w-32 rounded border border-zinc-700 bg-zinc-800 py-1 shadow-lg ${className}`}
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
                item.disabled ? 'cursor-not-allowed text-zinc-500' : 'text-zinc-200 hover:bg-zinc-700 hover:text-zinc-100'
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
