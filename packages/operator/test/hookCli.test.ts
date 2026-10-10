import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decideHook, readStdinCapped } from '../src/hookCli.js';

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
