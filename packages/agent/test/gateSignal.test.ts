import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateSignalOf, stallScreenOf } from '../src/mentionTurn.js';
import { attachesGateHook } from '../src/turn.js';

// 하네스 물음 C안 P2 — 「확인을 기다려 멈춤」은 신호 파일(Notification permission_prompt)로만 판정한다.
describe('멈춤 신호 파일', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-signal-'));

  it('줄 수와 마지막 시각을 읽는다 — 없거나 깨진 줄은 세지 않는다', () => {
    const f = join(dir, 'a');
    expect(gateSignalOf(f)).toEqual({ count: 0, lastAtMs: null });
    writeFileSync(f, '1000\nxx\n2000\n');
    expect(gateSignalOf(f)).toEqual({ count: 2, lastAtMs: 2000 });
  });

  const gateScreen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n';

  it('신호가 있는 턴: 마지막 신호 뒤로 진행이 없으면 gate, 화면이 관문처럼 보여도 신호가 없으면 gate 가 아니다', () => {
    expect(stallScreenOf(null, gateScreen, 'claude-code', { count: 1, lastAtMs: 5000, lastProgressAtMs: 4000 })).toBe('gate');
    expect(stallScreenOf(null, gateScreen, 'claude-code', { count: 0, lastAtMs: null, lastProgressAtMs: 4000 })).toBe('stuck');
    // 신호 뒤에 화면이 진행했다 = 그 물음은 지나갔다.
    expect(stallScreenOf(null, gateScreen, 'claude-code', { count: 1, lastAtMs: 3000, lastProgressAtMs: 4000 })).toBe('stuck');
  });

  it('신호가 없는 하네스는 지금처럼 화면으로 판정한다', () => {
    expect(stallScreenOf(null, gateScreen, 'claude-code', null)).toBe('gate');
  });

  it('신호 hook 은 구독형 auto claude 멘션 턴에만 — 읽기 전용·API 키 연결·codex 는 화면 판정', () => {
    expect(attachesGateHook('claude-code', 'auto')).toBe(true);
    expect(attachesGateHook('claude-code', 'auto', true)).toBe(false);
    expect(attachesGateHook('claude-code', 'readonly')).toBe(false);
    expect(attachesGateHook('codex', 'auto')).toBe(false);
  });
});
