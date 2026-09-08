import { useState, useRef, useEffect, useCallback } from 'react';
import type { MessageRow } from '@murmur/shared';
import { displayBody } from '../lib/mention';
import { useActiveStore } from '../state/communities';
import { getController } from '../state/controller';
import { useT } from '../i18n/useT';

/**
 * ⌘K 와 ⌘F 는 **다른 물음**이다.
 *
 * - `'all'` — 워크스페이스 전체 찾기(⌘K). 그 말이 어디 있었는지 모를 때.
 * - `'channel'` — 지금 보는 대화 안에서(채널 헤더 버튼, 또는 스레드가 닫힌 ⌘F).
 * - `'thread'` — 열려 있는 스레드 안에서(⌘F). 브라우저 찾기의 근육 기억과 같은 자리다.
 */
export type SearchScope = 'all' | 'channel' | 'thread';

interface Props {
  open: boolean;
  onClose: () => void;
  initialScope?: SearchScope;
}

/**
 * 검색은 디바운스(300ms) 처리한다 — 입력마다 서버를 치지 않는다.
 * 전문검색 쿼리가 값싸지 않으므로 입력 후 잠시 기다렸다가 보낸다.
 *
 * 전역 진입점(⌘K)은 전체, 채널 진입점(헤더 버튼)은 채널, ⌘F 는 스레드가 열려 있으면 그
 * 스레드·없으면 채널로 연다 — 셋 다 사람의 명시적 선택이다.
 */
export function SearchPalette({ open, onClose, initialScope = 'all' }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MessageRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  /**
   * #221: 기본값은 전역이다. 좁히는 것은 사람이 명시적으로 하는 선택이라, 팔레트를 열
   * 때마다 그 열기를 시작한 진입점이 정한 값(`initialScope`)으로 돌아간다 — 앞서 손으로
   * 바꾼 스코프가 다음 ⌘K 까지 따라오지 않는다(#258).
   *
   * 여기 `useState` 초기값은 **마운트 때 한 번만** 읽힌다. `Workspace` 는 이 컴포넌트를
   * 계속 마운트해 둔 채 `open` 만 뒤집으므로, 실제로 값을 반영하는 곳은 아래 `open` 이펙트다.
   */
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [hasMore, setHasMore] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const accounts = useActiveStore((s) => s.accounts);
  const channels = useActiveStore((s) => s.channels);
  const dms = useActiveStore((s) => s.dms);
  const activeChannelId = useActiveStore((s) => s.activeChannelId);
  const activeThreadRootId = useActiveStore((s) => s.threadRootId);

  const getChannelName = useCallback((channelId: string): string => {
    const channel = channels.find((c) => c.id === channelId);
    if (channel) return channel.name ?? t('search.palette.unnamedChannel');
    const dm = dms.find((d) => d.id === channelId);
    if (dm) {
      const otherId = dm.memberIds.find((id) => id !== useActiveStore.getState().me?.id);
      const other = otherId ? accounts[otherId] : null;
      return other ? `@${other.handle}` : 'DM';
    }
    return channelId;
  }, [channels, dms, accounts, t]);

  const getAuthorName = useCallback((authorId: string): string => {
    const account = accounts[authorId];
    return account ? `@${account.handle}` : authorId;
  }, [accounts]);

  /**
   * 스코프 하나가 **두 인자**로 갈린다. 스레드 스코프에도 채널을 함께 보내는 이유는
   * 서버의 403 판정이 채널 단위이기 때문이다(`/search` 주석).
   */
  const scopeArgs = useCallback((s: SearchScope): { channelId: string | null; threadRootId: string | null } => {
    if (s === 'thread' && activeThreadRootId && activeChannelId) {
      return { channelId: activeChannelId, threadRootId: activeThreadRootId };
    }
    if (s !== 'all' && activeChannelId) return { channelId: activeChannelId, threadRootId: null };
    return { channelId: null, threadRootId: null };
  }, [activeChannelId, activeThreadRootId]);

  /**
   * `offset` 이 0 이면 새 검색(결과를 갈아치운다), 아니면 '더 보기'(뒤에 잇는다).
   * 한 함수로 둔 이유는 스코프·질의를 두 벌 들고 다니지 않기 위해서다.
   */
  const search = useCallback(async (q: string, s: SearchScope, offset = 0) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const page = await getController().api.search(q, { ...scopeArgs(s), offset });
      setResults((prev) => (offset === 0 ? page.messages : [...prev, ...page.messages]));
      setHasMore(page.hasMore);
      setHasSearched(true);
      if (offset === 0) setActiveIndex(page.messages.length > 0 ? 0 : -1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('search.palette.failed'));
      if (offset === 0) setResults([]);
    } finally {
      setLoading(false);
    }
  }, [t, scopeArgs]);

  const handleSearch = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      search(value, scope);
    }, 300);
  }, [search, scope]);

  /**
   * 스코프 바꾸기는 디바운스를 건너뛴다 — 타이핑과 달리 이건 한 번의 명시적 동작이라
   * 기다릴 이유가 없고, 기다리면 방금 누른 것이 반영됐는지 알 수 없다.
   */
  const chooseScope = useCallback((next: SearchScope) => {
    setScope(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim()) search(query, next);
  }, [query, search]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setError(null);
      setHasSearched(false);
      setActiveIndex(-1);
      setScope('all');
      setHasMore(false);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    // 열릴 때마다 진입점이 정한 스코프를 적용한다. `useState` 초기값에만 맡기면 마운트
    // 이후 첫 열기 한 번만 맞고, 그다음부터는 헤더 버튼이 좁히지 못한다.
    //
    // `initialScope` 는 의도적으로 의존성에서 뺐다 — 팔레트가 이미 열려 있는 동안
    // 부모가 이 값을 바꿔도 사람이 손으로 고른 스코프를 덮어쓰지 않아야 한다. 열기 동작은
    // 언제나 `initialScope` 와 `open` 을 같은 이벤트에서 함께 바꾸므로, 이 이펙트가
    // 도는 렌더에는 새 값이 이미 들어와 있다.
    setScope(initialScope);
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

  const openResult = useCallback((msg: MessageRow) => {
    // 이동은 `openMessage` 하나에 맡긴다 — 채널 전환·스레드 패널·강조·실패 통지가 전부
    // 그 안에 있다(인박스·저장·첨부가 이미 그 길로 간다). 여기서 openChannel/openThread 를
    // 직접 부르면 강조가 걸리지 않아 "눌렀는데 아무 일도 없다"가 된다.
    void getController().openMessage(msg.id);
    close();
  }, [close]);

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
        openResult(results[activeIndex]);
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, results, activeIndex, close, openResult]);

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
        className="w-full max-w-xl rounded-lg border border-border bg-surface-raised shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={t('search.palette.label')}
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              const value = e.target.value;
              setQuery(value);
              handleSearch(value);
            }}
            placeholder={scope === 'thread' && activeThreadRootId
              ? t('search.palette.placeholderThread')
              : scope === 'channel' && activeChannelId
                ? t('search.palette.placeholderScoped', { name: getChannelName(activeChannelId) })
                : t('search.palette.placeholderAll')}
            aria-label={t('search.palette.input')}
            className="flex-1 bg-transparent text-fg placeholder-fg-subtle focus:outline-none"
          />
          {/* '검색 중...' 은 진행 표시다 — 읽고 무언가 하는 글자가 아니라 아랫단 11px.
              오류(`role="alert"`)와 '결과가 없습니다' 는 반대로 본문단이다: 그때는 결과
              목록이 비어 있고 이 한 줄이 화면에 남는 유일한 설명이 된다. */}
          {loading && <span className="text-meta text-fg-subtle">{t('search.palette.loading')}</span>}
        </div>

        {/* 스코프는 켬/끔이 아니라 **셋 중 하나**다(전체·이 채널·이 스레드). 체크박스로는
            셋을 말할 수 없어 고르는 줄로 바꿨다. 스레드 칸은 스레드가 열려 있을 때만 선다 —
            없는 자리를 회색으로 남겨 두면 왜 못 누르는지 설명할 자리가 또 필요해진다. */}
        {activeChannelId && (
          <div className="flex items-center gap-1 border-b border-border px-3 py-2" role="group" aria-label={t('search.palette.scopeGroup')}>
            {(['all', 'channel', ...(activeThreadRootId ? ['thread' as const] : [])] as SearchScope[]).map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`search-scope-${s}`}
                aria-pressed={scope === s}
                onClick={() => chooseScope(s)}
                className={`rounded px-2 py-1 text-meta ${
                  scope === s ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:bg-surface-sunken'
                }`}
              >
                {s === 'all'
                  ? t('search.palette.scopeAll')
                  : s === 'channel'
                    ? t('search.palette.scopeLabel', { name: getChannelName(activeChannelId) })
                    : t('search.palette.scopeThread')}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div role="alert" className="border-b border-border bg-danger-surface p-3 text-danger">
            {error}
          </div>
        )}

        <ul
          className="max-h-80 overflow-y-auto p-2"
          role="listbox"
          aria-label={t('search.palette.results')}
        >
          {hasSearched && enabledResults.length === 0 && !loading && !error && (
            <li className="p-4 text-center text-fg-subtle">{t('search.palette.empty')}</li>
          )}
          {enabledResults.map((msg, index) => (
            <li
              key={msg.id}
              ref={(el) => { resultRefs.current[index] = el; }}
              role="option"
              aria-selected={index === activeIndex}
              data-testid="search-result"
              onClick={() => openResult(msg)}
              className={`cursor-pointer rounded px-3 py-2 ${
                index === activeIndex ? 'bg-surface-hover' : 'hover:bg-surface-sunken'
              }`}
            >
              {/* 결과 한 줄은 두 단으로 갈린다: **누가·어디**(아랫단 11px)와 **무엇을
                  말했나**(본문단). 찾는 사람이 눈으로 훑는 것은 본문이고, 출처는 그
                  본문을 고른 뒤 확인하는 꼬리표다. */}
              <div className="flex items-center gap-2 text-meta text-fg-muted">
                <span className="font-medium text-fg-muted">{getAuthorName(msg.authorId)}</span>
                <span>·</span>
                <span>{getChannelName(msg.channelId)}</span>
                {msg.threadRootId && msg.threadRootId !== msg.id && (
                  <>
                    <span>·</span>
                    <span className="text-fg-subtle">{t('search.palette.thread')}</span>
                  </>
                )}
              </div>
              {/* 본문은 `displayBody` 를 지난다 — 이 줄도 `MessageBody` 를 지나지 않아
                  `<@id>`·`{account}` 를 스스로 풀어야 한다(`lib/mention` 주석). */}
              <div className="mt-1 truncate text-fg">{displayBody(msg, accounts)}</div>
            </li>
          ))}
          {/* 잘렸다는 것을 말하지 않으면 사람은 "없다"로 읽는다 — 상위 50 건이 전부 최근
              것으로 차 있던 때 정작 찾던 옛 메시지가 없어 보이던 것과 같은 오해다. */}
          {hasMore && !loading && (
            <li className="p-2">
              <button
                type="button"
                data-testid="search-more"
                onClick={() => search(query, scope, enabledResults.length)}
                className="w-full rounded px-3 py-2 text-meta text-fg-muted hover:bg-surface-sunken"
              >
                {t('search.palette.more')}
              </button>
            </li>
          )}
        </ul>

        {/* 단축키 안내 띠 — 아랫단 11px. 한 번 배우면 안 읽는 자리다. */}
        <div className="border-t border-border px-3 py-2 text-meta text-fg-subtle">
          <span>{t('search.palette.hintMove')}</span>
          <span className="mx-2">·</span>
          <span>{t('search.palette.hintOpen')}</span>
          <span className="mx-2">·</span>
          <span>{t('search.palette.hintClose')}</span>
        </div>
      </div>
    </div>
  );
}