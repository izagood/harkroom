import { describe, expect, it } from 'vitest';
import {
  countTurnDenials, decidePermissionHook, PERMISSION_ASK_REASON, PERMISSION_RM_REASON, PERMISSION_STOP_AFTER, PERMISSION_STOP_REASON, variablePathRm,
} from '../src/hookCli.js';

const bash = (command: string) => JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } });
const ask = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'red or blue?' }] } });

describe('하네스 물음 hook(C안 P1) — 판정', () => {
  it('변수 경로 rm 은 deny + 다시 쓰는 법(실측에서 안전 검사가 물은 꼴)', () => {
    const d = decidePermissionHook(bash('P=/tmp/x; for b in sub; do rm -rf $P/$b; done'), 0);
    expect(d?.kind).toBe('rm_variable_path');
    expect(d?.decision).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: PERMISSION_RM_REASON } } });
    expect(PERMISSION_RM_REASON).toContain('${P:?}');
  });

  it('AskUserQuestion 은 deny + 스스로 고르거나 message.ask', () => {
    const d = decidePermissionHook(ask, 0);
    expect(d?.kind).toBe('ask_user_question');
    expect(d?.decision?.hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: PERMISSION_ASK_REASON });
    expect(PERMISSION_ASK_REASON).toContain('message.ask');
  });

  it('allow 는 어떤 입력에도 내지 않는다 — 그 밖의 물음은 결정 없음(화면 물음이 받친다)', () => {
    for (const raw of [bash('git push --force origin feat'), bash('rm -rf /tmp/literal/dir'), JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/etc/x' } }), ask]) {
      const d = decidePermissionHook(raw, 0);
      expect(JSON.stringify(d)).not.toContain('"allow"');
    }
    expect(decidePermissionHook(bash('git push --force origin feat'), 0)?.decision).toBeNull();
    expect(decidePermissionHook(bash('rm -rf /tmp/literal/dir'), 0)?.decision).toBeNull();
  });

  it(`같은 턴 ${PERMISSION_STOP_AFTER}번째 거절이면 「멈추고 message.fail」`, () => {
    expect(decidePermissionHook(ask, PERMISSION_STOP_AFTER - 2)?.decision?.hookSpecificOutput.decision.message).toBe(PERMISSION_ASK_REASON);
    expect(decidePermissionHook(ask, PERMISSION_STOP_AFTER - 1)?.decision?.hookSpecificOutput.decision.message).toBe(PERMISSION_STOP_REASON);
    expect(PERMISSION_STOP_REASON).toContain('message.fail');
  });

  it('깨진 입력은 판정하지 않는다(무출력)', () => {
    expect(decidePermissionHook('not json', 0)).toBeNull();
    expect(decidePermissionHook('{}', 0)).toBeNull();
  });

  it('기록에는 명령 전문을 남기지 않는다 — 첫 낱말만', () => {
    const d = decidePermissionHook(bash('curl -H "Authorization: Bearer sekrit" https://example.com'), 0);
    expect(d?.program).toBe('curl');
    expect(JSON.stringify(d)).not.toContain('sekrit');
  });

  it('variablePathRm — 명령 경계 뒤의 rm 과 같은 단순 명령 안의 $', () => {
    for (const c of ['rm -rf $P/x', 'cd /a && rm -f "$D"/*', 'for b in a; do rm -rf $P/$b; done', 'x; rm ${A}/${B}']) expect(variablePathRm(c), c).toBe(true);
    for (const c of ['rm -rf /tmp/x', 'echo $P; rm -rf /tmp/x', 'git rm --cached file', 'npm run rmdir $X', 'rm a | grep $X']) expect(variablePathRm(c), c).toBe(false);
  });

  it('countTurnDenials — 이 턴의 deny 만 센다', () => {
    const lines = [
      { turn: 't1', event: 'decided', decision: 'deny' }, { turn: 't1', event: 'decided', decision: 'none' },
      { turn: 't2', event: 'decided', decision: 'deny' }, { turn: 't1', event: 'hook_error' }, { turn: 't1', event: 'decided', decision: 'deny' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n{broken';
    expect(countTurnDenials(lines, 't1')).toBe(2);
    expect(countTurnDenials('', 't1')).toBe(0);
  });
});
