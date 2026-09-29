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

export function ProviderAccountsSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('providerAccounts.page.title')} description={t('providerAccounts.page.subtitle')} width="wide">
      <ClaudeAccountsSettings embedded />
      <CodexAccountsSettings />
      <OpenCodeAccountsCard />
      <CursorAccountsCard />
    </SettingsPage>
  );
}
