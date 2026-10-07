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

  it('gh 는 하위 명령 두 단계를 고정한 접두와 읽기 api 한 줄만 받는다(F3)', () => {
    expect(validateToolRule('Bash(gh -R rebellions-sw/udc-k8s pr view:*)')).toMatchObject({ ok: true });
    expect(validateToolRule('Bash(gh api repos/rebellions-sw/udc-k8s/pulls/11170)')).toMatchObject({ ok: true, kind: 'bash_exact' });
  });

  it('첫 실사용 규칙(rebelro)은 통과한다', () => {
    expect(validateToolRule('Bash(kubectl --context udc-main-admin@udc-main -n rebelro-cluster exec:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
    expect(validateToolRule('Bash(gh pr view -R rebellions-sw/udc-k8s:*)')).toMatchObject({ ok: true, warnings: [] });
  });

  it('임의 명령을 돌릴 수 있는 도구는 runs_arbitrary 경고(n5)', () => {
    for (const r of ['Bash(find . -name x -exec rm:*)', 'Bash(awk -f prog.awk:*)', 'Bash(uv run pytest:*)', 'Bash(make -C build all:*)', 'Bash(git -c core.sshCommand=x fetch)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('runs_arbitrary'), r).toBe(true);
    }
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
    // security F1 — 규칙 하나에 여러 개 끼워 넣기
    ['Bash(git status), Bash, Bash(x:*)', 'bad_chars'],
    ['Bash(git status,Bash)', 'bad_chars'],
    // security F2 — 따옴표·역슬래시로 감춘 머리, 버전 붙은 인터프리터, 감싸 돌리는 것
    ['Bash("sh" -c x:*)', 'bad_chars'],
    ["Bash('sh' -c x:*)", 'bad_chars'],
    ['Bash(\\sh -c x:*)', 'bad_chars'],
    ['Bash(python3.12 -c x:*)', 'interpreter'],
    ['Bash(node22 -e x:*)', 'interpreter'],
    ['Bash(caffeinate -i sh:*)', 'interpreter'],
    ['Bash(kubectl get pods {a,b})', 'bad_chars'],
    ['Bash(cat ~/.ssh/id_ed25519)', 'bad_chars'],
    // security F3 — gh 로 머지 deny 를 옆으로 돌기
    ['Bash(gh api:*)', 'gh_api_write'],
    ['Bash(gh api repos/o/r/pulls/1/merge:*)', 'merge_bypass'],
    ['Bash(gh api -XPUT repos/o/r:*)', 'gh_api_write'],
    ['Bash(gh api -XPUT repos/o/r/pulls/1)', 'gh_api_write'],
    ['Bash(gh api --method=PUT repos/o/r/pulls/1)', 'gh_api_write'],
    ['Bash(gh api repos/o/r/issues -f title=x)', 'gh_api_write'],
    ['Bash(gh api graphql:*)', 'gh_api_write'],
    ['Bash(gh api graphql)', 'gh_api_write'],
    ['Bash(gh -R o/r pr:*)', 'too_broad'],
    ['Bash(gh -R o/r pr merge 1)', 'merge_bypass'],
    ['Bash(gh pr:*)', 'too_broad'],
    ['Bash(gh alias set pv pr:*)', 'merge_bypass'],
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
