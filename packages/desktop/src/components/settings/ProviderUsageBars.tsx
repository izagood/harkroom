/**
 * 계정 줄 아래에 서는 **한도 막대 두 개**(5시간·주간) + 복귀 시각. 공급자가 말한 % 다 — CLI 로 읽었든
 * API 로 읽었든 출처가 같으므로 똑같이 그린다(`lib/providerUsage.ts`). 못 읽었으면 막대 대신 이유 한 줄 —
 * 빈 자리로 두면 "0%"로 읽힌다.
 *
 * 색: 90% 이상만 경고색. 강조색(주황)은 쓰지 않는다(`accentBudget.test.tsx` — 강조는 "나를
 * 막는 것"과 주 동작 하나로 좁혀 두었다). 한도에 가까운 것은 막을 뻔한 일이라 경고가 맞다.
 */
import { useLocale, useT } from '../../i18n/useT';
import type { ProviderAccountUsage, ProviderUsageWindow } from '../../lib/providerUsage';
import type { MessageKey } from '../../i18n/en';

const ERROR_KEY: Record<string, MessageKey> = {
  'cli-unavailable': 'providerUsage.error.cliUnavailable',
  'cli-unparsed': 'providerUsage.error.cliUnparsed',
  'cli-error': 'providerUsage.error.cliUnparsed',
  'no-credentials': 'providerUsage.error.noCredentials',
  'token-expired': 'providerUsage.error.tokenExpired',
  unauthorized: 'providerUsage.error.unauthorized',
};

function Bar({ label, w, nowMs }: { label: string; w: ProviderUsageWindow; nowMs: number }) {
  const t = useT();
  const locale = useLocale();
  const pct = Math.round(w.usedPercent);
  const reset = w.resetsAtMs === null
    ? null
    : new Intl.DateTimeFormat(locale, {
      ...(w.resetsAtMs - nowMs > 20 * 60 * 60 * 1000 ? { month: 'numeric', day: 'numeric' } : {}),
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(w.resetsAtMs));
  return (
    <div className="min-w-0 flex-1" data-testid="provider-usage-bar">
      <div className="flex items-baseline justify-between gap-2 text-meta">
        <span className="text-fg-muted">{label}</span>
        <span className="tabular-nums text-fg">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <div
          className={`h-full rounded-full ${pct >= 90 ? 'bg-warning' : 'bg-fg-muted'}`}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      {reset && <div className="mt-0.5 text-meta text-fg-subtle">{t('providerUsage.resetsAt', { time: reset })}</div>}
    </div>
  );
}

export function ProviderUsageBars({ usage, nowMs }: { usage: ProviderAccountUsage | null; nowMs: number }) {
  const t = useT();
  if (!usage) return null;
  if (usage.error) {
    const key = ERROR_KEY[usage.error];
    return (
      <div className="text-meta text-fg-subtle" data-testid="provider-usage-error">
        {key ? t(key) : t('providerUsage.error.other', { reason: usage.error })}
      </div>
    );
  }
  if (!usage.session && !usage.weekly) return null;
  return (
    <div className="flex items-start gap-6" data-testid="provider-usage">
      {usage.session && <Bar label={t('providerUsage.session')} w={usage.session} nowMs={nowMs} />}
      {usage.weekly && <Bar label={t('providerUsage.weekly')} w={usage.weekly} nowMs={nowMs} />}
      {usage.extra?.map((x) => <Bar key={x.label} label={x.label} w={x.window} nowMs={nowMs} />)}
    </div>
  );
}

/**
 * 첫 사용량 답을 기다리는 동안 막대 자리에 서는 **자리표시**(2026-10-01). 비워 두면 "한도 정보가 없는
 * 계정"으로 읽히고, 다 그려진 뒤 막대가 튀어나오며 줄이 밀린다 — 같은 높이의 회색 막대 둘로 자리를 잡는다.
 */
export function ProviderUsageSkeleton() {
  const t = useT();
  return (
    <div className="flex items-start gap-6" data-testid="provider-usage-skeleton" role="status" aria-label={t('providerUsage.loading')}>
      {[0, 1].map((i) => (
        <div key={i} className="min-w-0 flex-1" aria-hidden="true">
          <div className="h-3 w-16 animate-pulse rounded-row bg-border" />
          <div className="mt-1.5 h-1.5 animate-pulse rounded-full bg-border" />
        </div>
      ))}
    </div>
  );
}

/** 계정 목록 첫 답을 기다리는 동안의 줄 자리표시. 줄 수는 의미가 없다 — "아직 모른다"만 말한다. */
export function AccountRowsSkeleton({ rows = 2 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="space-y-3 px-4 py-3" data-testid="provider-accounts-skeleton" role="status" aria-label={t('providerAccounts.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4" aria-hidden="true">
          <div className="h-3.5 w-24 animate-pulse rounded-row bg-border" />
          <div className="h-3.5 flex-1 animate-pulse rounded-row bg-border" />
        </div>
      ))}
    </div>
  );
}

/**
 * 칸 머리의 **[Refresh usage]**(2026-10-09). 사용량은 1분 폴 + 데몬 2분 캐시라 사람이 "지금 값"을 보려면
 * 기다려야 했다 — 이 버튼은 캐시를 건너뛰고 새로 잰다(`useProviderUsage.refresh`). 누르는 동안 버튼이
 * 돌고 잠기며(연달아 눌러도 CLI 는 하나다), 옆에 값이 **언제 잰 것인지**를 적는다. 실패는 아래 한 줄로.
 */
export function UsageRefreshControl({ refreshing, updatedAtMs, error, onRefresh, testId }: {
  refreshing: boolean;
  updatedAtMs: number | null;
  error: string | null;
  onRefresh(): void;
  testId: string;
}) {
  const t = useT();
  const locale = useLocale();
  const time = updatedAtMs === null
    ? null
    : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(updatedAtMs));
  return (
    <div className="flex flex-col items-end gap-1" data-testid={testId}>
      <div className="flex items-center gap-3">
        {time && (
          <span className="text-meta text-fg-subtle" data-testid={`${testId}-updated`}>
            {t('providerUsage.updatedAt', { time })}
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
          className="flex items-center gap-1.5 rounded-row border border-border bg-surface-raised px-2.5 py-1 text-meta font-medium text-fg hover:bg-surface-hover disabled:opacity-60"
        >
          <span aria-hidden className={`inline-block leading-none ${refreshing ? 'animate-spin' : ''}`}>↻</span>
          {refreshing ? t('providerUsage.refreshing') : t('providerUsage.refresh')}
        </button>
      </div>
      {error && (
        <span role="alert" className="max-w-[28rem] text-right text-meta text-danger" data-testid={`${testId}-error`}>
          {t('providerUsage.refreshFailed', { reason: error })}
        </span>
      )}
    </div>
  );
}
