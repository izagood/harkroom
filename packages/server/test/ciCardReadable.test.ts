import { describe, expect, it } from 'vitest';
import { readAskMeta } from '@harkroom/shared';
import { permissionCardOptions } from '../src/services/permissionRequests.js';

/**
 * 서버가 싣는 권한 카드 선택지를 화면·글 승인·거울이 쓰는 같은 판정(`readAskMeta`)이 읽어야 한다(2026-10-28).
 * CI 거절 카드는 선택지가 [거절] 하나라 2개 경계에 걸려 카드 전체가 「카드 아님」이 됐고, 승인 버튼까지 사라졌다.
 */
describe('permission card options are readable as an ask card', () => {
  const meta = (options: { id: string; label: string }[], extra: Record<string, unknown>) => ({ kind: 'ask', ask: { options, to: { kind: 'human' } }, ...extra });

  it.each([
    ['merge CI card', permissionCardOptions('merge', { ciOnce: true, once: true })],
    ['merge card', permissionCardOptions('merge', { once: true })],
    ['tool card', permissionCardOptions('tool', { mandate: true })],
    ['command card', permissionCardOptions('command')],
  ])('%s', (_name, options) => {
    expect(readAskMeta(meta(options, { permissionRequest: { requestId: 'r1', kind: 'merge' } }))?.options).toEqual(options);
    expect(readAskMeta(meta(options, { permissionMirror: { rootId: 'root-1', neutral: false } }))?.options).toEqual(options);
  });

  it('a one-option ask without the server permission fields stays a plain message', () => {
    expect(readAskMeta(meta([{ id: 'deny', label: '거절' }], {}))).toBeNull();
    expect(readAskMeta(meta([{ id: 'deny', label: '거절' }], { permissionMirror: { neutral: true } }))).toBeNull();
  });
});
