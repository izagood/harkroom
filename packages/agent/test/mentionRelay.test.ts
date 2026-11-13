import { describe, expect, it } from 'vitest';
import { createMentionRelay } from '../src/mentionRelay.js';

/** 멘션 하나에 중계 세션 하나 — 시도 사이에 온 [중단] 도 받고, 시도마다 입력 통로는 그 시도의 것만. */
function fakeRelay() {
  const frames: string[] = [];
  let cancel: ((by: string) => void) | undefined;
  let writer: ((b: Buffer) => void) | null = null;
  const relay = {
    openSession(input: { onCancel?: (by: string) => void }) {
      cancel = input.onCancel;
      frames.push('open');
      return {
        sessionId: 's-1',
        push: () => {},
        bindInput: (w: { write(b: Buffer): void }) => { writer = (b) => w.write(b); },
        needsAttention: () => {},
        close: () => { frames.push('close'); },
        unbindInput: () => { writer = null; frames.push('unbind'); },
        restate: (r: { claudeAccountRank?: number | null }) => { frames.push(`restate:${String(r.claudeAccountRank)}`); },
      };
    },
  };
  return { relay, frames, cancelBy: (by: string) => cancel?.(by), input: (b: string) => writer?.(Buffer.from(b)) };
}

const base = { agentAccountId: 'a', channelId: 'c', threadRootId: 't', harness: 'claude-code' as const, acceptsInput: true };

describe('mentionRelay', () => {
  it('세션은 멘션 내내 하나 — 뒤 시도는 같은 세션에 붙어 계정 순번만 고치고, 닫기는 멘션 끝에 한 번', () => {
    const f = fakeRelay();
    const mr = createMentionRelay(f.relay);
    const a1 = mr.openSession({ ...base, claudeAccountRank: 1 });
    a1.close();
    const a2 = mr.openSession({ ...base, claudeAccountRank: 2 });
    expect(a2.sessionId).toBe(a1.sessionId);
    a2.close();
    mr.close();
    mr.close();
    expect(f.frames).toEqual(['open', 'unbind', 'restate:2', 'unbind', 'close']);
  });

  it('시도 사이에 온 [중단] 은 다음 시도가 붙는 순간 그 시도의 onCancel 로 간다(처음 사람)', () => {
    const f = fakeRelay();
    const mr = createMentionRelay(f.relay);
    const got: string[] = [];
    mr.openSession({ ...base, onCancel: (by) => got.push(`a1:${by}`) }).close();
    f.cancelBy('alice');
    f.cancelBy('bob');
    expect(got).toEqual([]);
    expect(mr.canceledBy()).toBe('alice');
    mr.openSession({ ...base, onCancel: (by) => got.push(`a2:${by}`) });
    expect(got).toEqual(['a2:alice']);
  });

  it('도는 시도에 온 [중단] 은 그 시도로 곧장 간다', () => {
    const f = fakeRelay();
    const mr = createMentionRelay(f.relay);
    const got: string[] = [];
    mr.openSession({ ...base, onCancel: (by) => got.push(by) });
    f.cancelBy('alice');
    expect(got).toEqual(['alice']);
  });

  it('시도가 끝나면 그 시도의 입력 통로를 놓는다 — 사이에 온 입력은 버리고 다음 시도의 통로로만 간다', () => {
    const f = fakeRelay();
    const mr = createMentionRelay(f.relay);
    const w1: string[] = [];
    const w2: string[] = [];
    const a1 = mr.openSession(base);
    a1.bindInput({ write: (b: Buffer) => w1.push(b.toString()), resize: () => {} } as never);
    f.input('one');
    a1.close();
    f.input('between');
    a1.bindInput({ write: (b: Buffer) => w1.push(`late:${b.toString()}`), resize: () => {} } as never);
    const a2 = mr.openSession(base);
    a2.bindInput({ write: (b: Buffer) => w2.push(b.toString()), resize: () => {} } as never);
    f.input('two');
    expect(w1).toEqual(['one']);
    expect(w2).toEqual(['two']);
  });
});
