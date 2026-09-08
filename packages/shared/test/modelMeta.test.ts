/**
 * 발화에 실린 모델(#600)의 **판정 함수들** 회귀선.
 *
 * 여기서 재는 것은 두 가지다. ① `readModelMeta` 가 모르는 모양을 조용히 흘리는가
 * (`readAskMeta` 가 세운 규약 — 형식을 못 알아보면 `null` 이고 화면은 아무것도 안 그린다).
 * ② `modelsDisagree` 가 **같은 모델의 다른 이름**을 어긋남으로 오판하지 않는가. ②가 이
 * 기능의 급소다: 거짓 ⚠️ 가 한 번 나오면 사람은 그 뒤로 배지를 안 믿고, 그러면 진짜
 * 어긋남도 못 잡는다.
 *
 * 화면 배선(hover · ⚠️)은 `desktop/test/messageModel.test.tsx` 가,
 * meta 를 싣는 경로는 `server/test/mcp.test.ts` 가 잰다.
 */
import { describe, expect, it } from 'vitest';
import { MODEL_ID_MAX, modelFamily, modelsDisagree, readModelMeta } from '../src/index.js';

describe('readModelMeta', () => {
  it('모델 ID 를 그대로 읽고, 앞뒤 공백만 다듬는다', () => {
    expect(readModelMeta({ model: { id: 'claude-opus-5[1m]' } })).toEqual({ id: 'claude-opus-5[1m]' });
    expect(readModelMeta({ model: { id: '  claude-sonnet-5  ' } })).toEqual({ id: 'claude-sonnet-5' });
  });

  it('어긋남은 `true` 일 때만 남는다 — 아무 값이나 참으로 읽지 않는다', () => {
    expect(readModelMeta({ model: { id: 'x-opus', mismatch: true } })).toEqual({ id: 'x-opus', mismatch: true });
    expect(readModelMeta({ model: { id: 'x-opus', mismatch: 'yes' } })).toEqual({ id: 'x-opus' });
  });

  it('모르는 모양은 조용히 `null` 이다 — 본문은 그대로 남는다', () => {
    expect(readModelMeta(undefined)).toBeNull();
    expect(readModelMeta({})).toBeNull();
    expect(readModelMeta({ model: 'claude-opus-5' })).toBeNull();
    expect(readModelMeta({ model: { id: '' } })).toBeNull();
    expect(readModelMeta({ model: { id: '   ' } })).toBeNull();
    expect(readModelMeta({ model: { id: 'a'.repeat(MODEL_ID_MAX + 1) } })).toBeNull();
  });

  it('다른 종류의 meta 를 지우지 않는다 — 모델은 kind 와 직교한다', () => {
    // 완료 보고가 모델을 실어도 보고로 남아야 한다. `kind` 를 보는 판정이면 여기서 깨진다.
    expect(readModelMeta({ kind: 'report', report: { checks: ['t'] }, model: { id: 'claude-opus-5' } }))
      .toEqual({ id: 'claude-opus-5' });
  });
});

describe('modelsDisagree', () => {
  it('같은 모델의 다른 이름은 어긋남이 아니다 — 별칭·꾸밈·대소문자', () => {
    expect(modelsDisagree('opus', 'claude-opus-5')).toBe(false);
    expect(modelsDisagree('claude-opus-5', 'claude-opus-5[1m]')).toBe(false);
    expect(modelsDisagree('Claude-Opus-5', 'claude-opus-5')).toBe(false);
  });

  it('계열이 다르면 어긋남이다 — 이 기능이 잡으려던 그 경우', () => {
    // "간단한 작업인데 Fable, 어려운 작업인데 Opus" — 설정과 실제가 갈린 자리.
    expect(modelsDisagree('claude-fable-5-1', 'claude-opus-5')).toBe(true);
    expect(modelsDisagree('opus', 'claude-haiku-4-5-20251001')).toBe(true);
  });

  it('설정이 비어 있으면 어긋남이 없다 — 하네스가 고른 것이 곧 설정이다', () => {
    expect(modelsDisagree(null, 'claude-opus-5')).toBe(false);
    expect(modelsDisagree(undefined, 'claude-fable-5-1')).toBe(false);
  });

  it('모르는 이름은 조용히 넘긴다 — 목록이 뒤처져도 거짓 경고를 내지 않는다', () => {
    expect(modelFamily('some-new-model-9')).toBeNull();
    expect(modelsDisagree('some-new-model-9', 'claude-opus-5')).toBe(false);
    expect(modelsDisagree('claude-opus-5', 'some-new-model-9')).toBe(false);
  });
});
