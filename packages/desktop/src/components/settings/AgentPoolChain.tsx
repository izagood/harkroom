/**
 * 에이전트 설정 › 실행의 **계정 풀 순서 목록**(2026-10-15 풀 n개, designer 시안 pool_chain).
 *
 * 맨 위 상태 한 줄이 "지금 어느 풀을 왜 쓰나"를 말하고, 줄마다 칩(쓰는 중 / 소진·풀리는 시각 / 대기 /
 * 없음 / 빈 풀)과 계정별 사용량을 붙인다. 판정은 전부 `state`(`poolChainState`, 러너와 같은 식)에서
 * 온다 — 이 컴포넌트는 다시 재지 않는다. 그래서 리셋 시각이 지난 풀은 다시 재기 전이라도 칩이
 * "소진"으로 남지 않고(판정이 이미 풀렸다고 본다), 사용량을 모르는 계정은 「?」로 그린다.
 *
 * 순서는 ↑↓ 버튼으로 바꾼다(키보드·스크린리더로도 된다). 줄이 하나면 ↑↓ 는 그리지 않는다.
 * 계정 이름만 보인다 — 이메일·경로는 이 화면에 싣지 않는다.
 */
import type { PoolChainAccount, PoolChainEntry, PoolChainState } from '@harkroom/shared/claudePoolChain';
import { MAX_AGENT_POOLS } from '@harkroom/shared/claudePools';

import { useLocale, useT } from '../../i18n/useT';

function clock(ms: number, locale: string): string {
  return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
}

type Chip = 'active' | 'exhausted' | 'waiting' | 'missing' | 'empty';

function chipOf(entry: PoolChainEntry, i: number, state: PoolChainState): Chip {
  if (state.activeIndex === i) return 'active';
  if (entry.status === 'available') return 'waiting';
  return entry.status;
}

const CHIP_CLASS: Record<Chip, string> = {
  active: 'bg-accent-surface text-accent',
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
          <span className={`absolute inset-y-0 left-0 ${a.hot ? 'bg-danger' : 'bg-accent'}`}
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
  chain, pools, defaultPool, state, ready, onChange,
}: {
  chain: readonly string[];
  /** 이 기기에 있는 풀. */
  pools: readonly string[];
  defaultPool: string | null;
  state: PoolChainState | null;
  ready: boolean;
  onChange(next: string[]): void;
}) {
  const t = useT();
  const locale = useLocale();
  const move = (i: number, d: -1 | 1) => {
    const next = [...chain];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    onChange(next);
  };
  // 상한(security n3)에 닿으면 더 넣을 수 없다 — 오퍼레이터가 거절할 쓰기를 화면이 만들지 않는다.
  const addable = chain.length >= MAX_AGENT_POOLS ? [] : pools.filter((p) => !chain.includes(p));

  let status: string | null = null;
  if (!chain.length) {
    status = defaultPool
      ? t('agents.run.poolChain.statusDefaultNamed', { pool: defaultPool })
      : t('agents.run.poolChain.statusDefault');
  } else if (state) {
    const i = state.activeIndex;
    if (i === null) {
      status = t('agents.run.poolChain.statusNone');
    } else if (state.allExhausted) {
      const e = state.entries[i]!;
      status = e.unblockAtMs !== null
        ? t('agents.run.poolChain.statusAllOut', { n: i + 1, pool: e.pool, time: clock(e.unblockAtMs, locale) })
        : t('agents.run.poolChain.statusAllOutUnknown', { n: i + 1, pool: e.pool });
    } else if (i === 0) {
      status = t('agents.run.poolChain.statusFirst', { pool: state.entries[0]!.pool });
    } else {
      // 앞 풀 중 가장 먼저 풀리는 것 — 그때 새 스레드부터 앞으로 돌아온다(D3).
      const back = state.entries.slice(0, i).map((e) => e.unblockAtMs).filter((v): v is number => v !== null);
      const pool = state.entries[i]!.pool;
      status = back.length
        ? t('agents.run.poolChain.statusFallback', { n: i + 1, pool, time: clock(Math.min(...back), locale) })
        : t('agents.run.poolChain.statusFallbackUnknown', { n: i + 1, pool });
    }
  }

  return (
    <div className="mt-1 space-y-1.5" data-testid="agent-pool-chain">
      {status && (
        <p className="text-meta text-fg-muted" role="status" data-testid="agent-pool-chain-status">{status}</p>
      )}
      {chain.length > 0 && (
        <ol className="space-y-1">
          {chain.map((pool, i) => {
            const entry = state?.entries[i];
            const chip = entry && state && chain.length > 0 ? chipOf(entry, i, state) : null;
            return (
              <li key={pool} data-testid={`agent-pool-chain-row-${pool}`}
                className="rounded-md border border-border px-2 py-1.5 text-meta">
                <div className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-right tabular-nums text-fg-subtle">{i + 1}</span>
                  <span className="min-w-0 truncate font-medium text-fg">{pool}</span>
                  {chip && entry && (
                    <span data-testid={`agent-pool-chain-chip-${pool}`}
                      className={`shrink-0 rounded-sm px-1 ${CHIP_CLASS[chip]}`}>
                      {chip === 'exhausted' && entry.unblockAtMs !== null
                        ? t('agents.run.poolChain.chipExhaustedAt', { time: clock(entry.unblockAtMs, locale) })
                        : t(`agents.run.poolChain.chip.${chip}`)}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
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
                  </span>
                </div>
                {entry && entry.accounts.length > 0 && (
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
      {addable.length > 0 && (
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
