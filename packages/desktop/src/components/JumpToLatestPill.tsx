import { useT } from '../i18n/useT';

/**
 * 목록 바닥으로 돌아가는 떠 있는 알약 — 「↓ 최신 답글」 / 「↓ 새 답글 3」.
 *
 * 스레드 패널이 먼저 쓰고 채널도 같은 부품을 쓰기로 했다(designer 시안 v1 #6 — 한 앱에 모양이 둘이면
 * 같은 일을 두 번 배워야 한다). 그래서 문구는 부르는 쪽이 고른다: 스레드는 「답글」, 채널은 「글」.
 *
 * 평소엔 떠 있는 면(`surface-raised` + `shadow-float`)이고, **새 글이 있다는 사건**일 때만 강조 면이다.
 * 받는 중(`loading`)이면 누름을 막는다 — 같은 페이지를 두 번 받지 않는다.
 */
export function JumpToLatestPill({ label, newLabel, ariaLabel, ariaNewLabel, count, loading = false, onClick, testId }: {
  /** 새 글이 없을 때의 문구(「최신 답글」). */
  label: string;
  /** 새 글 수를 받는 문구 함수(「새 답글 3」). */
  newLabel: (count: string) => string;
  ariaLabel: string;
  ariaNewLabel: (count: number) => string;
  count: number;
  loading?: boolean;
  onClick: () => void;
  testId: string;
}) {
  const t = useT();
  const fresh = count > 0;
  // 99 를 넘으면 수를 줄인다 — 알약이 본문 쪽으로 자라 글을 가리지 않게(시안 #2).
  const shown = count > 99 ? '99+' : String(count);
  const tone = loading
    ? 'bg-surface-raised text-fg-muted'
    : fresh
      ? 'bg-accent text-fg-on-strong hover:bg-accent-hover'
      : 'bg-surface-raised text-fg hover:bg-surface-sunken';
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={fresh ? ariaNewLabel(count) : ariaLabel}
      aria-busy={loading || undefined}
      disabled={loading}
      onClick={onClick}
      className={`absolute bottom-3 right-4 inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full pl-2.5 pr-3 text-meta font-semibold shadow-float ${tone}`}
    >
      {loading
        ? <span aria-hidden="true" className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-fg-muted" />
        : (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        )}
      {/* 수가 바뀌면 화면 낭독기가 한 번 읽는다(시안 접근성 줄). */}
      <span role="status">{loading ? t('jumpLatest.loading') : fresh ? newLabel(shown) : label}</span>
    </button>
  );
}
