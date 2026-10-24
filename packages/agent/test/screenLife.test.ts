import { describe, expect, it } from 'vitest';
import { screenShowsProgress } from '../src/screenLife.js';

describe('screenShowsProgress', () => {
  // 실측 바이트(claude 2.1.310, 도구 확인 창이 사람을 기다리는 동안 0.6초마다 번갈아 온다).
  const blinkOn = '\x1b[H\r\x1b[9B\x1b[38;5;246m⏺\x1b[39m\x1b[40;1H\x1b[22;2H';
  const blinkOff = '\x1b[H\r\x1b[9B\x1b[38;5;246m \x1b[39m\x1b[40;1H\x1b[22;2H';

  it('확인 창의 ⏺ 깜빡임은 진행이 아니다', () => {
    expect(screenShowsProgress(blinkOn)).toBe(false);
    expect(screenShowsProgress(blinkOff)).toBe(false);
    expect(screenShowsProgress('\x1b]0;title\x07\x1b[?25l')).toBe(false);
  });

  it('글자가 남는 화면은 진행이다 — 스피너 문구·토큰 수·명령 출력', () => {
    expect(screenShowsProgress('\x1b[38;5;174m✢\x1b[39m Puzzling… (3s · ↓ 541 tokens)')).toBe(true);
    expect(screenShowsProgress('total 0\r\n')).toBe(true);
    expect(screenShowsProgress('Ask anything…')).toBe(true);
  });

  it('잘린 시퀀스가 남으면 진행으로 센다(지금 동작 쪽으로 틀린다)', () => {
    expect(screenShowsProgress('[22;2H')).toBe(true);
  });
});
