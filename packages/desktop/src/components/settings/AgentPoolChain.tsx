/**
 * 에이전트 설정 › 실행의 **계정 풀 순서 목록**(2026-10-15 풀 n개, designer 시안 pool_chain).
 *
 * 맨 위 상태 한 줄이 "지금 어느 풀을 왜 쓰나"를 말하고, 줄마다 칩(쓰는 중 / 소진·풀리는 시각 / 대기 /
 * 없음 / 빈 풀)과 계정별 사용량을 붙인다. 판정은 전부 `state`(`poolChainState`, 러너와 같은 식)에서
 * 온다 — 이 컴포넌트는 다시 재지 않는다. 그래서 리셋 시각이 지난 풀은 다시 재기 전이라도 칩이
 * "소진"으로 남지 않고(판정이 이미 풀렸다고 본다), 사용량을 모르는 계정은 「?」로 그린다.
 *
 * 순서는 ↑↓ 버튼으로 바꾼다(키보드·스크린리더로도 된다). 줄이 하나면 ↑↓ 는 그리지 않는다.
 * 마우스·터치로는 줄 왼쪽 손잡이(⋮⋮)를 끌어 옮긴다(풀 n개 후속 f1) — HTML5 끌어놓기가 아니라 포인터
 * 이벤트다(웹뷰마다 다르게 굴고 터치에서 안 된다). 놓으면 ↑↓ 와 같은 `onChange` 로 저장한다.
 * 계정 이름만 보인다 — 이메일·경로는 이 화면에 싣지 않는다.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { PoolChainAccount, PoolChainEntry, PoolChainState } from '@harkroom/shared/claudePoolChain';
import { MAX_AGENT_POOLS } from '@harkroom/shared/claudePools';

import { useLocale, useT } from '../../i18n/useT';

/**
 * 풀리는 시각. **오늘이 아니면 날짜를 붙인다** — 주간 한도는 며칠 뒤에 풀리는데 시각만 쓰면 오늘
 * 그 시각으로 읽힌다(캡처에서 드러남, 시안 「주간 한도(97%) · 10/18 09:00」).
 */
export function clock(ms: number, locale: string, now: number = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

type Chip = 'active' | 'exhausted' | 'waiting' | 'missing' | 'empty';

function chipOf(entry: PoolChainEntry, i: number, state: PoolChainState): Chip {
  if (state.activeIndex === i) return 'active';
  if (entry.status === 'available') return 'waiting';
  return entry.status;
}

const CHIP_CLASS: Record<Chip, string> = {
  // 「쓰는 중」은 초록 — accent 는 이 크기에서 「소진」(danger)과 같은 빨강으로 보인다(designer s4).
  // 빨강은 「소진」에만 남아야 어느 풀이 막혔나가 한눈에 보인다.
  active: 'bg-success-surface text-success',
  exhausted: 'bg-danger-surface text-danger',
  waiting: 'bg-surface-raised text-fg-muted',
  missing: 'bg-surface-raised text-fg-subtle',
  empty: 'bg-surface-raised text-fg-subtle',
};

function AccountUsage({ a }: { a: PoolChainAccount }) {
  const t = useT();
  const pct = a.known ? Math.max(a.sessionPct ?? 0, a.weeklyPct ?? 0) : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid={`pool-chain-account-${a.account}`}>
      <span className="truncate">{a.account}</span>
      <span aria-hidden className="relative inline-block h-1.5 w-10 shrink-0 overflow-hidden rounded-full bg-border">
        {pct !== null && (
          // 막대 색은 설정 › Claude 계정(`ProviderUsageBars`)과 같은 말을 한다 — 평소 중립, 기준에 닿으면 경고.
          <span className={`absolute inset-y-0 left-0 ${a.hot ? 'bg-warning' : 'bg-fg-muted'}`}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        )}
      </span>
      <span className="shrink-0 tabular-nums">
        {a.hotBy === 'blocked'
          ? t('agents.run.poolChain.blocked')
          : pct === null ? '?' : `${Math.round(pct)}%`}
      </span>
    </span>
  );
}

export function AgentPoolChain({
  chain, pools, defaultPool, state, ready, onChange, locked = false,
}: {
  chain: readonly string[];
  /** 이 기기에 있는 풀. */
  pools: readonly string[];
  defaultPool: string | null;
  state: PoolChainState | null;
  ready: boolean;
  onChange(next: string[]): void;
  /**
   * 이 맥에서 쓰이지 않는 순서다(`lib/poolGate.ts` — 이 맥에 배정되지 않았거나 다른 머신에서 돈다). 흐리게
   * 보이기만 하고 고치지 못한다(↑↓✕·끌기·추가 없음, 시안 pool_gate E1 A). 칩은 「쓰이지 않음」, 상태 줄과 사용량
   * 막대는 그리지 않는다 — 둘 다 "이 순서가 지금 쓰인다"를 말한다. 이유와 할 일은 위의 띠가 말한다.
   */
  locked?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const move = (i: number, d: -1 | 1) => {
    const next = [...chain];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };

  /**
   * 끌기(f1). `from` 은 끄는 줄, `to` 는 놓으면 그 줄이 갈 **최종 자리**다. 상태는 그리기용이고
   * 판단은 ref 가 쥔다 — pointermove 가 잇달아 오면 다시 그려지기 전에 다음 이벤트가 온다.
   */
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number; pointerId: number } | null>(null);
  const rowEls = useRef<(HTMLLIElement | null)[]>([]);
  const endDrag = () => { dragRef.current = null; setDrag(null); };
  /** 끄는 줄을 뺀 나머지 줄 중 가운데가 포인터보다 위인 것의 수 = 놓을 자리. */
  const targetOf = (from: number, clientY: number): number => {
    let to = 0;
    chain.forEach((_, j) => {
      const el = rowEls.current[j];
      if (j === from || !el) return;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < clientY) to += 1;
    });
    return to;
  };
  const onHandleDown = (i: number) => (e: ReactPointerEvent<HTMLElement>) => {
    if (!ready || chain.length < 2 || e.button !== 0) return;
    e.preventDefault();
    // jsdom 등 포인터 캡처가 없는 곳도 있다 — 없으면 캡처 없이 간다.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { from: i, to: i, pointerId: e.pointerId };
    setDrag({ from: i, to: i });
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const to = targetOf(d.from, e.clientY);
    if (to === d.to) return;
    dragRef.current = { ...d, to };
    setDrag({ from: d.from, to });
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag();
    // 제자리에 놓았으면 쓰지 않는다 — 바뀐 것이 없는 쓰기는 데몬을 한 번 더 깨울 뿐이다.
    if (d.to === d.from || !ready) return;
    const next = chain.filter((_, j) => j !== d.from);
    next.splice(d.to, 0, chain[d.from]!);
    onChange(next);
  };
  const onHandleCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) endDrag();
  };
  // Escape 는 끌기를 거둔다. 포인터를 캡처한 동안 초점은 다른 데 있을 수 있어 창에서 듣는다.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') endDrag(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dragging]);
  // 저장할 수 없게 되면(스냅샷을 다시 못 읽는 등) 끌던 것도 거둔다 — ↑↓ 가 잠기는 것과 같다.
  useEffect(() => { if (!ready) endDrag(); }, [ready]);
  // 상한(security n3)에 닿으면 더 넣을 수 없다 — 오퍼레이터가 거절할 쓰기를 화면이 만들지 않는다.
  const addable = chain.length >= MAX_AGENT_POOLS ? [] : pools.filter((p) => !chain.includes(p));

  let status: string | null = null;
  /** 상태 줄의 칸 색(designer s3): 평소는 조용히, 뒤 풀로 내려왔으면 경고, 모두 소진·쓸 풀 없음은 위험. */
  let tone: 'quiet' | 'warning' | 'danger' = 'quiet';
  if (locked) {
    status = null;
  } else if (!chain.length) {
    status = defaultPool
      ? t('agents.run.poolChain.statusDefaultNamed', { pool: defaultPool })
      : t('agents.run.poolChain.statusDefault');
  } else if (state) {
    const i = state.activeIndex;
    if (i === null) {
      status = t('agents.run.poolChain.statusNone');
      tone = 'danger';
    } else if (state.allExhausted) {
      tone = 'danger';
      const e = state.entries[i]!;
      status = e.unblockAtMs !== null
        ? t('agents.run.poolChain.statusAllOut', { n: i + 1, pool: e.pool, time: clock(e.unblockAtMs, locale) })
        : t('agents.run.poolChain.statusAllOutUnknown', { n: i + 1, pool: e.pool });
    } else if (i === 0) {
      // 넘어갈 풀이 없으면 그것을 미리 말한다 — 풀을 하나 더 붙일 이유를 화면이 알려 주는 자리(designer).
      const usable = state.entries.filter((e) => e.status === 'available' || e.status === 'exhausted').length;
      status = t(usable > 1 ? 'agents.run.poolChain.statusFirst' : 'agents.run.poolChain.statusOnly',
        { pool: state.entries[0]!.pool });
    } else {
      tone = 'warning';
      // 왜 건너뛰었나(designer s2): 앞 풀 중 **가장 먼저 풀리는** 소진 풀의 이름과 이유. 소진 풀이 없으면
      // (앞 풀이 이 기기에 없거나 빈 풀) 그 첫 풀과 그 사실을 말한다. 그 시각에 새 스레드부터 돌아온다(D3).
      const before = state.entries.slice(0, i).map((e, idx) => ({ e, idx }));
      const out = before.filter(({ e }) => e.status === 'exhausted')
        .sort((a, b) => (a.e.unblockAtMs ?? Infinity) - (b.e.unblockAtMs ?? Infinity) || a.idx - b.idx);
      const why = out[0] ?? before[0]!;
      // 쓰는 풀 앞에는 쓸 수 있는 풀이 없다(그렇다면 그것이 쓰는 풀이다) — 소진·없음·빈 풀뿐이다.
      const reasonKey = why.e.status === 'exhausted' ? (why.e.exhaustedBy ?? 'mixed')
        : why.e.status === 'empty' ? 'empty' : 'missing';
      const vars = {
        n: i + 1, pool: state.entries[i]!.pool, m: why.idx + 1, prev: why.e.pool,
        reason: t(`agents.run.poolChain.reason.${reasonKey}`),
      };
      status = why.e.unblockAtMs !== null
        ? t('agents.run.poolChain.statusFallback', { ...vars, time: clock(why.e.unblockAtMs, locale) })
        : t('agents.run.poolChain.statusFallbackUnknown', vars);
    }
  }

  return (
    <div className="mt-1 space-y-1.5" data-testid="agent-pool-chain">
      {status && (
        <p role="status" data-testid="agent-pool-chain-status" data-tone={tone}
          className={tone === 'quiet' ? 'text-meta text-fg-muted'
            : `rounded-md px-2 py-1.5 text-meta text-fg ${tone === 'warning' ? 'bg-warning-surface' : 'bg-danger-surface'}`}>
          {status}
        </p>
      )}
      {chain.length > 0 && (
        <ol className="space-y-1">
          {chain.map((pool, i) => {
            const entry = state?.entries[i];
            const chip = !locked && entry && state && chain.length > 0 ? chipOf(entry, i, state) : null;
            const dragged = drag?.from === i;
            // 놓일 자리 선: 위로 옮기면 그 자리 줄의 위, 아래로 옮기면 그 자리 줄의 아래.
            const dropLine = drag && drag.to !== drag.from && drag.to === i
              ? (drag.to < drag.from ? 'top' : 'bottom') : null;
            return (
              <li key={pool} data-testid={`agent-pool-chain-row-${pool}`}
                ref={(el) => { rowEls.current[i] = el; }}
                data-dragging={dragged || undefined}
                className={`relative rounded-md border border-border px-2 py-1.5 text-meta${dragged ? ' opacity-50' : locked || entry?.status === 'missing' ? ' opacity-60' : ''}`}>
                {dropLine && (
                  <span aria-hidden data-testid="agent-pool-chain-drop"
                    className={`pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent ${dropLine === 'top' ? '-top-[3px]' : '-bottom-[3px]'}`} />
                )}
                <div className="flex items-center gap-2">
                  {chain.length > 1 && !locked && (
                    // 끌기 손잡이 — 포인터 전용이라 탭 순서에서 뺀다(키보드는 ↑↓ 가 한다).
                    <button type="button" tabIndex={-1} data-testid={`agent-pool-chain-handle-${pool}`}
                      className="-ml-1 shrink-0 cursor-grab touch-none select-none rounded px-0.5 text-fg-subtle hover:bg-surface-raised active:cursor-grabbing disabled:cursor-default disabled:opacity-30"
                      disabled={!ready}
                      aria-label={t('agents.run.poolChain.drag', { pool })}
                      onPointerDown={onHandleDown(i)} onPointerMove={onHandleMove}
                      onPointerUp={onHandleUp} onPointerCancel={onHandleCancel}>⋮⋮</button>
                  )}
                  <span className="w-4 shrink-0 text-right tabular-nums text-fg-subtle">{i + 1}</span>
                  <span className="min-w-0 truncate font-medium text-fg">{pool}</span>
                  {locked && (
                    <span data-testid={`agent-pool-chain-chip-${pool}`}
                      className="shrink-0 rounded-sm bg-surface-raised px-1 text-fg-subtle">
                      {t('agents.run.poolChain.chip.unused')}
                    </span>
                  )}
                  {chip && entry && (
                    <span data-testid={`agent-pool-chain-chip-${pool}`}
                      className={`shrink-0 rounded-sm px-1 ${CHIP_CLASS[chip]}`}>
                      {chip === 'exhausted' && entry.unblockAtMs !== null
                        ? t('agents.run.poolChain.chipExhaustedAt', { time: clock(entry.unblockAtMs, locale) })
                        : t(`agents.run.poolChain.chip.${chip}`)}
                    </span>
                  )}
                  {!locked && <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    {chain.length > 1 && (
                      <>
                        <button type="button" className="rounded px-1 text-fg-muted hover:bg-surface-raised disabled:opacity-30"
                          disabled={!ready || i === 0} onClick={() => move(i, -1)}
                          aria-label={t('agents.run.poolChain.up', { pool })}>↑</button>
                        <button type="button" className="rounded px-1 text-fg-muted hover:bg-surface-raised disabled:opacity-30"
                          disabled={!ready || i === chain.length - 1} onClick={() => move(i, 1)}
                          aria-label={t('agents.run.poolChain.down', { pool })}>↓</button>
                      </>
                    )}
                    <button type="button" className="rounded px-1 text-fg-muted hover:bg-surface-raised disabled:opacity-30"
                      disabled={!ready} onClick={() => onChange(chain.filter((p) => p !== pool))}
                      aria-label={t('agents.run.poolChain.remove', { pool })}>✕</button>
                  </span>}
                </div>
                {!locked && entry && entry.accounts.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-6 text-fg-muted">
                    {entry.accounts.map((a) => <AccountUsage key={a.account} a={a} />)}
                  </div>
                )}
                {entry?.status === 'missing' && (
                  <p className="mt-0.5 pl-6 text-fg-subtle">{t('agents.run.poolChain.missingNote')}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {/* 더 넣을 풀이 없으면 자리를 비우지 않고 이유를 한 줄 남긴다(designer n2) — 비면 "추가 기능이 없다"로 읽힌다. */}
      {!locked && addable.length === 0 && chain.length > 0 && (
        <p className="text-meta text-fg-subtle" data-testid="agent-pool-chain-add-none">
          {chain.length >= MAX_AGENT_POOLS
            ? t('agents.run.poolChain.atLimit', { max: MAX_AGENT_POOLS })
            : t('agents.run.poolChain.allAdded')}
        </p>
      )}
      {!locked && addable.length > 0 && (
        <select
          className="rounded-md border border-border bg-surface px-2 py-1 text-meta text-fg-muted"
          aria-label={t('agents.run.poolChain.add')}
          data-testid="agent-pool-chain-add"
          disabled={!ready}
          value=""
          onChange={(e) => { if (e.target.value) onChange([...chain, e.target.value]); }}
        >
          <option value="">{t('agents.run.poolChain.add')}</option>
          {addable.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
    </div>
  );
}
