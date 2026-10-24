import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decideHook, decideLaneHook, laneBashAllowed, laneToolListed, readStdinCapped } from '../src/hookCli.js';
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
