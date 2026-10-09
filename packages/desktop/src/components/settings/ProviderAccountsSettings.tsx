/**
 * 설정 > **제공업체 계정**(2026-09-28). 하네스마다 한 칸이 세로로 쌓인다 — Claude, Codex, OpenCode·Cursor(표시만).
 *
 * 한 화면에 모은 이유: 계정은 "이 기기에서 어느 로그인으로 에이전트를 돌리나"라는 **한 질문**
 * 이고, 하네스마다 설정 항목을 따로 두면 사람은 codex 계정을 claude 화면 옆에서 찾지 못한다.
 * 섹션 id 는 `claude-accounts` 그대로다 — 저장된 마지막 섹션·딴 화면의 배선이 그 값을 들고 있다.
 */
import { useT } from '../../i18n/useT';
import { ClaudeAccountsSettings } from './ClaudeAccountsSettings';
import { CodexAccountsSettings } from './CodexAccountsSettings';
import { CursorAccountsCard, OpenCodeAccountsCard } from './ProviderInfoCards';
import { SettingsPage } from './primitives';

// 통째 문자열로 적는다 — 조각으로 이으면 Tailwind 가 CSS 를 만들지 않는다. `ProviderSection` 은 첫 칸의 위 여백을
// 지운다(`first:pt-0`) — 세로로 쌓일 때 맞는 규칙이라, 옆으로 서면 Codex 칸만 위로 솟는다. 격자 안에서는 첫 칸도 같은 여백이다.
const PROVIDER_GRID = 'grid grid-cols-1 items-start gap-x-4 [&>section:first-child]:pt-8 @min-[1100px]/settings:grid-cols-2 @min-[1700px]/settings:grid-cols-3';

export function ProviderAccountsSettings() {
  const t = useT();
  return (
    <SettingsPage section="claude-accounts" description={t('providerAccounts.page.subtitle')} layout="list">
      {/* Claude 는 계정끼리 숫자를 견주는 표라 꽉 찬 폭을 쓴다. 나머지 하네스 칸은 넓은 창에서 2·3단으로 선다
          (설정 폭 시안 v1 list) — 한 칸에 계정 몇 줄뿐이라 2200px 로 늘이면 이름과 단추가 멀어진다. */}
      <ClaudeAccountsSettings embedded />
      <div data-testid="provider-accounts-grid" className={PROVIDER_GRID}>
        <CodexAccountsSettings />
        <OpenCodeAccountsCard />
        <CursorAccountsCard />
      </div>
    </SettingsPage>
  );
}
