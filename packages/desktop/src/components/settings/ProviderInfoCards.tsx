/**
 * 제공업체 계정 화면의 **OpenCode·Cursor 카드 — 표시만 한다**(2026-09-29, 계획 ③).
 *
 * 계정 추가·재인증·턴 적용·사용량 폴링이 **없다.** 두 하네스에는 그 표면(데몬 RPC·계정 디렉터리)이
 * 아직 없고, 없는 것을 버튼으로 그리면 누른 사람이 고장으로 읽는다. 그래서 카드는 두 가지만 말한다:
 * 지금 무엇으로 도는가(하네스 자신의 로그인), 그리고 여기서 관리하지 않는다는 사실.
 *
 * - OpenCode: 러너가 돌리는 하네스다. 로그인은 opencode 자신의 것(`opencode auth login`)을 그대로 쓴다.
 * - Cursor: 러너 하네스가 아니다(팀 정책이 커스텀 MCP 를 막아 harkroom MCP 를 못 붙인다). 공급자
 *   대시보드로 가는 링크만 둔다 — 사용량은 거기서 본다.
 *
 * 데몬을 부르지 않으므로 이 파일은 `invoke` 를 쓰지 않는다. 계정 값(이메일·조직)도 읽지 않는다.
 */
import { useT } from '../../i18n/useT';
import { getExternalOpener } from '../../lib/openExternal';
import { ProviderSection } from './ProviderSection';

export const CURSOR_DASHBOARD_URL = 'https://cursor.com/dashboard';

/** 시스템 기본값 한 줄 + "여기서 관리하지 않는다" 점선 칸. Codex 카드의 빈 상태와 같은 모양이다. */
function DisplayOnlyBody({ system, note, testId }: { system: string; note: string; testId: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="rounded-card border border-border px-4 py-3">
        <div className="font-medium text-fg">{t('providerAccounts.systemDefault')}</div>
        <div className="text-fg-subtle">{system}</div>
      </div>
      <div className="rounded-card border border-dashed border-border px-4 py-3 text-fg-subtle">{note}</div>
    </div>
  );
}

export function OpenCodeAccountsCard() {
  const t = useT();
  return (
    <ProviderSection icon="opencode" title="OpenCode" description={t('providerAccounts.opencode.description')} testId="provider-opencode">
      <DisplayOnlyBody
        system={t('providerAccounts.opencode.system')}
        note={t('providerAccounts.displayOnly')}
        testId="opencode-display-only"
      />
    </ProviderSection>
  );
}

export function CursorAccountsCard() {
  const t = useT();
  return (
    <ProviderSection icon="cursor" title="Cursor" description={t('providerAccounts.cursor.description')} testId="provider-cursor">
      <DisplayOnlyBody
        system={t('providerAccounts.cursor.system')}
        note={t('providerAccounts.cursor.note')}
        testId="cursor-display-only"
      />
      <div className="mt-3">
        <a
          className="text-meta text-accent underline"
          href={CURSOR_DASHBOARD_URL}
          onClick={(e) => { e.preventDefault(); void getExternalOpener().open(CURSOR_DASHBOARD_URL); }}
        >
          {t('providerAccounts.cursor.dashboard')}
        </a>
      </div>
    </ProviderSection>
  );
}
