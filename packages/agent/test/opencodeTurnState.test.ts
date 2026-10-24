import { describe, expect, it } from 'vitest';
import { opencodeTurnStateFromExport } from '../src/opencodeTurnState.js';

// `opencode export <id>` 의 모양(실측 1.18.32): { info, messages: [{ info: { role, time, finish }, parts }] }.
const exported = (...infos: object[]) => JSON.stringify({ info: {}, messages: infos.map((info) => ({ info, parts: [] })) });
const SINCE = 1_000;

describe('opencodeTurnStateFromExport', () => {
  it('이 턴의 assistant 가 완료되고 finish=stop 이면 끝났다 — 말 없이 reasoning 만 낸 턴도', () => {
    expect(opencodeTurnStateFromExport(exported(
      { role: 'user', time: { created: 1_100 } },
      { role: 'assistant', time: { created: 1_200, completed: 1_300 }, finish: 'tool-calls' },
      { role: 'assistant', time: { created: 1_300, completed: 1_400 }, finish: 'stop' },
    ), SINCE)).toBe('ended');
  });

  it('도구 결과를 기다리는 걸음(tool-calls)·아직 완료 안 됨·사용자 말이 마지막이면 일하는 중이다', () => {
    expect(opencodeTurnStateFromExport(exported({ role: 'assistant', time: { created: 1_200, completed: 1_300 }, finish: 'tool-calls' }), SINCE)).toBe('working');
    expect(opencodeTurnStateFromExport(exported({ role: 'assistant', time: { created: 1_200 } }), SINCE)).toBe('working');
    expect(opencodeTurnStateFromExport(exported({ role: 'user', time: { created: 1_200 } }), SINCE)).toBe('working');
  });

  it('되살린 세션의 앞 턴 stop 은 이 턴의 끝이 아니다', () => {
    expect(opencodeTurnStateFromExport(exported({ role: 'assistant', time: { created: 500, completed: 600 }, finish: 'stop' }), SINCE)).toBe('working');
  });

  it('형식을 모르면 모른다(null)', () => {
    expect(opencodeTurnStateFromExport('not json', SINCE)).toBeNull();
    expect(opencodeTurnStateFromExport(JSON.stringify({ messages: [] }), SINCE)).toBeNull();
    expect(opencodeTurnStateFromExport(JSON.stringify([]), SINCE)).toBeNull();
  });
});
