// claude-code harness — `claude -p` 를 서브프로세스로 띄운다.
//
// 왜 API 를 직접 부르지 않는가: 이 harness 의 이점이 도구·파일 접근이다. murmur 의 목적은
// 채널에서 진짜 작업이 벌어지는 것이고, 채팅 상담만 하는 에이전트로는 그 자리에 못 간다.
//
// 인자 조립과 출력 파싱은 순수 함수로 뒀다. 서브프로세스를 띄우지 않고 계약을 검증할 수 있다.
import type { AgentConfig } from '@murmur/shared';

export interface HarnessDefinition extends AgentConfig {
  handle: string;
}

export interface McpConfig {
  mcpServers: {
    murmur: { type: 'http'; url: string; headers: { Authorization: string } };
  };
}

/** 각 에이전트는 자기 PAT 로 murmur 에 붙는다 — 공유하면 누가 발화했는지 구별되지 않는다. */
export function mcpConfigFor(murmurUrl: string, pat: string): McpConfig {
  return {
    mcpServers: {
      murmur: {
        type: 'http',
        url: `${murmurUrl.replace(/\/$/, '')}/mcp`,
        headers: { Authorization: `Bearer ${pat}` },
      },
    },
  };
}

export function buildClaudeArgs(def: HarnessDefinition, mcpConfigPath: string): string[] {
  const args = [
    '-p',
    // json 이 아니면 실패를 본문과 구별할 수 없다 — 실패 문구를 답변으로 발화하게 된다.
    '--output-format', 'json',
    '--mcp-config', mcpConfigPath,
  ];

  // 지시문은 에이전트의 정체다. 사용자 턴에 섞으면 사람이 방금 한 말과 구별되지 않는다.
  const system = [
    `너는 murmur 워크스페이스의 에이전트 @${def.handle} 이다.`,
    def.instructions,
  ].filter(Boolean).join('\n\n');
  args.push('--append-system-prompt', system);

  // null 은 'harness 기본값 사용'이다 — 빈 값을 넘기면 CLI 가 거절한다.
  if (def.model) args.push('--model', def.model);
  if (def.effort) args.push('--effort', def.effort);

  return args;
}

export type HarnessResult = { ok: true; text: string } | { ok: false; reason: string };

/** `claude -p --output-format json` 의 출력. is_error 를 무시하면 실패 문구를 채널에 발화한다. */
export function parseClaudeResult(stdout: string): HarnessResult {
  let parsed: { is_error?: boolean; subtype?: string; result?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { ok: false, reason: `출력이 json 이 아니다: ${stdout.slice(0, 200)}` };
  }
  if (parsed.is_error) {
    return { ok: false, reason: `harness 실패 (${parsed.subtype ?? 'unknown'})` };
  }
  const text = typeof parsed.result === 'string' ? parsed.result.trim() : '';
  if (!text) return { ok: false, reason: '답변이 비어 있다' };
  return { ok: true, text };
}
