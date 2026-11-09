import { useActiveStore } from '../state/communities';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';
import type { OperatorStartupIssue } from '../state/appStore';

/** 고치는 문이 지목하는 자리 — 설정 › 이 기기 › 이 기기의 오퍼레이터. */
export const OPERATOR_STARTUP_SECTION: SectionId = 'this-operator';

/**
 * 이 머신의 오퍼레이터를 **세우지 못했거나 등록하지 못한** 것을 화면 위쪽 띠로 말한다.
 *
 * 첫 설치에서 Node 를 못 찾아 오퍼레이터가 바로 죽거나 자동 등록이 실패하면, 앞 판본은 아무것도 말하지 않았다 —
 * 사람은 에이전트를 만들고 나서야 「아무도 답하지 않는다」로 알았다. 모양·닫기 규칙은 `ProjectionBanner` 와 같다
 * (주의색, 고치는 문이 띠 안에, 닫기는 사유별 — 사유가 바뀌면 다시 선다).
 */
/**
 * [나중에] 가 기억하는 키 — **사유의 머리**만 쓴다.
 *
 * 앱(Rust)이 내는 사유는 한 줄 문단 끝에 괄호로 바뀌는 값(오퍼레이터 로그 끝줄·그때의 PATH·원문 오류)을 단다.
 * 사유 전체를 키로 쓰면 재접속마다 그 값이 바뀌어 닫은 띠가 다시 섰다(designer nit). 그래서 첫 줄의
 * 첫 `(` 앞까지(최대 120자)를 머리로 삼는다 — 다른 종류의 실패면 머리가 달라 다시 선다.
 */
export function startupDismissKey(issue: OperatorStartupIssue): string {
  const firstLine = issue.reason.split('\n')[0] ?? '';
  const head = firstLine.split('(')[0]!.trim().slice(0, 120);
  return `${issue.kind}:${head}`;
}

export function OperatorStartupBanner({ onOpenSettings }: { onOpenSettings?: (section?: SectionId) => void }) {
  const issue = useActiveStore((s) => s.operatorStartupIssue);
  const dismissed = useActiveStore((s) => s.operatorStartupBannerDismissed);
  const t = useT();
  if (!issue) return null;
  const key = startupDismissKey(issue);
  if (dismissed === key) return null;
  return (
    <div
      role="alert"
      data-testid="strip-operator-startup"
      className="flex items-start gap-2 border-b border-warning-border bg-warning-surface px-4 py-2 text-body text-warning"
    >
      <div className="flex-1 min-w-0">
        <p className="break-keep">{issue.kind === 'start' ? t('operatorStartup.banner.start') : t('operatorStartup.banner.register')}</p>
        {/* 실제 사유는 300자 넘는 문단(경로·PATH 통째)이다 — 둘째 줄 한 줄로 자르고 전문은 title·설정 화면에서 본다. */}
        {issue.reason && (
          <span className="block truncate text-meta opacity-80" title={issue.reason} data-testid="operator-startup-reason">
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
