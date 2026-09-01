import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { mentionQueryAt, applyMention, type MentionQuery } from '../lib/mention';

/** 목록이 화면을 덮지 않을 만큼만 보여준다. 더 좁히는 것은 사용자가 글자를 더 치는 일이다. */
const MAX_SUGGESTIONS = 8;

/** 에이전트를 먼저 세운다 — murmur 에서 @ 를 치는 주된 이유다. 그 안에서는 이름순. */
function rank(a: AccountView, b: AccountView): number {
  if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1;
  return a.handle.localeCompare(b.handle);
}

interface Props {
  /** 실패를 reject 로 알리면 초안을 되돌린다 — 쓴 글이 조용히 사라지지 않게. */
  onSend: (body: string) => void | Promise<unknown>;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
}

export function Composer({ onSend, placeholder, rows = 2, autoFocus }: Props) {
  const accounts = useAppStore((s) => s.accounts);
  const myId = useAppStore((s) => s.me?.id);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 삽입 후 커서를 옮겨야 한다. React 는 value 만 되돌리므로 DOM 을 직접 만진다.
  const pendingCaret = useRef<number | null>(null);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.query.toLowerCase();
    return Object.values(accounts)
      .filter((a) => a.id !== myId && a.handle.toLowerCase().startsWith(q))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS);
  }, [accounts, myId, query]);

  // 후보가 없으면 목록은 없는 것과 같다 — Enter 를 붙잡아 두면 메시지를 못 보낸다.
  const open = query !== null && matches.length > 0;

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [draft]);

  const recompute = (text: string, caret: number | null) => {
    setQuery(caret === null ? null : mentionQueryAt(text, caret));
    setActive(0);
  };

  const pick = (handle: string) => {
    if (!query) return;
    const next = applyMention(draft, query, handle);
    setDraft(next.text);
    pendingCaret.current = next.caret;
    // 고른 뒤에는 닫는다 — 열린 채로 두면 다음 Enter 가 전송으로 가지 못한다.
    setQuery(null);
    setActive(0);
    ref.current?.focus();
  };

  const send = () => {
    if (!draft.trim()) return;
    const body = draft;
    setDraft('');
    setQuery(null);
    // 초안을 먼저 비우는 이유는 응답을 기다리는 동안 다음 글을 쓸 수 있어야 하기 때문이다.
    // 실패하면 되돌리되, 그 사이에 사용자가 새로 쓴 것을 덮지 않는다.
    void Promise.resolve(onSend(body)).catch(() => {
      setDraft((current) => (current ? current : body));
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[active]!.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const listId = 'mention-suggestions';

  return (
    <div className="relative">
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-72 overflow-y-auto rounded border border-zinc-300 bg-white py-1 shadow-lg"
        >
          {matches.map((a, i) => (
            <li key={a.id}>
              <button
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                type="button"
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === active ? 'bg-indigo-50' : ''}`}
                // mousedown 을 막지 않으면 클릭 전에 textarea 가 blur 되어 커서 위치가 사라진다.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(a.handle)}
              >
                <span className="font-medium">@{a.handle}</span>
                {a.kind === 'agent' && (
                  <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">agent</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        className="w-full resize-none rounded border border-zinc-300 px-3 py-2"
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={draft}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          recompute(e.target.value, e.target.selectionStart);
        }}
        // 커서만 움직여도 후보가 달라진다. 목록이 열린 동안의 화살표는 위에서 막으므로
        // 여기서 커서가 튀는 일은 없다.
        onSelect={(e) => {
          const t = e.currentTarget;
          recompute(t.value, t.selectionStart);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
