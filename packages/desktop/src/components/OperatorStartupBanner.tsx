import { useActiveStore } from '../state/communities';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

/** 고치는 문이 지목하는 자리 — 설정 › 이 기기 › 이 기기의 오퍼레이터. */
export const OPERATOR_STARTUP_SECTION: SectionId = 'this-operator';

/**
 * 이 머신의 오퍼레이터를 **세우지 못했거나 등록하지 못한** 것을 화면 위쪽 띠로 말한다.
 *
 * 첫 설치에서 Node 를 못 찾아 오퍼레이터가 바로 죽거나 자동 등록이 실패하면, 앞 판본은 아무것도 말하지 않았다 —
 * 사람은 에이전트를 만들고 나서야 「아무도 답하지 않는다」로 알았다. 모양·닫기 규칙은 `ProjectionBanner` 와 같다
 * (주의색, 고치는 문이 띠 안에, 닫기는 사유별 — 사유가 바뀌면 다시 선다).
 */
export function OperatorStartupBanner({ onOpenSettings }: { onOpenSettings?: (section?: SectionId) => void }) {
  const issue = useActiveStore((s) => s.operatorStartupIssue);
  const dismissed = useActiveStore((s) => s.operatorStartupBannerDismissed);
  const t = useT();
  if (!issue) return null;
  const key = `${issue.kind}:${issue.reason}`;
  if (dismissed === key) return null;
  return (
    <div
      role="alert"
      data-testid="strip-operator-startup"
      className="flex items-start gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning"
    >
      <div className="flex-1 min-w-0">
        <span>{issue.kind === 'start' ? t('operatorStartup.banner.start') : t('operatorStartup.banner.register')}</span>
        {issue.reason && (
          <span className="ml-2 truncate opacity-80" title={issue.reason} data-testid="operator-startup-reason">
            {issue.reason}
          </span>
        )}
      </div>
      {onOpenSettings && (
        <button
          data-testid="operator-startup-open-settings"
          className="shrink-0 rounded-row px-2 py-0.5 underline hover:bg-warning-surface-strong"
          onClick={() => onOpenSettings?.(OPERATOR_STARTUP_SECTION)}
        >
          {t('operatorStartup.banner.openSettings')}
        </button>
      )}
      <button
        data-testid="operator-startup-dismiss"
        aria-label={t('operatorStartup.banner.dismiss')}
        className="shrink-0 rounded-sm px-1 hover:bg-warning-surface-strong"
        onClick={() => useActiveStore.getState().set({ operatorStartupBannerDismissed: key })}
      >
        {t('operatorStartup.banner.dismiss')} ×
      </button>
    </div>
  );
}
