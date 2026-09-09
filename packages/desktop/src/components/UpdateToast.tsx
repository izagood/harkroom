import { useState } from 'react';
import { UPDATE_CHECK_INTERVAL_MS, useUpdateCheck } from '../lib/useUpdateCheck';

/**
 * 앱을 쓰는 **중에** 새 버전이 나온 것을 말하는 좌측 하단 팝업.
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
      /*
       * **우측 하단이 아니다.** 그 자리에는 컴포저의 `전송` 이 있었고, 이 팝업이 그것을
       * 덮었다 — 업데이트는 급한 일이 아닌데 지금 쓰던 글을 보내는 것을 막았다. 우측
       * 하단은 이 창에서 비어 있는 구석이 아니다.
       *
       * 그래서 사이드바 칸의 왼쪽 아래로 옮겼다. 그쪽은 칸 목록의 끝이라 대개 비어
       * 있고, 무엇을 가리더라도 그것이 "지금 하던 일"인 경우가 없다.
       *
       * 좌표는 **`Workspace` 의 폭 0 앵커**(레일 바로 오른쪽)에 매단다. `fixed
       * left-[…]` 로 레일 폭을 여기에 다시 적지 않는다 — 레일은 62px 이지만 커뮤니티가
       * 둘 이상이면 그 왼쪽에 56px 이 하나 더 서므로(`CommunityRail`), 못 박은 숫자는
       * 그 상태에서 팝업을 레일 위로 올려 놓는다. 흐름 안의 앵커는 두 경우 모두 맞다.
       *
       * ## 폭을 못 박지 않는다 (2026-09-09)
       *
       * 앞판은 `w-72`(288px) 고정이었다. 그런데 사이드바는 **180px 까지 좁혀진다**
       * (`MIN_SIDEBAR_WIDTH`) — 즉 좁힌 창에서 이 팝업은 사이드바를 108px 넘어 본문
       * 위로 올라앉았다. 자리를 왼쪽으로 옮겨 `전송` 을 비켜 준 판단이, 폭을 숫자로
       * 적어 둔 탓에 반쪽이 된 것이다. 레일 폭을 여기 베끼지 않는 것과 같은 이유로
       * **사이드바 폭도 베끼지 않는다**: 폭은 내용이 정하게 두고(절대 위치라 내용
       * 폭으로 줄어든다), 병적으로 긴 버전 문자열만 `max-w-*` 로 막는다.
       *
       * ## 강조 장치를 넷에서 둘로 줄인다
       *
       * 앞판은 알림 하나에 **주황 테두리 · 주황으로 채운 버튼 · 떠 있는 면 · 큰 그림자**
       * 를 다 썼다. 이 팝업은 나를 막지 않는다 — 업데이트는 지금 안 해도 되는 일이다.
       * 그래서 남기는 것은 **점 하나**(`accent-brand` 는 `index.css` 가 *"글자를 얹지
       * 않는 자리 — 선, 상태 점"* 으로 정의해 둔 자리다)와 **글자 강조 하나**뿐이고,
       * 테두리는 여느 면과 같은 `border-border` 로 돌린다.
       */
      className="absolute bottom-3 left-2 z-50 flex items-center gap-1.5 rounded-full border border-border bg-surface-raised py-1 pl-2.5 pr-1 shadow-sm"
    >
      {/* 상태 점. 읽는 글자가 아니므로 이름을 주지 않는다 — 옆 글자가 이미 그 말을 한다. */}
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-accent-brand" />
      {/*
        한 줄이 통째로 아랫단(`text-meta` 11px)으로 내려왔다. 앞판의 주석이 막으려던 것은
        **한 줄 안에서 단이 갈리는 것**이고(문구는 본문단인데 버튼만 아랫단), 그것은 여기서도
        그대로 지킨다 — 문구·버튼·닫기가 모두 같은 단이다. 자리가 사이드바 칸의 발치이므로
        척도의 정의(*"로우·상태·시간 — 사이드바 전체"*)와도 그쪽이 맞다.

        버전 문자열은 GitHub 릴리즈에서 그대로 온다 — 우리가 길이를 정하지 않으므로 폭을
        막고 잘라 낸다. `title` 로 원문은 남긴다.
      */}
      <p className="min-w-0 max-w-32 truncate text-meta text-fg" title={`v${status.version}`}>
        {`v${status.version}`}
        {/*
          화면에서는 점과 `Update` 가 이미 무슨 일인지 말하지만, `role="status"` 를 읽는
          쪽에는 버전 번호만 남는다 — 한 마디를 소리로만 남긴다.

          Tailwind 의 `sr-only` 는 `position: absolute` 다(`Identity` 가 이것으로 데였다).
          여기는 껍데기 자신이 `absolute` 라 컨테이닝 블록이 이미 있으므로 문서 높이로
          새지 않는다.
        */}
        <span className="sr-only">{installing ? ' installing' : ' available'}</span>
      </p>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install(status.version)}
        /*
          채운 면이 아니라 **글자 버튼**이다 — `Composer` 의 글자 동작 버튼들과 같은 어휘를
          그대로 쓴다(`text-accent` + `hover:bg-surface-hover`). 강조 예산 문서가 강조색
          글자를 회수하면서 *"링크는 예외"* 로 남겨 둔 축이 이쪽이고, 이 팝업에서 읽고
          누르는 것은 이 한 마디뿐이다.
        */
        className="shrink-0 rounded px-1.5 py-0.5 text-meta font-semibold text-accent hover:bg-surface-hover disabled:text-fg-subtle disabled:hover:bg-transparent"
      >
        {installing ? 'Installing\u2026' : 'Update'}
      </button>
      <button
        type="button"
        aria-label="Dismiss update notice"
        onClick={() => setDismissed(status.version)}
        className="shrink-0 rounded px-1 text-meta text-fg-muted hover:bg-surface-hover"
      >
        ×
      </button>
    </div>
  );
}
