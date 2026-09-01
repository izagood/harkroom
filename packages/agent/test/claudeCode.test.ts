import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, parseClaudeResult, mcpConfigFor } from '../src/harness/claudeCode.js';

const cfg = {
  handle: 'fizz',
  instructions: '느린 쿼리를 찾아 원인을 설명한다.',
  harness: 'claude-code' as const,
  model: null,
  effort: null,
  workingDir: null,
};

describe('buildClaudeArgs', () => {
  it('runs in print mode with structured output so failures are visible', () => {
    const args = buildClaudeArgs(cfg, '/tmp/mcp.json');

    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  // 지시문은 에이전트의 정체다 — 프롬프트에 섞으면 사용자 메시지와 구별되지 않는다.
  it('carries the instructions as a system prompt, not as the user turn', () => {
    const args = buildClaudeArgs(cfg, '/tmp/mcp.json');

    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('느린 쿼리를 찾아');
  });

  // 이 에이전트로서 murmur 도구를 쓸 수 있어야 한다 — 자기 PAT 로 붙은 MCP 설정을 넘긴다.
  it('injects the murmur mcp config', () => {
    const args = buildClaudeArgs(cfg, '/tmp/mcp.json');

    expect(args).toContain('--mcp-config');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json');
  });

  // null 은 'harness 기본값 사용'이다 — 빈 값을 넘기면 CLI 가 거절한다.
  it('omits model and effort when the definition leaves them to the harness', () => {
    const args = buildClaudeArgs(cfg, '/tmp/mcp.json');

    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  it('passes model and effort when the definition sets them', () => {
    const args = buildClaudeArgs({ ...cfg, model: 'claude-opus-5', effort: 'high' }, '/tmp/mcp.json');

    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
});

describe('mcpConfigFor', () => {
  // 각 에이전트는 자기 PAT 로 붙어야 한다 — 공유하면 누가 발화했는지 구별되지 않는다.
  it('points at murmur with the agent own credential', () => {
    const config = mcpConfigFor('http://localhost:3400', 'murp_fizz');

    expect(config.mcpServers.murmur.url).toBe('http://localhost:3400/mcp');
    expect(config.mcpServers.murmur.headers.Authorization).toBe('Bearer murp_fizz');
  });
});

describe('parseClaudeResult', () => {
  it('takes the result text from a successful run', () => {
    const out = parseClaudeResult(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'N+1 조회가 원인입니다.',
    }));

    expect(out).toEqual({ ok: true, text: 'N+1 조회가 원인입니다.' });
  });

  // is_error 를 무시하면 실패 문구를 에이전트의 답변으로 채널에 발화한다.
  it('reports a failed run instead of posting its output as an answer', () => {
    const out = parseClaudeResult(JSON.stringify({
      type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom',
    }));

    expect(out.ok).toBe(false);
  });

  it('rejects output that is not the expected json', () => {
    expect(parseClaudeResult('claude: command not found').ok).toBe(false);
  });

  it('rejects a run that produced no text', () => {
    expect(parseClaudeResult(JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: '   ',
    })).ok).toBe(false);
  });
});
