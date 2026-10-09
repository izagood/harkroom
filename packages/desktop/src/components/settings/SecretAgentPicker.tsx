import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AccountView } from '@harkroom/shared';
import { Identity } from '../Identity';
import { useT } from '../../i18n/useT';

/**
 * 비밀을 받을 에이전트 고르기 — 「+ 에이전트 추가」 → **검색되는 팝오버**(designer 시안 v1 #1, 스레드 df404cf5).
 *
 * OS 기본 `select` 를 걷어 낸 자리다. 에이전트가 23개쯤 되면 네이티브 목록이 아래 비밀 줄을 덮고 설정 패널 밖으로
 * 삐져나왔고, 얼굴도 검색도 없었고, 이미 받는 에이전트가 다시 보였다. 여기서는:
 * - 목록 높이는 최대 240px(`max-h-60`)이고 넘치면 **안에서** 스크롤한다 — 화면 아래 줄을 밀거나 넘치지 않는다.
 * - 얼굴 + handle 을 한 줄로(`TeamMemberPicker` 와 같은 `Identity avatar`). 검색은 handle·표시 이름을 훑는다.
 * - 이미 받는 에이전트는 흐리게 「받는 중」 — 고를 수 없다(같은 부여를 다시 만들 일이 없다).
 * - 키보드: ↑↓ 로 옮기고 Enter 로 고르고 Esc 로 닫는다. 닫히면 초점은 여는 단추로 돌아간다.
 *
 * 후보를 거르는 판정(내 에이전트만)은 호출부가 한다 — 서버도 남의 에이전트는 `not_own_agent` 로 거절한다.
 */
export function SecretAgentPicker({ candidates, granted, disabled, onPick }: {
  /** 고를 수 있는 에이전트(가나다로 세워서 넘긴다). */
  candidates: AccountView[];
  /** 이미 받는 에이전트 id — 흐리게 「받는 중」. */
  granted: ReadonlySet<string>;
  disabled?: boolean;
  onPick(agentId: string): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    return q
      ? candidates.filter((a) => a.handle.toLowerCase().includes(q) || (a.displayName ?? '').toLowerCase().includes(q))
      : candidates;
  }, [candidates, query]);
  const pickable = (i: number) => i >= 0 && i < shown.length && !granted.has(shown[i]!.id);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const openPicker = () => {
    setQuery('');
    setActive(Math.max(0, candidates.findIndex((a) => !granted.has(a.id))));
    setOpen(true);
  };

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  // 검색이 바뀌면 첫 번째 고를 수 있는 줄로 — 그대로 Enter 를 치면 맨 위가 들어간다.
  useEffect(() => { setActive(Math.max(0, shown.findIndex((a) => !granted.has(a.id)))); }, [shown, granted]);
  // 바깥을 누르면 닫는다(초점은 사람이 누른 곳에 둔다).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (i: number) => {
    if (!pickable(i)) return;
    onPick(shown[i]!.id);
    close(true);
  };
  const move = (dir: 1 | -1) => {
    for (let i = active + dir; i >= 0 && i < shown.length; i += dir) {
      if (pickable(i)) { setActive(i); document.getElementById(`${listId}-${i}`)?.scrollIntoView?.({ block: 'nearest' }); return; }
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="secret-agent-add"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close(false) : openPicker())}
        className="rounded-row border border-border px-2.5 py-1 text-meta text-fg hover:bg-surface-hover disabled:opacity-50"
      >
        {t('secrets.agentAdd')}
      </button>
      {open && (
        <div
          data-testid="secret-agent-picker"
          className="absolute left-0 top-full z-20 mt-1 w-72 max-w-[calc(100vw-48px)] rounded-card border border-border bg-surface-raised shadow-lg"
        >
          <input
            ref={inputRef}
            role="combobox"
            aria-label={t('secrets.agentSearch')}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={pickable(active) ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            placeholder={t('secrets.agentSearch')}
            className="w-full border-b border-border bg-transparent px-3 py-2 text-meta text-fg placeholder-fg-subtle outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
              else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
            }}
          />
          <div id={listId} role="listbox" aria-label={t('secrets.agentsMine')} className="max-h-60 overflow-y-auto p-1">
            <div aria-hidden="true" className="px-2 pb-0.5 pt-1.5 text-meta text-fg-subtle">
              {t('secrets.agentsMineCount', { n: String(shown.length) })}
            </div>
            {shown.map((a, i) => {
              const have = granted.has(a.id);
              return (
                <div
                  key={a.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active && !have}
                  aria-disabled={have || undefined}
                  data-testid={`secret-agent-option-${a.handle}`}
                  onMouseEnter={() => { if (!have) setActive(i); }}
                  // mousedown 에서 막아야 입력 칸 초점이 안 빠진다(바깥 누름 판정과도 겹치지 않는다).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={`flex items-center gap-2 rounded-row px-2 py-1 text-meta ${
                    have ? 'cursor-default opacity-45' : `cursor-pointer text-fg ${i === active ? 'bg-surface-hover' : ''}`
                  }`}
                >
                  <Identity account={a} className="h-5 w-5 text-[10px]" variant="avatar" />
                  <span className="truncate">@{a.handle}</span>
                  {have && <span className="ml-auto text-meta text-fg-subtle">{t('secrets.agentReceiving')}</span>}
                </div>
              );
            })}
            {shown.length === 0 && (
              <p className="px-2 py-3 text-center text-meta text-fg-muted">
                {candidates.length === 0 ? t('secrets.agentNoneMine') : t('secrets.agentNoMatch')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
