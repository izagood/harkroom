import { useState, useRef, useEffect, useCallback } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useAppStore } from '../state/appStore';
import { getController } from '../state/controller';

interface Props {
  open: boolean;
  onClose: () => void;
  initialScoped?: boolean;
}

/**
 * 검색은 디바운스(300ms) 처리한다 — 입력마다 서버를 치지 않는다.
 * 전문검색 쿼리가 값싸지 않으므로 입력 후 잠시 기다렸다가 보낸다.
 *
 * 전역 진입점(⌘K)은 꺼진 채, 채널 진입점(헤더 버튼)은 켜진 채 연다 — 둘 다 사람의 명시적 선택이다.
 */
export function SearchPalette({ open, onClose, initialScoped = false }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [scoped, setScoped] = useState(initialScoped);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const accounts = useAppStore((s) => s.accounts);
  const channels = useAppStore((s) => s.channels);
  const dms = useAppStore((s) => s.dms);
  const activeChannelId = useAppStore((s) => s.activeChannelId);

  const getChannelName = useCallback((channelId: string): string => {
    const channel = channels.find((c) => c.id === channelId);
    if (channel) return channel.name ?? '이름 없는 채널';
    const dm = dms.find((d) => d.id === channelId);
    if (dm) {
      const otherId = dm.memberIds.find((id) => id !== useAppStore.getState().me?.id);
      const other = otherId ? accounts[otherId] : null;
      return other ? `@${other.handle}` : 'DM';
    }
    return channelId;
  }, [channels, dms, accounts]);

  const getAuthorName = useCallback((authorId: string): string => {
    const account = accounts[authorId];
    return account ? `@${account.handle}` : authorId;
  }, [accounts]);

  const search = useCallback(async (q: string, channelId: string | null) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const messages = await getController().api.search(q, channelId);
      setResults(messages);
      setHasSearched(true);
      setActiveIndex(messages.length > 0 ? 0 : -1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '검색 실패');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const scopeChannelId = scoped && activeChannelId ? activeChannelId : null;

  const handleSearch = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(value, scopeChannelId);
    }, 300);
  }, [search, scopeChannelId]);

  /**
   * 토글은 디바운스를 건너뛴다 — 타이핑과 달리 이건 한 번의 명시적 동작이라
   * 기다릴 이유가 없고, 기다리면 방금 누른 것이 반영됐는지 알 수 없다.
   */
  const toggleScope = useCallback(() => {
    const next = !scoped;
    setScoped(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) search(query, next && activeChannelId ? activeChannelId : null);
  }, [scoped, query, activeChannelId, search]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setHasSearched(false);
      setActiveIndex(-1);
      setScoped(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => {
          const step = e.key === 'ArrowDown' ? 1 : -1;
          const next = ((prev + step) + results.length) % results.length;
          const el = resultRefs.current[next];
          if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
          return next;
        });
        return;
      }
      if (e.key === 'Enter' && activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        const msg = results[activeIndex];
        getController().openChannel(msg.channelId);
        if (msg.threadRootId && msg.threadRootId !== msg.id) {
          getController().openThread(msg.threadRootId);
        }
        close();
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, results, activeIndex, close]);

  if (!open) return null;

  const enabledResults = results;

  return (
    // 닫힘 처리를 여기서 직접 한다. `Menu.tsx` 의 document mousedown 이나 `Composer.tsx`
    // 의 relatedTarget 경로를 재사용하지 않는 이유: 이건 **모달**이라 백드롭이 화면 전체를
    // 덮는다. `e.target === e.currentTarget` 로 백드롭 자신을 눌렀을 때만 닫으면 되고,
    // document 리스너를 붙이면 오히려 팔레트 안쪽 클릭까지 걸러 내야 한다.
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="메시지 검색"
      >
        <div className="flex items-center gap-2 border-b border-zinc-700 p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              const value = e.target.value;
              setQuery(value);
              handleSearch(value);
            }}
            placeholder={scoped && activeChannelId ? `이 채널에서 찾기 (${getChannelName(activeChannelId)})` : '전체에서 찾기'}
            aria-label="검색어 입력"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
          />
          {loading && <span className="text-xs text-zinc-500">검색 중...</span>}
        </div>

        {activeChannelId && (
          <div className="flex items-center gap-2 border-b border-zinc-700 px-3 py-2">
            <input
              id="search-scope-toggle"
              type="checkbox"
              checked={scoped}
              onChange={toggleScope}
              className="accent-teal-500"
            />
            <label htmlFor="search-scope-toggle" className="cursor-pointer text-xs text-zinc-400">
              이 채널에서만 ({getChannelName(activeChannelId)})
            </label>
          </div>
        )}

        {error && (
          <div role="alert" className="border-b border-zinc-700 bg-red-900/20 p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <ul
          className="max-h-80 overflow-y-auto p-2"
          role="listbox"
          aria-label="검색 결과"
        >
          {hasSearched && enabledResults.length === 0 && !loading && !error && (
            <li className="p-4 text-center text-sm text-zinc-500">검색 결과가 없습니다</li>
          )}
          {enabledResults.map((msg, index) => (
            <li
              key={msg.id}
              ref={(el) => { resultRefs.current[index] = el; }}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => {
                getController().openChannel(msg.channelId);
                if (msg.threadRootId && msg.threadRootId !== msg.id) {
                  getController().openThread(msg.threadRootId);
                }
                close();
              }}
              className={`cursor-pointer rounded px-3 py-2 ${
                index === activeIndex ? 'bg-zinc-700' : 'hover:bg-zinc-700/50'
              }`}
            >
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="font-medium text-zinc-300">{getAuthorName(msg.authorId)}</span>
                <span>·</span>
                <span>{getChannelName(msg.channelId)}</span>
                {msg.threadRootId && msg.threadRootId !== msg.id && (
                  <>
                    <span>·</span>
                    <span className="text-zinc-500">스레드</span>
                  </>
                )}
              </div>
              <div className="mt-1 truncate text-sm text-zinc-200">{msg.body}</div>
            </li>
          ))}
        </ul>

        <div className="border-t border-zinc-700 px-3 py-2 text-xs text-zinc-500">
          <span>↑↓ 이동</span>
          <span className="mx-2">·</span>
          <span>Enter 선택</span>
          <span className="mx-2">·</span>
          <span>Esc 닫기</span>
        </div>
      </div>
    </div>
  );
}