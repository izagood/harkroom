import { describe, it, expect, vi } from 'vitest';
import { createGuideCache, GUIDE_HEAD, guideHeadForLog, isGuideText } from '../src/guideCache.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const G = (tag: string) => `${GUIDE_HEAD} (에이전트용)\n${tag}\n`;

describe('guideCache — 가이드를 TTL 로 다시 받는다 (2026-10-27 f6)', () => {
  it('TTL 안에서는 다시 받지 않는다', () => {
    const fetch = vi.fn(async () => G('new'));
    let t = 0;
    const c = createGuideCache({ initial: G('old'), fetch, ttlMs: 100, now: () => t });
    t = 99;
    expect(c.current()).toBe(G('old'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('TTL 이 지나면 가진 값을 돌려주고 뒤에서 받아, 다음 턴부터 새 판을 준다', async () => {
    const fetch = vi.fn(async () => G('new'));
    let t = 0;
    const c = createGuideCache({ initial: G('old'), fetch, ttlMs: 100, now: () => t });
    t = 100;
    expect(c.current()).toBe(G('old'));
    expect(c.current()).toBe(G('old'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await flush();
    expect(c.current()).toBe(G('new'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('다시 받기에 실패하면 가진 값을 그대로 쓰고, TTL 동안은 다시 부르지 않는다', async () => {
    const onError = vi.fn();
    const fetch = vi.fn(async () => { throw new Error('down'); });
    let t = 0;
    const c = createGuideCache({ initial: G('old'), fetch, ttlMs: 100, now: () => t, onError });
    t = 100;
    c.current();
    await flush();
    expect(c.current()).toBe(G('old'));
    expect(onError).toHaveBeenCalledTimes(1);
    t = 150;
    c.current();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  // #1609 security n1: 이상한 응답(`{}` 가 JSON 글자로 온 것·빈 글자)이 좋은 판을 덮지 않는다.
  it('다시 받은 값이 가이드 머리로 시작하지 않으면 가진 판을 쓰고 실패로 알린다', async () => {
    for (const bad of ['{}', '', '{"error":"x"}', `x${G('new')}`]) {
      const onError = vi.fn();
      let t = 0;
      const c = createGuideCache({ initial: G('old'), fetch: async () => bad, ttlMs: 100, now: () => t, onError });
      t = 100;
      c.current();
      await flush();
      expect(c.current(), bad).toBe(G('old'));
      expect(onError, bad).toHaveBeenCalledTimes(1);
    }
  });

  // #1616 security m1: 글자가 아닌 응답(숫자·null·객체)도 던지지 않고 가진 판을 쓴다 — 처리되지 않은 거부로 러너가 죽지 않는다.
  it('다시 받은 값이 글자가 아니면 던지지 않고 가진 판을 쓴다', async () => {
    for (const bad of [42, null, undefined, { guide: 'x' }] as unknown[]) {
      const onError = vi.fn();
      let t = 0;
      const c = createGuideCache({ initial: G('old'), fetch: async () => bad as string, ttlMs: 100, now: () => t, onError });
      t = 100;
      c.current();
      await flush();
      expect(c.current(), String(bad)).toBe(G('old'));
      expect(onError, String(bad)).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]![0])).toContain('모양이 다르다');
    }
  });

  it('isGuideText·guideHeadForLog 는 글자가 아닌 값을 받아도 던지지 않는다', () => {
    expect(isGuideText(G('x'))).toBe(true);
    for (const v of [42, null, undefined, {}, '{}']) expect(isGuideText(v), String(v)).toBe(false);
    expect(guideHeadForLog(null)).toBe('(null)');
    expect(guideHeadForLog(42)).toBe('(number)');
  });
});
