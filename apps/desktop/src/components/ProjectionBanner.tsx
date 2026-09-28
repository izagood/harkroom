import { useActiveStore } from '../state/communities';
import type { SectionId } from './settings/sections';
import { projectionBanner } from '../lib/projectionBanner';
import { useAgo, useT } from '../i18n/useT';

/**
 * 고치는 문이 **지목하는 자리**. 투영은 "이 앱이 말을 거는 서버" 가 avcs 를 향해 돌리는
 * 것이므로 `Connection` 이 그 방이다(`sections.ts` 의 배치 이유와 같은 결).
 */
const PROJECTION_SECTION: SectionId = 'connection';

/**
 * 투영이 정상이 아니라는 것을 **화면 위쪽 띠**로 말한다(#488 A3-a).
 *
 * ## 왜 사이드바를 떠나는가
 *
 * 문서의 진단: 이 오류는 `ACTIVE WORK` 자리에서 **"설정 오류를 작업으로 그리고"** 있었다.
 * 사이드바의 그 칸은 "지금 무슨 일이 벌어지는가"를 말하는 자리인데, 거기 앉은 것은
 * 일이 아니라 **고장**이었다. 고치는 동작(설정 열기)도 그 좁은 칸에 들어가지 못했다.
 *
 * 띠로 올리면 두 가지가 풀린다: 고치는 동작이 띠 안에 들어가고, 사이드바의 그 칸이
 * **진짜 들어갈 것**(누가 누구를 기다리는가)을 위해 비워진다.
 *
 * ## 색은 강조색이 아니라 주의색이다
 *
 * 문서: *"급한 일과 고장이 같은 색이면 둘 다 안 보인다."* 강조색은 **나를 막는 말**에만
 * 쓰는 색이다(규칙 04). 투영이 꺼진 것은 급한 일이 아니라 고장이므로 주의색을 받는다.
 *
 * ## 닫을 수 있다 — 그러나 사정이 바뀌면 다시 선다
 *
 * 닫기를 **사정별로** 기억한다(`testid` 를 열쇠로). 투영이 꺼진 것을 닫아 뒀는데 그 뒤
 * 투영이 **멈추면** 그것은 다른 사실이므로 띠가 다시 선다. 한 번 닫은 것으로 이후의
 * 모든 고장을 덮으면, 닫기가 곧 **알림 끄기**가 된다.
 *
 * ## '확인하는 중'은 띠로 세우지 않는다
 *
 * 앱을 켤 때마다 잠깐 뜨는 띠는 정보가 아니라 깜빡임이고, 그 사이 화면이 한 줄 밀린다.
 * 그 사정은 `LeasePanel` 안에서만 말한다(`strip: false`).
 */
export function ProjectionBanner({ onOpenSettings }: {
  /**
   * **섹션을 받는 시그니처여야 한다.** `() => void` 로 두면 인자를 더 받는 실제 배선
   * (`App` 의 `(section, targetId) => …`)을 대입해도 타입이 통과하고, 그 뒤
   * `onClick={onOpenSettings}` 가 `MouseEvent` 를 섹션 자리에 흘려도 아무도 못 잡는다 —
   * 실제로 그렇게 새서 설정 화면이 통째로 비었다(실측 2026-09-07).
   */
  onOpenSettings?: (section?: SectionId) => void;
}) {
  const status = useActiveStore((s) => s.projectionStatus);
  const error = useActiveStore((s) => s.projectionStatusError);
  const dismissed = useActiveStore((s) => s.projectionBannerDismissed);

  // 훅은 조건 앞에서 부른다 — 아래 두 `return null` 보다 먼저여야 한다.
  const ago = useAgo();
  const t = useT();

  const banner = projectionBanner({ status, error, ago, t });
  if (!banner || !banner.strip) return null;
  // 같은 사정을 다시 세우지 않는다. 다른 사정이면 열쇠가 달라 다시 선다.
  if (dismissed === banner.testid) return null;

  const tone = banner.tone === 'danger'
    ? 'border-danger-border bg-danger-surface text-danger'
    : 'border-warning-border bg-warning-surface text-warning';

  return (
    <div
      role="alert"
      data-testid={`strip-${banner.testid}`}
      className={`flex items-start gap-2 border-b px-4 py-2 text-body ${tone}`}
    >
      <div className="flex-1">
        <span>{banner.text}</span>
        {banner.detail && (
          // 원문은 길 수 있다. 잘라서 보여 주되 `title` 로 전문을 남긴다 — 잘린 채로만
          // 두면 무엇이 잘못됐는지 화면에서 알 수 없다(#368 이 사이드바에서 겪은 것).
          <span className="ml-2 truncate opacity-80" title={banner.detail}>
            {banner.detail}
          </span>
        )}
      </div>
      {/* **고치는 동작이 띠 안에 붙는다**(문서). 좁은 칸에서는 이 문이 없었다. */}
      {onOpenSettings && (
        <button
          data-testid="projection-open-settings"
          className="shrink-0 rounded px-2 py-0.5 underline hover:bg-warning-surface-strong"
          // 함수를 그대로 넘기지 않는다 — React 가 첫 인자로 `MouseEvent` 를 준다.
          onClick={() => onOpenSettings?.(PROJECTION_SECTION)}
        >
          {t('projection.banner.openSettings')}
        </button>
      )}
      <button
        data-testid="projection-dismiss"
        aria-label={t('projection.banner.dismiss')}
        className="shrink-0 rounded px-1 hover:bg-warning-surface-strong"
        onClick={() => useActiveStore.getState().set({ projectionBannerDismissed: banner.testid })}
      >
        ×
      </button>
    </div>
  );
}
