import { MIN_SERVER_VERSION, serverCompat } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import type { SectionId } from './settings/sections';
import { useT } from '../i18n/useT';

/** 고치는 문이 **지목하는 자리**. 서버 목록과 그 버전이 사는 방이다. */
const COMPAT_SECTION: SectionId = 'communities';

/**
 * **이 서버에서는 이 앱이 제대로 돌지 않는다**고 말하는 띠(#693 후속).
 *
 * ## 왜 설정 안에만 두지 않는가
 *
 * 버전 줄은 설정 → Communities 에 있다. 그런데 **사람은 무언가 이상할 때 설정을 열지
 * 않는다** — 눌러도 아무 일이 없는 버튼을 보고 자기가 잘못 눌렀다고 생각한다. 이 저장소가
 * 반복해서 잡아 온 결함이 정확히 그 모양이다. 서버가 호환 하한보다 낮다는 것은 **지금
 * 기능이 죽어 있다**는 뜻이므로, 사람이 찾아오기를 기다리지 않고 화면이 먼저 말한다
 * (투영 고장이 `ACTIVE WORK` 를 떠나 띠가 된 것과 같은 판단, #488 A3-a).
 *
 * ## 서는 사정은 **하나뿐**이다
 *
 * 하한보다 낮을 때만 선다. "앱보다 뒤처졌다"로는 서지 않는다 — 그것은 거의 **항상** 참이라
 * (릴리스는 하루에도 여러 번 돌고 서버는 손으로 재배포한다) 띠가 상시로 서고, 상시로 서는
 * 띠는 사람이 읽지 않고 닫는 법을 먼저 배운다. 그 순간 이 표면 전체가 죽는다.
 *
 * ## 활성 커뮤니티만 본다
 *
 * 띠는 지금 보고 있는 세계에 대한 말이다. 목록의 다른 커뮤니티까지 여기서 말하면 "어느
 * 서버 이야기인가"를 띠 안에서 다시 설명해야 하고, 그 자리는 설정의 **줄마다** 이미 있다.
 */
export function ServerCompatBanner({ onOpenSettings }: {
  /**
   * `ProjectionBanner` 와 **같은 시그니처여야 한다** — `() => void` 로 두면 실제 배선
   * (`App` 의 `(section, targetId) => …`)이 대입돼도 타입이 통과하고, `onClick` 이
   * `MouseEvent` 를 섹션 자리에 흘려도 아무도 못 잡는다(실측 2026-09-07).
   */
  onOpenSettings?: (section?: SectionId) => void;
}) {
  const serverVersion = useActiveStore((s) => s.serverVersion);
  const dismissed = useActiveStore((s) => s.serverCompatBannerDismissed);
  // 훅은 조건 앞에서 부른다 — 아래 `return null` 들보다 먼저여야 한다.
  const t = useT();

  const version = serverVersion?.version ?? null;
  // `unknown`(못 받았다·견줄 수 없다) 으로는 서지 않는다. 모르는 것을 고장이라고 말하면
  // 자체 빌드로 띄운 서버마다 띠가 선다 — 그리고 그것은 **틀린 말**이다.
  if (serverCompat(version) !== 'too-old' || version === null) return null;
  if (dismissed === version) return null;

  return (
    <div
      role="alert"
      data-testid="strip-server-incompatible"
      className="flex items-start gap-2 border-b border-danger-border bg-danger-surface px-4 py-2 text-body text-danger"
    >
      <div className="flex-1">
        <span className="font-medium">{t('community.compat.bannerText', { version })}</span>
        <span className="ml-2 opacity-80">
          {t('community.compat.bannerDetail', { minVersion: MIN_SERVER_VERSION })}
        </span>
      </div>
      {/* **고치는 동작이 띠 안에 붙는다.** 어디를 봐야 하는지까지 말해야 띠가 일을 한다. */}
      {onOpenSettings && (
        <button
          data-testid="server-compat-open-settings"
          className="shrink-0 rounded px-2 py-0.5 underline hover:bg-danger-surface"
          // 함수를 그대로 넘기지 않는다 — React 가 첫 인자로 `MouseEvent` 를 준다.
          onClick={() => onOpenSettings?.(COMPAT_SECTION)}
        >
          {t('community.compat.bannerOpen')}
        </button>
      )}
      <button
        data-testid="server-compat-dismiss"
        aria-label={t('community.compat.bannerDismiss')}
        className="shrink-0 rounded px-1 hover:bg-danger-surface"
        // **그 버전에 대해서만** 닫는다. 재배포했는데 아직도 모자라면 다시 선다.
        onClick={() => useActiveStore.getState().set({ serverCompatBannerDismissed: version })}
      >
        ×
      </button>
    </div>
  );
}
