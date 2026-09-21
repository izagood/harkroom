import { useActiveStore } from '../../state/communities';
import { getController } from '../../state/controller';
import { BANNER_TEXT_TONE, projectionBanner } from '../../lib/projectionBanner';
import { useAgo, useT } from '../../i18n/useT';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';
import { ProjectionUrl } from './ProjectionUrl';

/**
 * 투영이 지금 어떤 사정인가를 **이 화면에서** 말한다.
 *
 * ## 왜 여기인가
 *
 * 화면 위쪽 띠(`ProjectionBanner`)가 고장을 말하면서 `설정 열기` 를 내민다. 그 문 뒤에
 * 투영에 대한 말이 한 마디도 없으면 문은 열리지만 **아무 일도 없는 항목**이 된다
 * (`docs/design.md` §4). 실제로 그랬다(실측 2026-09-07): 띠를 눌러 들어온 설정 화면에
 * 투영이라는 낱말이 없었다.
 *
 * `Connection` 이 그 방인 이유: 이 화면은 "이 앱이 말을 거는 서버 하나" 를 말하는
 * 자리고, 투영은 **그 서버가 avcs 를 향해 돌리는 것**이다.
 *
 * ## 판정은 다시 하지 않는다
 *
 * 사정을 가르는 것은 `projectionBanner()` 한 벌이다(그 파일의 주석: 두 자리가 각자
 * 판정하면 반드시 갈라진다). 이 행은 **세 번째 판정자가 아니라 세 번째 독자**다.
 * `null` 은 "정상" 이라는 뜻이고, 그때만 이 행이 자기 문장을 쓴다 — 정상과 고장이 같은
 * 말이면 이 행은 아무것도 알려 주지 않는다.
 */
function ProjectionRow() {
  const status = useActiveStore((s) => s.projectionStatus);
  const error = useActiveStore((s) => s.projectionStatusError);
  const banner = projectionBanner({ status, error, ago: useAgo(), t: useT() });

  // 정상이다. **무엇을 보고 있는지**를 말한다 — "Running" 만으로는 어느 저장소를 향해
  // 돌고 있는지 알 수 없고, 엉뚱한 repo 를 보고 있는 것이 이 화면에서 안 보인다.
  const value = banner === null
    ? <span data-testid="projection-row">{status?.repo ?? '—'} · 투영이 돌고 있다</span>
    : (
      <span data-testid="projection-row" className={BANNER_TEXT_TONE[banner.tone]}>
        {banner.text}
        {/* 원문은 길 수 있다. 잘라 보여 주되 `title` 로 전문을 남긴다 — 띠와 같은 규칙. */}
        {banner.detail && <span className="ml-2 opacity-80" title={banner.detail}>{banner.detail}</span>}
      </span>
    );

  return <ReadonlyRow label="Projection" value={value} />;
}

export function ConnectionSettings({ onSignOut }: { onSignOut(): void }) {
  const connected = useActiveStore((s) => s.connected);
  // 보관된 값이 아니라 **지금 붙어 있는** 주소를 보여준다. 키체인 읽기가 비동기가 되면서
  // 렌더 중에 읽을 수 없게 됐고, 어차피 사용자가 알고 싶은 것은 실제 연결 대상이다.
  const baseUrl = getController().api.baseUrl || '—';

  return (
    <SettingsPage title="Connection" description="The harkroom server this app talks to.">
      <SettingsGroup>
        {/* #165: 이 행은 계속 **활성 커뮤니티**를 보여 준다. 이 기기가 아는 서버 전부를
            보는 자리는 Communities 다 — 여기서 목록을 또 그리면 같은 사실이 두 곳에 산다. */}
        <ReadonlyRow label="Server" value={baseUrl} />
        {/* #488 A3-a 후속: 투영 띠의 `설정 열기` 가 지목하는 자리다. */}
        <ProjectionRow />
        {/* 무엇을 바라볼 것인가. admin 이 아니면 이 조각이 스스로 null 을 그린다. */}
        <ProjectionUrl />
        <ReadonlyRow
          label="Realtime connection"
          value={
            <span className="inline-flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`} />
              <span data-testid="connection-state">{connected ? 'Connected' : 'Disconnected'}</span>
            </span>
          }
        />
      </SettingsGroup>

      {/* 러너 자동 기동 토글이 여기 있었다(#250). 러너는 이제 오퍼레이터가 서버의 배정을
          받아 띄우므로(스펙 2026-09-20 §2) 앱에 켜고 끌 것이 없다 — 그 자리는 설정의
          Operators 다. */}
      <SettingsGroup>
        {/* #165: 예전 문구는 "Use a different server / Sign out to enter another server
            address." 였다. (A) 아래서 그것은 **거짓 문장**이다 — 서버를 하나 더 붙이는
            것이 지금 쓰는 것을 버리는 일이 아니다. 그 자리를 커뮤니티 목록을 가리키는
            한 줄로 바꾸고, 로그아웃은 로그아웃이라고만 적는다. */}
        <div className="flex items-center gap-4 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-fg">Sign out of this community</span>
            <span className="mt-0.5 block text-fg-subtle">
              To use another server, add it in Settings › Communities — the switcher appears at the
              left of the sidebar once you are in more than one.
            </span>
          </span>
          <button
            className="shrink-0 rounded-lg border border-border px-3 py-1.5 font-medium hover:bg-surface"
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}
