import { useUpdateCheck } from '../lib/useUpdateCheck';

/**
 * 로그인 **전** 화면의 업데이트 배너.
 *
 * ## 왜 로그인 전에 있어야 하는가 (실측 2026-09-07)
 *
 * 설치본 0.1.7 은 평문 http 서버에 붙지 못했다(macOS ATS 가 요청을 내보내지 않는다).
 * 고친 버전은 이미 릴리즈에 있었지만 업데이트 UI 가 로그인 뒤 Settings 에만 있어서
 * 고리가 닫혀 있었다:
 *
 *   서버에 못 붙는다 → 업데이트해야 한다 → 업데이트는 로그인 뒤에 있다 → 못 붙는다
 *
 * 업데이터는 GitHub releases 만 보고 murmur 서버와 무관하다(`appUpdater.ts` 에
 * `baseUrl`·`token` 참조가 없다). 로그인 뒤에만 있어야 할 이유가 애초에 없었다.
 *
 * 확인·설치는 `useUpdateCheck` 가 한다 — 이 파일이 정하는 것은 **그 상태를 어떻게
 * 보여 줄지**뿐이다.
 *
 * ## 이 자리의 규칙: **"확인 실패"를 "최신"으로 합치지 않는다**
 *
 * `UpdatesSettings` 가 세운 규칙을 그대로 물려받는다. 다만 여기서는 그것이 더 미끄럽다:
 * 최신일 때 **아무것도 렌더하지 않는** 화면이므로, 실패도 숨기면 두 상태가 화면상
 * 구분되지 않는다 — 문구를 고치지 않아도 배치만으로 같은 거짓말이 된다. 그래서 실패는
 * 반드시 한 줄 적는다. 로그인 화면이 조금 시끄러워지는 것이 그 대가다.
 *
 * 같은 이유로 사유는 지어내지 않는다. 네트워크인지 서명인지 릴리즈 JSON 인지 우리는
 * 모르고 플러그인도 그 구분을 주지 않으므로, 원문을 그대로 붙인다.
 *
 * **`UpdateToast` 는 반대로 실패를 띄우지 않는다** — 그 자리는 사람이 이미 앱 안에 있어
 * Settings 가 실패를 말해 주고, 작업 중의 무력한 경고는 곧 무시되기 때문이다. 두 화면의
 * 판단이 갈리는 유일한 지점이고, 그래서 이 갈림이 훅이 아니라 화면 쪽에 있다.
 */
export function ConnectUpdateBanner() {
  // 주기 확인을 걸지 않는다 — 로그인 화면은 오래 머무는 자리가 아니다.
  const { status, install } = useUpdateCheck();

  // 최신과 확인 전에는 자리 자체가 없다 — 로그인 화면이 평소와 똑같이 보인다.
  if (status.kind === 'idle' || status.kind === 'uptodate') return null;

  if (status.kind === 'failed') {
    return (
      <div className="rounded border border-warning-border bg-warning-surface px-3 py-2">
        {/* 빨강(danger)을 쓰지 않는다 — 그 색은 이 화면에서 이미 로그인 실패가 쓴다.
            같은 색이면 '서버 문제'와 '업데이트 확인 문제'가 한 화면에서 구분되지 않는다. */}
        {/* 사유 한 줄은 읽는 글자이므로 본문단(앱 기본값 13px)이고, 그 아래 등폭 원문은
            이미 아랫단 11px 이다 — 사람이 먼저 읽는 것과 필요할 때만 보는 것이 갈린다. */}
        <p className="font-medium text-warning">Could not check for updates</p>
        <p className="truncate font-mono text-meta text-fg-muted" title={status.message}>
          {status.message}
        </p>
      </div>
    );
  }

  const installing = status.kind === 'installing';
  return (
    <div className="flex items-center gap-2 rounded border border-accent-brand bg-accent-surface px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-fg">
        {installing ? `Installing v${status.version}…` : `v${status.version} available`}
      </p>
      <button
        type="button"
        disabled={installing}
        onClick={() => void install(status.version)}
        className="rounded bg-accent px-2 py-1 font-semibold text-fg-on-strong disabled:bg-transparent disabled:text-fg-subtle"
      >
        Update
      </button>
    </div>
  );
}
