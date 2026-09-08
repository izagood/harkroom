import { useState } from 'react';
import { UPDATE_CHECK_INTERVAL_MS, useUpdateCheck } from '../lib/useUpdateCheck';

/**
 * 앱을 쓰는 **중에** 새 버전이 나온 것을 말하는 우측 하단 팝업.
 *
 * 로그인 전 배너(#526)가 푼 것은 "붙지 못해 업데이트도 못 하는" 막다른 길이었다. 이쪽은
 * 다른 문제다: 이 앱은 하루 종일 켜 두는 창이라, 시작할 때 한 번 확인하고 끝내면 그 사이에
 * 나온 버전을 **다음 재시작까지 모른다.**
 *
 * ## 왜 확인 실패는 띄우지 않는가
 *
 * 로그인 전 배너는 실패를 반드시 적는다 — 그 화면은 "최신"일 때도 아무것도 안 보이므로,
 * 실패까지 숨기면 두 상태가 화면상 구분되지 않기 때문이다.
 *
 * 여기서는 그 이유가 성립하지 않는다. 사람은 이미 앱 안에 있고 Settings 의 업데이트 화면이
 * 확인 실패를 정직하게 말한다. 그런데 작업 중에 **고칠 것도 없는** 실패 팝업을 띄우면
 * 그것이 곧 무시되는 알림이 되고, 그 다음부터는 진짜 알림도 함께 무시된다. 그래서 이
 * 자리는 "설치할 것이 있다"만 말한다.
 *
 * ## 닫기는 그 버전에 대한 답이다
 *
 * 닫으면 이 세션 동안 같은 버전으로는 다시 조르지 않는다 — 그러지 않으면 닫기가 6시간짜리
 * 미루기가 되어 하루에 몇 번씩 같은 팝업을 닫게 된다. 저장하지는 않으므로 앱을 다시 켜면
 * 다시 말한다. 다만 **더 새 버전**이 나오면 그때는 다시 말한다: 닫기를 "업데이트 알림을
 * 통째로 끈다"로 읽으면 그 다음 업데이트가 조용히 사라진다.
 */
export function UpdateToast() {
  const { status, install } = useUpdateCheck({ intervalMs: UPDATE_CHECK_INTERVAL_MS });
  /** 사람이 닫은 버전. 버전 문자열을 그대로 쥔다 — 우리가 semver 를 해석하지 않는다. */
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (status.kind !== 'available' && status.kind !== 'installing') return null;
  if (status.kind === 'available' && dismissed === status.version) return null;

  const installing = status.kind === 'installing';
  return (
    <div
      // `Notice` 의 `role="alert"` 보다 약하게 둔다 — 업데이트는 작업에 끼어들 일이 아니다.
      role="status"
      className="fixed bottom-4 right-4 z-50 flex w-72 items-center gap-2 rounded-lg border border-accent-brand bg-surface-raised px-3 py-2 shadow-lg"
    >
      <p className="min-w-0 flex-1 truncate text-body text-fg">
        {installing ? `Installing v${status.version}…` : `v${status.version} available`}
      </p>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install(status.version)}
        // 옆 문구가 이미 본문단 13px 이다 — 한 줄 안의 버튼을 아랫단으로 내리면 그 줄이
        // 두 단으로 갈린다. 이 팝업은 문구와 버튼 하나가 전부인 자리다.
        className="shrink-0 rounded bg-accent px-2 py-1 font-semibold text-fg-on-strong disabled:bg-transparent disabled:text-fg-subtle"
      >
        Update
      </button>
      <button
        type="button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(status.version)}
        className="shrink-0 rounded px-1 text-fg-muted hover:bg-surface-hover"
      >
        ×
      </button>
    </div>
  );
}
