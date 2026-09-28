/**
 * MCP 프리셋 — 에이전트 상세 MCP 절의 [추가] 가 고르는 목록(1차: 확인한 것만).
 *
 * 값은 각 서비스의 **공식 Claude 플러그인 `.mcp.json`** 에서 그대로 옮겼다(2026-09-28). Slack 은
 * 등록된 OAuth 클라이언트를 요구해 `oauth` 가 있어야 한다(없으면 인증 화면이 뜨지 않는다).
 * 인증 토큰은 claude 계정 디렉터리의 키체인에 **서버 이름**을 키로 남으므로, 이름을 바꾸면
 * 다시 인증해야 한다 — 프리셋 이름은 고정해 둔다.
 *
 * 앱은 http·sse 만 넣는다(stdio 는 오퍼레이터가 거절한다, #431).
 */
import type { OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';

export interface McpPreset {
  id: string;
  /** 레지스트리·정의에 쓰는 이름. */
  name: string;
  label: string;
  credentialKind: 'community' | 'personal';
  definition: OperatorMcpRemoteDefinition;
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: 'slack', name: 'slack', label: 'Slack', credentialKind: 'personal',
    definition: { type: 'http', url: 'https://mcp.slack.com/mcp', oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 } },
  },
  {
    id: 'jira', name: 'jira', label: 'Jira · Confluence (Atlassian)', credentialKind: 'personal',
    definition: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' },
  },
];
