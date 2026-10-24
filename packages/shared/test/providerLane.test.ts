import { describe, expect, it } from 'vitest';
import { codexRulesFile, normalizeProviderBaseUrl, providerLaneFailureCode, readProviderLaneConfig } from '../src/providerLane.js';
import { readOperatorAgentProviderLanePayload } from '../src/daemonProtocol.js';
import { isRunnerLinkNotice } from '../src/runnerLink.js';

describe('normalizeProviderBaseUrl', () => {
  it('https 는 받고 끝 슬래시를 뗀다 — 경로 접두는 남긴다', () => {
    expect(normalizeProviderBaseUrl('https://gateway.example/')).toBe('https://gateway.example');
    expect(normalizeProviderBaseUrl(' https://gateway.example/anthropic/ ')).toBe('https://gateway.example/anthropic');
  });
  it('루프백만 평문 http 를 받는다', () => {
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeProviderBaseUrl('http://gateway.example')).toBeNull();
  });
  it('사용자 정보·쿼리·조각·다른 스킴은 거절한다', () => {
    for (const bad of ['https://u:p@gateway.example', 'https://gateway.example?key=1', 'https://gateway.example#x', 'file:///etc/passwd', '', 'nope', 42]) {
      expect(normalizeProviderBaseUrl(bad)).toBeNull();
    }
  });
});

describe('readProviderLaneConfig·payload', () => {
  it('비밀 이름 문법을 지킨다', () => {
    expect(readProviderLaneConfig({ baseUrl: 'https://gateway.example', secretName: 'gw-key' })).toEqual({ baseUrl: 'https://gateway.example', secretName: 'gw-key' });
    expect(readProviderLaneConfig({ baseUrl: 'https://gateway.example', secretName: '../x' })).toBeNull();
  });
  it('lane null 은 빼기, 틀린 lane 은 bad-payload', () => {
    expect(readOperatorAgentProviderLanePayload({ baseUrl: 'https://s.example', agentId: 'a', lane: null })).toEqual({ baseUrl: 'https://s.example', agentId: 'a', lane: null });
    expect(readOperatorAgentProviderLanePayload({ baseUrl: 'https://s.example', agentId: 'a', lane: { baseUrl: 'http://x.example', secretName: 'k' } })).toMatchObject({ code: 'bad-payload' });
  });
});

describe('providerLaneFailureCode', () => {
  it('목록의 코드는 그대로, 나머지는 unknown', () => {
    expect(providerLaneFailureCode('not_granted')).toBe('not_granted');
    for (const bad of ['http_502', 'https://gateway.example', '', undefined, 3]) expect(providerLaneFailureCode(bad)).toBe('unknown');
  });
});

describe('providerLane.result 통지', () => {
  it('ok 와 허용 목록 코드만 받는다', () => {
    expect(isRunnerLinkNotice({ type: 'providerLane.result', ok: true })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'providerLane.result', ok: false, code: 'not_granted' })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'providerLane.result', ok: false, code: 'https://gateway.example' })).toBe(false);
    expect(isRunnerLinkNotice({ type: 'providerLane.result' })).toBe(false);
  });
});

describe('providerLane.mode 통지(C1)', () => {
  it('on 은 boolean 만', () => {
    expect(isRunnerLinkNotice({ type: 'providerLane.mode', on: true })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'providerLane.mode', on: 'yes' })).toBe(false);
    expect(isRunnerLinkNotice({ type: 'providerLane.mode' })).toBe(false);
  });
});

describe('providerLane.turn 통지(n16)', () => {
  it('ok 는 boolean 만', () => {
    expect(isRunnerLinkNotice({ type: 'providerLane.turn', ok: false })).toBe(true);
    expect(isRunnerLinkNotice({ type: 'providerLane.turn', ok: 'no' })).toBe(false);
  });
});

describe('codexRulesFile', () => {
  it('셸 규칙만 prefix_rule 로 옮긴다 — 접두 규칙은 :* 를 떼고, MCP·웹 도구는 뺀다', () => {
    const out = codexRulesFile(['Bash(gh pr list -R cli/cli --limit 3)', 'Bash(kubectl --context lab get:*)', 'mcp__github__get_issue', 'WebFetch']);
    expect(out.split('\n').filter((l) => l.startsWith('prefix_rule'))).toEqual([
      'prefix_rule(pattern = ["gh", "pr", "list", "-R", "cli/cli", "--limit", "3"], decision = "allow")',
      'prefix_rule(pattern = ["kubectl", "--context", "lab", "get"], decision = "allow")',
    ]);
    expect(out.startsWith('# harkroom')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('판정을 못 지나는 규칙은 조용히 뺀다 — 셸 문법·따옴표·인터프리터·래퍼·와일드카드', () => {
    const out = codexRulesFile([
      'Bash(gh pr list; rm -rf /)', 'Bash(echo "x" foo)', 'Bash(bash -lc id)', 'Bash(harkroom-operator merge o/r 1)',
      'Bash(*)', 'Bash(git:*)', 'Bash(gh pr view 1\\ 2)',
    ]);
    expect(out).not.toContain('prefix_rule');
  });

  it('낱말 사이 공백은 하나로, 같은 꼴은 한 줄로', () => {
    const out = codexRulesFile(['Bash(gh  pr view 1)', 'Bash(gh pr view 1)']);
    expect(out.match(/prefix_rule/g)).toHaveLength(1);
    expect(out).toContain('["gh", "pr", "view", "1"]');
  });

  it('규칙이 없으면 머리 줄 하나뿐이다(빈 정책)', () => {
    expect(codexRulesFile([])).toBe('# harkroom: owner-approved commands (written by the runner each turn; do not edit)\n');
  });
});
