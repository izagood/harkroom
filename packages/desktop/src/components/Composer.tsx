import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AccountView } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import {
  mentionQueryAt, applyMention, withStickyMentions, keepMentioned, type MentionQuery,
} from '../lib/mention';

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
  /**
   * 고정 멘션을 담아 두는 대화의 이름. 채널을 옮기면 부르던 상대도 달라진다 —
   * 앞 채널의 에이전트를 끌고 가면 엉뚱한 곳에서 깨어난다.
   */
  scopeKey?: string;
}

export function Composer({ onSend, placeholder, rows = 2, autoFocus, scopeKey = '' }: Props) {
  const accounts = useAppStore((s) => s.accounts);
  const myId = useAppStore((s) => s.me?.id);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [active, setActive] = useState(0);
  const [stickyByScope, setStickyByScope] = useState<Record<string, string[]>>({});
  const [picking, setPicking] = useState(false);
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

  const known = useMemo(
    () => new Set(
      Object.values(accounts).filter((a) => a.id !== myId).map((a) => a.handle.toLowerCase()),
    ),
    [accounts, myId],
  );

  // 계정이 사라지면 고정도 사라진다 — 없는 handle 을 붙이면 멘션이 아니라 그냥 글자다.
  const sticky = useMemo(
    () => (stickyByScope[scopeKey] ?? []).filter((h) => known.has(h)),
    [stickyByScope, scopeKey, known],
  );

  // @ 버튼으로 여는 목록. 첫 줄을 보내기 전에도 상대를 정해 둘 수 있어야 한다.
  // 이미 고정된 상대는 뺀다 — 다시 골라도 달라지는 것이 없다.
  const pickable = useMemo(
    () => Object.values(accounts)
      .filter((a) => a.id !== myId && !sticky.includes(a.handle.toLowerCase()))
      .sort(rank)
      .slice(0, MAX_SUGGESTIONS),
    [accounts, myId, sticky],
  );

  // 두 목록은 한자리에 뜨고 키보드도 하나다 — 동시에 열리면 Enter 가 어디로 갈지 모른다.
  const options = picking ? pickable : matches;
  // 후보가 없으면 목록은 없는 것과 같다 — Enter 를 붙잡아 두면 메시지를 못 보낸다.
  const open = options.length > 0 && (picking || query !== null);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null || !ref.current) return;
    pendingCaret.current = null;
    ref.current.setSelectionRange(caret, caret);
  }, [draft]);

  const closeLists = () => {
    setQuery(null);
    setPicking(false);
    setActive(0);
  };

  const recompute = (text: string, caret: number | null) => {
    setQuery(caret === null ? null : mentionQueryAt(text, caret));
    // 글을 쓰기 시작하면 @ 버튼으로 연 목록은 자리를 비켜야 한다.
    setPicking(false);
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

  /** 목록에서 하나 고른다. @ 버튼으로 연 목록은 초안을 건드리지 않고 곧바로 고정한다. */
  const choose = (handle: string) => {
    if (!picking) return pick(handle);
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: [...sticky, handle.toLowerCase()] }));
    setPicking(false);
    setActive(0);
    ref.current?.focus();
  };

  const drop = (handle: string) => {
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: sticky.filter((h) => h !== handle) }));
    ref.current?.focus();
  };

  const send = () => {
    // 고정 멘션만으로는 보낼 것이 없다 — 빈 Enter 가 '@fizz' 하나만 던지면 사고다.
    if (!draft.trim()) return;
    const typed = draft;
    const body = withStickyMentions(typed, sticky);
    setDraft('');
    setQuery(null);
    // 이번에 부른 상대는 다음 줄부터 고정이다. 한 번 부른 뒤 매번 @ 를 다시 치게 하면
    // 사용자는 잊어버리고, 잊으면 에이전트는 깨어나지 않는다.
    setStickyByScope((prev) => ({ ...prev, [scopeKey]: keepMentioned(sticky, typed, known) }));
    // 초안을 먼저 비우는 이유는 응답을 기다리는 동안 다음 글을 쓸 수 있어야 하기 때문이다.
    // 실패하면 사용자가 친 것만 되돌린다 — 접두사까지 남기면 다음 전송에서 두 번 붙는다.
    void Promise.resolve(onSend(body)).catch(() => {
      setDraft((current) => (current ? current : typed));
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(options[active]!.handle);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLists();
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
          aria-label={picking ? 'Mentions to keep' : 'Mention suggestions'}
          className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-72 overflow-y-auto rounded border border-zinc-300 bg-white py-1 shadow-lg"
        >
          {options.map((a, i) => (
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
                onClick={() => choose(a.handle)}
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
      {sticky.length > 0 && (
        <ul className="mb-1 flex flex-wrap items-center gap-1" aria-label="Kept mentions">
          {sticky.map((h) => (
            <li
              key={h}
              data-testid="sticky-mention"
              data-handle={h}
              className="flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-zinc-700"
            >
              <span>@{h}</span>
              <button
                type="button"
                aria-label={`Remove @${h}`}
                className="rounded px-0.5 text-zinc-500 hover:bg-zinc-200"
                // 목록의 버튼과 같은 이유로 blur 를 막는다 — 지운 뒤에도 커서는 글 안에 있어야 한다.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => drop(h)}
              >
                ×
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
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          aria-label="Add mention"
          aria-pressed={picking}
          className={`rounded px-2 py-0.5 text-sm text-zinc-600 hover:bg-zinc-100 ${
            picking ? 'bg-zinc-200' : ''
          }`}
          // 누르는 동안 textarea 가 blur 되면 커서 자리가 사라진다.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (picking) return closeLists();
            // 자동완성이 열려 있었다면 자리를 넘겨받는다 — 두 목록이 겹치면 안 된다.
            setQuery(null);
            setPicking(true);
            setActive(0);
          }}
        >
          @
        </button>
      </div>
    </div>
  );
}
