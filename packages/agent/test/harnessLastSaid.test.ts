// 끝말을 기록에서 읽기 — 실제 rollout·export 모양을 줄여 고정한다(codex 0.154.0, opencode 1.18.x 실측).
import { describe, expect, it } from 'vitest';
import { lastSaidRecordOf } from '../src/adapters/index.js';
import { lastSaidFromCodexRollout, lastSaidFromOpencodeExport } from '../src/harnessLastSaid.js';
import { silentTurnNotice } from '../src/prompt.js';

const rec = (at: string, payload: unknown, type = 'response_item') => JSON.stringify({ timestamp: at, type, payload });
const said = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const SINCE = Date.parse('2026-01-01T10:00:00Z');

describe('lastSaidFromCodexRollout', () => {
  it('마지막 assistant 글을 줄바꿈까지 원문으로 읽는다', () => {
    const table = '총 2건\n\n| PR | 제목 |\n|---|---|\n| #1 | 가 |\n| #2 | 나 |';
    const text = [
      rec('2026-01-01T10:00:01Z', said('가져온다.')),
      rec('2026-01-01T10:00:02Z', { type: 'function_call', name: 'exec_command' }),
      rec('2026-01-01T10:00:03Z', { type: 'function_call_output', output: '[]' }),
      rec('2026-01-01T10:00:04Z', { type: 'reasoning', content: [] }),
      rec('2026-01-01T10:00:05Z', said(table)),
      rec('2026-01-01T10:00:05Z', { type: 'item_completed' }, 'event_msg'),
      '',
    ].join('\n');
    expect(lastSaidFromCodexRollout(text, SINCE)).toBe(table);
  });

  it('글 뒤에 도구 호출이 있으면 끝말이 아니다', () => {
    const text = [rec('2026-01-01T10:00:01Z', said('가져온다.')), rec('2026-01-01T10:00:02Z', { type: 'function_call' })].join('\n');
    expect(lastSaidFromCodexRollout(text, SINCE)).toBeNull();
  });

  it('이 턴 앞의 글은 읽지 않고, 깨진 줄은 건너뛴다', () => {
    expect(lastSaidFromCodexRollout(rec('2026-01-01T09:59:59Z', said('앞 턴의 말')), SINCE)).toBeNull();
    expect(lastSaidFromCodexRollout(`${rec('2026-01-01T10:00:01Z', said('답'))}\n{깨짐`, SINCE)).toBe('답');
  });
});

describe('lastSaidFromOpencodeExport', () => {
  const msg = (over: Record<string, unknown>, parts: unknown[]) => ({
    info: { role: 'assistant', time: { created: SINCE + 1, completed: SINCE + 2 }, finish: 'stop', ...over }, parts,
  });
  const dump = (...messages: unknown[]) => JSON.stringify({ info: {}, messages });

  it('이 턴에 끝난 마지막 assistant 의 글만 잇는다', () => {
    const json = dump(msg({}, [{ type: 'reasoning', text: '생각' }, { type: 'text', text: '| a |\n|---|' }, { type: 'step-finish' }]));
    expect(lastSaidFromOpencodeExport(json, SINCE)).toBe('| a |\n|---|');
  });

  it('도구 호출로 끝났거나, 안 끝났거나, 이 턴 것이 아니거나, 형식이 다르면 모른다', () => {
    const text = [{ type: 'text', text: '답' }];
    expect(lastSaidFromOpencodeExport(dump(msg({ finish: 'tool-calls' }, text)), SINCE)).toBeNull();
    expect(lastSaidFromOpencodeExport(dump(msg({ time: { created: SINCE + 1 } }, text)), SINCE)).toBeNull();
    expect(lastSaidFromOpencodeExport(dump(msg({ time: { created: SINCE - 1, completed: SINCE } }, text)), SINCE)).toBeNull();
    expect(lastSaidFromOpencodeExport(dump(msg({ role: 'user' }, text)), SINCE)).toBeNull();
    expect(lastSaidFromOpencodeExport('{깨짐', SINCE)).toBeNull();
  });
});

describe('표에 재 본 하네스만 적는다', () => {
  it('codex·opencode 만 읽고 나머지는 화면 답을 쓴다', () => {
    expect(lastSaidRecordOf('codex')).toBe('codex-rollout');
    expect(lastSaidRecordOf('opencode')).toBe('opencode-export');
    expect(lastSaidRecordOf('kilo')).toBeNull();
    expect(lastSaidRecordOf('claude-code')).toBeNull();
  });
});

describe('silentTurnNotice — 기록의 끝말을 화면 답보다 먼저 옮긴다', () => {
  const base = { offAnchor: null, pat: 'hrkp_secretpat', screenEnded: true, screenAnswer: '화면 첫 줄' } as const;
  const table = '| PR |\n|---|\n| #1 |';

  for (const caller of ['human', 'agent'] as const) {
    it(`${caller}: 줄을 살려 옮기고 기록에서 옮겼다고 밝힌다`, () => {
      const n = silentTurnNotice({ ...base, caller, lastSaid: table, recordAnswer: table });
      const body = (n as { body: string }).body;
      expect(body).toContain('> | PR |\n> |---|\n> | #1 |');
      expect(body).toContain('하네스 기록에서 옮겨');
      expect(body).not.toContain('화면 첫 줄');
    });

    it(`${caller}: 기록을 못 읽으면 화면 답으로 돌아간다`, () => {
      const n = silentTurnNotice({ ...base, caller, lastSaid: '화면 첫 줄', recordAnswer: null });
      expect((n as { body: string }).body).toContain('> 화면 첫 줄');
    });
  }

  it('비밀 조각에 걸리면 화면 답으로도 옮기지 않는다', () => {
    const secret = 'S3CRET-VALUE-0123456789';
    const n = silentTurnNotice({ ...base, caller: 'human', lastSaid: null, recordAnswer: `값 ${secret.slice(0, 14)}`, screenAnswer: '화면 첫 줄', secrets: [secret] });
    expect((n as { body: string }).body).not.toContain(secret.slice(0, 14));
  });
});
