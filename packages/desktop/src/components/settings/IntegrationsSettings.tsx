import { useActiveStore } from '../../state/communities';
import { BANNER_TEXT_TONE, projectionBanner } from '../../lib/projectionBanner';
import { useAgo, useT } from '../../i18n/useT';
import { ReadonlyRow, SettingsGroup, SettingsPage } from './primitives';
import { ProjectionUrl } from './ProjectionUrl';
import { McpServersSection } from './McpServersSettings';

/**
 * 설정 › 워크스페이스 › **연동**(UX ⑥b-4). 워크스페이스가 바깥 도구와 잇는 두 가지를 한 페이지에 둔다:
 *
 * 1. **avcs 투영** — 전에는 이 기기 묶음의 `Connection` 에 있었다. 투영 띠(`ProjectionBanner`)와
 *    Collab 의 [avcs 연결 설정 열기] 가 이 페이지를 지목한다(②의 두 버튼 목적지).
 * 2. **MCP 서버** — 전에는 따로 한 페이지(`mcp-servers`)였다.
 *
 * 둘 다 "모든 멤버에게 걸리는 바깥 연결" 이라 같은 묶음·같은 페이지다.
 */
/**
 * 투영이 지금 어떤 사정인가를 **이 화면에서** 말한다(`Connection` 에서 옮겨 왔다 — UX ⑥b-4).
 *
 * ## 왜 여기인가
 *
 * 화면 위쪽 띠(`ProjectionBanner`)가 고장을 말하면서 `설정 열기` 를 내민다. 그 문 뒤에
 * 투영에 대한 말이 한 마디도 없으면 문은 열리지만 **아무 일도 없는 항목**이 된다
 * (`docs/design.md` §4). 실제로 그랬다(실측 2026-09-07): 띠를 눌러 들어온 설정 화면에
 * 투영이라는 낱말이 없었다.
 *
 * **연동** 이 그 방인 이유: 투영은 서버가 avcs 를 향해 돌리는 것이고, 모든 멤버의 Collab 이 그것을
 * 읽는다 — 이 기기 하나의 설정(`Connection`)이 아니라 워크스페이스 전체의 것이다(UX ⑥b-4,
 * designer 사양 ⑥ "연동(avcs 투영 · MCP 서버)").
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
  const t = useT();
  const banner = projectionBanner({ status, error, ago: useAgo(), t });

  // 정상이다. **무엇을 보고 있는지**를 말한다 — "Running" 만으로는 어느 저장소를 향해
  // 돌고 있는지 알 수 없고, 엉뚱한 repo 를 보고 있는 것이 이 화면에서 안 보인다.
  //
  // **꺼짐은 상태 한 마디다**(designer ②-a). 설명("Collab 이 비어 있다")은 띠와 Collab 카드가
  // 이미 한다 — 이 줄까지 그 문장을 주황으로 되풀이하면, 바로 아래 주소 칸의 상태 줄과 같은
  // 말을 두 번 한다. 고칠 곳은 이 줄 아래 칸이므로 이 줄은 회색 "꺼짐" 이면 된다.
  const value = banner === null
    ? <span data-testid="projection-row">{t('connection.projectionRunning', { repo: status?.repo ?? '—' })}</span>
    : banner.testid === 'projection-unconfigured'
      ? <span data-testid="projection-row" className="text-fg-muted">{t('projection.row.off')}</span>
      : (
      <span data-testid="projection-row" className={BANNER_TEXT_TONE[banner.tone]}>
        {banner.text}
        {/* 원문은 길 수 있다. 잘라 보여 주되 `title` 로 전문을 남긴다 — 띠와 같은 규칙. */}
        {banner.detail && <span className="ml-2 opacity-80" title={banner.detail}>{banner.detail}</span>}
      </span>
    );

  return <ReadonlyRow label={t('connection.projection')} value={value} />;
}

export function IntegrationsSettings() {
  const t = useT();
  return (
    <SettingsPage section="integrations" description={t('settings.desc.integrations')}>
      <SettingsGroup title={t('integrations.projection')}>
        {/* #488 A3-a 후속: 투영 띠의 `설정 열기` 가 지목하는 자리다. */}
        <ProjectionRow />
        {/* 무엇을 바라볼 것인가. admin 이 아니면 이 조각이 스스로 null 을 그린다. */}
        <ProjectionUrl />
      </SettingsGroup>
      <McpServersSection />
    </SettingsPage>
  );
}
