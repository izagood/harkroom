import { describe, expect, it } from 'vitest';
import { parseToolScope, toolScope, validateToolRule } from '../src/toolRules.js';

describe('validateToolRule — 받는 것', () => {
  it('읽기 접두는 경고 없이 받는다', () => {
    expect(validateToolRule('Bash(gh pr view -R rebellions-sw/udc-k8s:*)')).toEqual({
      ok: true, rule: 'Bash(gh pr view -R rebellions-sw/udc-k8s:*)', kind: 'bash_prefix', warnings: [],
    });
    expect(validateToolRule('Bash(kubectl --context udc -n rebelro get:*)')).toMatchObject({ ok: true, warnings: [] });
  });

  it('kubectl exec 는 받되 실행형 경고를 단다(D4)', () => {
    expect(validateToolRule('Bash(kubectl --context udc -n rebelro exec:*)')).toMatchObject({
      ok: true, warnings: ['executes_in_workload'],
    });
  });

  it('원격을 바꾸는 하위 명령은 경고한다', () => {
    expect(validateToolRule('Bash(kubectl --context udc delete pod x)')).toMatchObject({ ok: true, kind: 'bash_exact', warnings: ['mutates_remote'] });
    expect(validateToolRule('Bash(git push origin feature)')).toMatchObject({ ok: true, warnings: ['mutates_remote'] });
  });

  it('고정 낱말이 둘뿐인 접두는 짧다고 경고한다', () => {
    expect(validateToolRule('Bash(kubectl get:*)')).toMatchObject({ ok: true, warnings: ['short_prefix'] });
  });

  it('공백을 하나로 고친다', () => {
    expect(validateToolRule('  Bash( gh   pr  view :*)  ')).toMatchObject({ ok: true, rule: 'Bash(gh pr view:*)' });
  });

  it('MCP 도구 하나는 받는다 — harkroom MCP 는 아니다', () => {
    expect(validateToolRule('mcp__slack__read_thread')).toMatchObject({ ok: true, kind: 'mcp_tool' });
    expect(validateToolRule('mcp__harkroom__grant_delegate')).toEqual({ ok: false, code: 'unsupported_tool' });
  });
});

describe('validateToolRule — 거절', () => {
  it.each([
    ['', 'empty'],
    ['Bash', 'unsupported_tool'],
    ['Edit(**)', 'unsupported_tool'],
    ['Bash(*)', 'too_broad'],
    ['Bash(:*)', 'too_broad'],
    ['Bash(kubectl:*)', 'too_broad'],
    ['Bash(kubectl * exec:*)', 'wildcard'],
    ['Bash(gh pr view && rm -rf x)', 'shell_syntax'],
    ['Bash(echo $(id))', 'shell_syntax'],
    ['Bash(kubectl get pods > /tmp/x)', 'shell_syntax'],
    ['Bash(claude --dangerously-skip-permissions:*)', 'dangerous_flag'],
    ['Bash(bash -c:*)', 'interpreter'],
    ['Bash(/usr/bin/env kubectl:*)', 'interpreter'],
    ['Bash(python3 -c print:*)', 'interpreter'],
    ['Bash(sudo kubectl get:*)', 'interpreter'],
    ['Bash(/opt/harkroom/harkroom-operator merge:*)', 'operator_wrapper'],
    ['Bash(gh pr merge 12)', 'merge_bypass'],
    ['Bash(gh -R a/b pr merge:*)', 'merge_bypass'],
    ['Bash(gh api -X PUT repos/a/b/pulls/1/merge)', 'merge_bypass'],
  ])('%s → %s', (rule, code) => {
    expect(validateToolRule(rule)).toEqual({ ok: false, code });
  });

  it('너무 길면 거절한다', () => {
    expect(validateToolRule(`Bash(gh pr view ${'x'.repeat(400)})`)).toEqual({ ok: false, code: 'too_long' });
  });
});

describe('toolScope', () => {
  const ch = '0b6a1f0e-1111-4222-8333-944445555666';
  it('채널 id 와 규칙을 오간다(규칙 안의 콜론도 그대로)', () => {
    const s = toolScope(ch, 'Bash(gh pr view:*)');
    expect(s).toBe(`tool:${ch}:Bash(gh pr view:*)`);
    expect(parseToolScope(s)).toEqual({ channelId: ch, rule: 'Bash(gh pr view:*)' });
  });
  it('모양이 틀리면 null', () => {
    expect(parseToolScope('tool::Bash(x)')).toBeNull();
    expect(parseToolScope('repo:a/b')).toBeNull();
  });
});
