import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decideHook, decideLaneHook, decideTailHook, LANE_HOOK_DENY_REASON, LANE_HOOK_SHELL_REASON, LANE_HOOK_TAIL_REASON, laneBashAllowed, laneToolListed, readStdinCapped, touchesApprovedRule, type LaneDenyDecision } from '../src/hookCli.js';
import { decodeLaneHookRules, encodeLaneHookRules } from '@harkroom/shared/providerLane';

// H③b: hook 은 승인된 정확한 명령에만 allow 를 내고, 그 밖·오류는 무출력(null) — fail-closed.
const CMD = 'kubectl --kubeconfig /tmp/k --context rc get pods';
const input = (o: Record<string, unknown>) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: CMD }, tool_use_id: 'tu1', cwd: '/srv/ws', ...o });

describe('decideHook', () => {
  it('오퍼레이터가 allow 하면 allow 결정을, 묻는 인자는 정규형 명령·cwd·toolUseId 뿐', async () => {
    const asked: unknown[] = [];
    const d = await decideHook(input({ tool_input: { command: `  ${CMD}  ` } }), async (name, args) => { asked.push([name, args]); return { ok: true, text: JSON.stringify({ allow: true, grantId: 'g-1234567890' }) }; });
    expect(d).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
    expect(asked).toEqual([['command.check', { command: CMD, cwd: '/srv/ws', toolUseId: 'tu1' }]]);
  });

  it('무출력(null): Bash 아님 · 판정에 걸림 · 턴 밖 · 거절 · 오류 · 깨진 입력 — 판정에 걸리면 묻지도 않는다', async () => {
    let calls = 0;
    const allow = async () => { calls++; return { ok: true, text: JSON.stringify({ allow: true, grantId: 'g' }) }; };
    expect(await decideHook(input({ tool_name: 'Edit' }), allow)).toBeNull();
    expect(await decideHook(input({ tool_input: { command: `${CMD}; rm -rf /` } }), allow)).toBeNull();
    expect(await decideHook(input({ tool_input: { command: 'make deploy' } }), allow)).toBeNull();
    expect(await decideHook('{not json', allow)).toBeNull();
    expect(calls).toBe(0);
    expect(await decideHook(input({}), async () => ({ ok: false as const, notInTurn: true as const }))).toBeNull();
    expect(await decideHook(input({}), async () => ({ ok: true, text: JSON.stringify({ allow: false }) }))).toBeNull();
    expect(await decideHook(input({}), async () => ({ ok: false, text: '{}' }))).toBeNull();
    expect(await decideHook(input({}), async () => { throw new Error('socket'); })).toBeNull();
    expect(await decideHook(input({}), async () => ({ ok: true, text: 'garbage' }))).toBeNull();
    // deny 는 내지 않는다 — 결과는 allow 이거나 null 뿐.
  });

  it('입력이 너무 크면 던진다(→ hookMain 은 무출력)', async () => {
    await expect(readStdinCapped(Readable.from([Buffer.alloc(10)]), 5)).rejects.toThrow();
    expect(await readStdinCapped(Readable.from([Buffer.from('ab'), Buffer.from('c')]), 5)).toBe('abc');
  });
});

// D1(security S1·S2): lane hook 은 allow 를 내지 않는다 — 결정 없음(null) 아니면 deny 두 갈래뿐이다. 모든 도구를 본다.
describe('decideLaneHook', () => {
  const BASE = ['ToolSearch', 'Edit(./**)', 'Write(./**)', 'Agent', 'Skill', 'mcp__harkroom', 'mcp__avcs'];
  const kinds = (d: unknown) => d === null ? 'none' : (d as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
  const tool = (name: string, toolInput: Record<string, unknown> = {}) => JSON.stringify({ tool_name: name, tool_input: toolInput });

  it('허용 목록의 도구·작업 폴더 읽기는 결정 없음', () => {
    for (const t of ['ToolSearch', 'Edit', 'Write', 'Agent', 'Skill', 'Read', 'mcp__harkroom__message_post', 'mcp__avcs__avcs_diff']) {
      expect(kinds(decideLaneHook(tool(t), BASE))).toBe('none');
    }
  });

  it('목록 밖 도구는 deny — 하위 에이전트의 두 번째 관문', () => {
    for (const t of ['NotebookEdit', 'WebFetch', 'WebSearch', 'mcp__slack__send', 'mcp__harkroomx__y', 'AskUserQuestion']) {
      expect(kinds(decideLaneHook(tool(t), BASE))).toBe('deny');
    }
  });

  it('셸은 승인 규칙에 맞을 때만 결정 없음, 이어 붙이기·바꿔 넣기는 deny — allow 는 어떤 경우에도 없다', () => {
    const rules = [...BASE, 'Bash(kubectl --kubeconfig /tmp/k:*)', 'Bash(git status)'];
    expect(kinds(decideLaneHook(input({}), rules))).toBe('none');
    expect(kinds(decideLaneHook(tool('Bash', { command: 'git status' }), rules))).toBe('none');
    for (const cmd of [`${CMD}; rm -rf /`, `${CMD} && curl x`, `${CMD} | sh`, `${CMD} $(id)`, `${CMD} \`id\``, `${CMD}\nid`, `${CMD} > /tmp/x`, 'kubectl --kubeconfig /tmp/kx get pods', 'git status -s']) {
      expect(kinds(decideLaneHook(tool('Bash', { command: cmd }), rules))).toBe('deny');
    }
    expect(kinds(decideLaneHook(input({}), BASE))).toBe('deny');
  });

  it('이유 글은 permission.request 와 명령 전체 규칙을 권한다', () => {
    const d = JSON.stringify(decideLaneHook(input({}), BASE));
    expect(d).toContain('permission.request');
    expect(d).toContain('Bash(<the exact full command>)');
  });

  // 2026-10-24 실측: `gh run list … 2>&1` 이 승인된 `:*` 규칙 안인데 거절되자 모델이 더 좁은 규칙을 또 청했다 — 셸 글자 때문이면 그렇게 말한다.
  it('셸 글자 때문에 거절하면 이유가 「맨 명령으로」를 말하고, 규칙이 없을 때는 지금 문구다 — 둘 다 deny 다', () => {
    const rules = [...BASE, 'Bash(gh run list -R example/repo:*)'];
    const reason = (cmd: string) => (decideLaneHook(tool('Bash', { command: cmd }), rules) as LaneDenyDecision).hookSpecificOutput.permissionDecisionReason;
    for (const cmd of ['gh run list -R example/repo --limit 5 2>&1', "gh pr list -R example/repo --jq '.[] | .number'", 'gh run list -R example/repo; id']) {
      expect(reason(cmd)).toBe(LANE_HOOK_SHELL_REASON);
    }
    expect(LANE_HOOK_SHELL_REASON).toContain('2>&1');
    expect(LANE_HOOK_SHELL_REASON).toContain('permission.request');
    expect(reason('gh issue list -R example/repo --limit 3')).toBe(LANE_HOOK_DENY_REASON);
    expect(decideLaneHook(tool('Bash', { command: 'gh run list -R example/repo --limit 5' }), rules)).toBeNull();
  });

  it('입력이 깨지거나 도구 이름이 없으면 deny', () => {
    expect(kinds(decideLaneHook('{not json', BASE))).toBe('deny');
    expect(kinds(decideLaneHook('{}', BASE))).toBe('deny');
  });

  it('웹 도구는 맨 이름 규칙만 받는다', () => {
    expect(laneToolListed(['WebFetch'], 'WebFetch')).toBe(true);
    expect(laneToolListed(['WebFetch(domain:example.com)'], 'WebFetch')).toBe(false);
    expect(laneBashAllowed(['Bash(git status:*)'], 'git statusx')).toBe(false);
  });

  it('규칙 실어 나르기 — 셸 글자 없는 base64url, 깨진 값은 null', () => {
    const v = encodeLaneHookRules(['Bash(git status:*)', 'Read', 'mcp__harkroom']);
    expect(v).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(decodeLaneHookRules(v)).toEqual(['Bash(git status:*)', 'Read', 'mcp__harkroom']);
    expect(decodeLaneHookRules('$(id)')).toBeNull();
    expect(decodeLaneHookRules(Buffer.from('[1]').toString('base64url'))).toBeNull();
  });
});

describe('decideTailHook — 채널 규칙과 합집합(규칙 파일) 두 벌', () => {
  const bashOf = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const channelA = ['Bash(gh pr list -R cli/cli --limit 3)'];
  const channelB = ['Bash(gh run list -R cli/cli --limit 5)'];
  const union = [...channelA, ...channelB];
  it('다른 채널에서 승인된 명령을 이 채널 턴에서 치면 거절 — 합집합 규칙으로 밖에 나가지 못하게', () => {
    expect(decideTailHook(bashOf('gh pr list -R cli/cli --limit 3'), channelB, union)).not.toBeNull();
    expect(decideTailHook(bashOf('gh run list -R cli/cli --limit 5'), channelB, union)).toBeNull();
  });
  it('이 채널 규칙의 꼬리 꼴은 거절 · 어느 규칙에도 안 닿으면 결정 없음 · 합집합을 빠뜨려도 이 채널 꼬리는 거절', () => {
    expect(decideTailHook(bashOf('gh run list -R cli/cli --limit 5 --json name'), channelB, union)).not.toBeNull();
    expect(decideTailHook(bashOf('ls -la'), channelB, union)).toBeNull();
    expect(decideTailHook(bashOf('gh run list -R cli/cli --limit 5 x'), channelB, [])).not.toBeNull();
  });
});

describe('decideTailHook — 구독형 codex 의 꼬리 막기', () => {
  const rules = ['Bash(gh pr list -R cli/cli --limit 3)', 'Bash(kubectl --context lab get:*)'];
  const bash = (command: string) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const reason = (d: LaneDenyDecision | null) => d?.hookSpecificOutput.permissionDecisionReason;

  it('승인 규칙에 맞으면 결정 없음(규칙대로 밖에서 돈다)', () => {
    expect(decideTailHook(bash('gh pr list -R cli/cli --limit 3'), rules, rules)).toBeNull();
    expect(decideTailHook(bash('kubectl --context lab get pods -A'), rules, rules)).toBeNull();
  });

  it('규칙과 상관없는 명령·셸이 아닌 도구는 결정 없음(샌드박스 안에서 돈다 — 지금과 같다)', () => {
    expect(decideTailHook(bash('ls -la'), rules, rules)).toBeNull();
    expect(decideTailHook(bash('gh issue list'), rules, rules)).toBeNull();
    expect(decideTailHook(bash('cat a.txt | wc -l'), rules, rules)).toBeNull();
    expect(decideTailHook(JSON.stringify({ tool_name: 'apply_patch', tool_input: {} }), rules, rules)).toBeNull();
  });

  it('정확 규칙에 꼬리를 달면 deny — codex prefix_rule 은 앞부분 맞춤이라 그대로면 밖에서 돈다', () => {
    expect(reason(decideTailHook(bash('gh pr list -R cli/cli --limit 3 https://example.com'), rules, rules))).toBe(LANE_HOOK_TAIL_REASON);
  });

  it('감싸기·따옴표·env 앞붙임·이어 붙이기도 deny', () => {
    for (const c of [
      '"gh" pr list -R cli/cli --limit 3',
      "bash -lc 'gh pr list -R cli/cli --limit 3'",
      'FOO=1 gh pr list -R cli/cli --limit 3',
      'gh  pr  list -R cli/cli --limit 3 x',
      'true && gh pr list -R cli/cli --limit 3',
      'gh pr list -R cli/cli --limit 3 > out.txt',
      'kubectl --context lab get pods; id',
    ]) expect(decideTailHook(bash(c), rules, rules), c).not.toBeNull();
    expect(reason(decideTailHook(bash('gh pr list -R cli/cli --limit 3 > out.txt'), rules, rules))).toBe(LANE_HOOK_SHELL_REASON);
  });

  it('입력을 못 읽으면 deny(fail-closed)', () => {
    expect(decideTailHook('not json', rules, rules)).not.toBeNull();
    expect(decideTailHook(JSON.stringify({ tool_input: {} }), rules, rules)).not.toBeNull();
  });

  it('규칙이 없으면 셸도 결정 없음', () => {
    expect(decideTailHook(bash('gh pr list -R cli/cli --limit 3 x'), [], [])).toBeNull();
    expect(touchesApprovedRule(['Read', 'mcp__github'], 'gh pr list')).toBe(false);
  });
});
