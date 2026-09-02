import { useState, useRef, useEffect, useCallback, useLayoutEffect, type ReactNode, type KeyboardEvent, type MouseEvent } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  className?: string;
}

export function Menu({ trigger, items, className = '' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setFocusedIndex(0);
      return;
    }
    menuItemRefs.current[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      const enabledItems = items.map((item, i) => ({ ...item, originalIndex: i })).filter(item => !item.disabled);
      const currentEnabledIndex = enabledItems.findIndex(item => item.originalIndex === focusedIndex);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = currentEnabledIndex === -1 ? 0 : (currentEnabledIndex + 1) % enabledItems.length;
        const nextOriginalIndex = enabledItems[nextIndex]?.originalIndex ?? 0;
        setFocusedIndex(nextOriginalIndex);
        menuItemRefs.current[nextOriginalIndex]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = currentEnabledIndex === -1 ? 0 : (currentEnabledIndex - 1 + enabledItems.length) % enabledItems.length;
        const prevOriginalIndex = enabledItems[prevIndex]?.originalIndex ?? 0;
        setFocusedIndex(prevOriginalIndex);
        menuItemRefs.current[prevOriginalIndex]?.focus();
      }
    };

    const menu = menuRef.current;
    menu?.addEventListener('keydown', handleKeyDown as unknown as EventListener);
    return () => { menu?.removeEventListener('keydown', handleKeyDown as unknown as EventListener); };
  }, [open, focusedIndex, items, close]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(target) &&
          triggerRef.current && !triggerRef.current.contains(target)) {
        close();
      }
    };
    document.addEventListener('mousedown', handleClickOutside as unknown as EventListener);
    return () => document.removeEventListener('mousedown', handleClickOutside as unknown as EventListener);
  }, [open, close]);

  const handleTriggerClick = () => {
    setOpen(!open);
  };

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    item.onSelect();
    close();
  };

  const handleItemKeyDown = (e: KeyboardEvent, item: MenuItem) => {
    if (item.disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      item.onSelect();
      close();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleTriggerClick}
        aria-haspopup="true"
        aria-expanded={open}
        className="font-medium"
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute bottom-full mb-1 min-w-32 rounded border border-zinc-700 bg-zinc-800 py-1 shadow-lg ${className}`}
        >
          {items.map((item, index) => (
            <button
              key={index}
              ref={(el) => { menuItemRefs.current[index] = el; }}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => handleItemClick(item)}
              onKeyDown={(e) => handleItemKeyDown(e, item)}
              className={`flex w-full px-3 py-1.5 text-left text-sm
                ${item.disabled
                  ? 'cursor-not-allowed text-zinc-500'
                  : 'text-zinc-200 hover:bg-zinc-700 hover:text-zinc-100'
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