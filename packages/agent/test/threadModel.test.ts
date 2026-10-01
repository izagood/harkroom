// 스레드 × 에이전트 모델 지정(서버 079)을 러너가 읽는 자리 — `threadModel.ts`·`policy.ts`.
import { describe, it, expect } from 'vitest';
import { resolveTurnModel, rootFromThreadKey, usesThreadModel } from '../src/threadModel.js';
import { isThreadModelRejected } from '../src/policy.js';
import { threadModelRejectedNotice } from '../src/prompt.js';

const def = { model: 'sonnet', effort: 'medium' };

describe('resolveTurnModel', () => {
  it('서버 실효값을 그대로 쓴다 — 여기서 다시 합치지 않는다', async () => {
    const got = await resolveTurnModel({
      threadModel: async (id) => {
        expect(id).toBe('m1');
        return { model: 'opus', effort: 'medium', source: { model: 'thread', effort: 'agent' } };
      },
    }, def, 'm1');
    expect(got).toEqual({ model: 'opus', effort: 'medium', source: { model: 'thread', effort: 'agent' } });
    expect(usesThreadModel(got)).toBe(true);
  });
  it('옛 서버(404)·링크 오류면 정의로 물러나고 턴을 막지 않는다 — 대신 로그를 남긴다', async () => {
    const lines: string[] = [];
    const got = await resolveTurnModel({ threadModel: async () => { throw new Error('agent/thread-model 실패: 404'); } }, def, 'm1', (l) => lines.push(l));
    expect(got).toEqual({ model: 'sonnet', effort: 'medium', source: { model: 'agent', effort: 'agent' } });
    expect(usesThreadModel(got)).toBe(false);
    expect(lines[0]).toContain('404');
  });
  it('앵커가 없으면 묻지 않는다', async () => {
    const got = await resolveTurnModel({ threadModel: async () => { throw new Error('부르면 안 된다'); } }, def, null);
    expect(got.model).toBe('sonnet');
  });
});

describe('rootFromThreadKey', () => {
  it('채널 최상위 세션(_root)에는 루트가 없다', () => {
    expect(rootFromThreadKey('c1/_root')).toBeNull();
    expect(rootFromThreadKey('c1/r1')).toBe('r1');
  });
});

describe('isThreadModelRejected', () => {
  const failed = (props: Record<string, unknown>) => Object.assign(new Error('harness API 에러'), props);
  const tm = { model: 'gpt-5.4-mini', effort: null, source: { model: 'thread', effort: 'agent' } };
  it('스레드 지정으로 돈 턴 + 모델을 말하는 API 에러 → 거절(실측 문구 둘)', () => {
    // codex 0.15x(2026-10-01 실측), claude 2.1.283(같은 날 실측)
    for (const apiError of [
      "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
      "There's an issue with the selected model (bogus). It may not exist or you may not have access to it.",
    ]) {
      expect(isThreadModelRejected(failed({ threadModel: tm, harnessApiError: apiError }))).toMatchObject({ model: 'gpt-5.4-mini' });
    }
  });
  it('지정 없이 돈 턴, 모델과 무관한 일시 장애는 거절이 아니다 — 멀쩡한 지정을 풀게 하지 않는다', () => {
    expect(isThreadModelRejected(failed({ harnessApiError: 'model not found' }))).toBeNull();
    expect(isThreadModelRejected(failed({ threadModel: tm, harnessApiError: 'Overloaded (529)' }))).toBeNull();
    expect(isThreadModelRejected(failed({ threadModel: tm }))).toBeNull();
  });
  it('통지는 할 일(칩에서 되돌리기)을 말하고 다시 시도하지 않는다고 밝힌다', () => {
    const n = threadModelRejectedNotice('opus', 'xhigh', 'x\ny');
    expect(n).toContain('opus · xhigh');
    expect(n).toContain('다시 시도하지 않습니다');
    expect(n).toContain('x y');
  });
});
