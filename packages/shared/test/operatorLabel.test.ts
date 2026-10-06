import { describe, expect, it } from 'vitest';
import { normalizeOperatorLabel as n } from '../src/operatorLabel.js';

describe('normalizeOperatorLabel — 서버와 앱이 같은 정리를 한다', () => {
  it('앞뒤 공백을 자르고 줄바꿈·탭·특수 공백은 공백 하나로 접는다', () => {
    expect(n('  작업용\n맥북\t ')).toBe('작업용 맥북');
    expect(n('a  b c')).toBe('a b c');
  });

  it('보이지 않는 글자(폭 없는 글자·방향 바꾸는 글자·제어 문자)는 지운다', () => {
    expect(n('ab​c')).toBe('abc');
    expect(n('x‮gnp.exe')).toBe('xgnp.exe');
    expect(n('⁦abc⁩')).toBe('abc');
    expect(n('a\u0007b﻿')).toBe('ab');
    expect(n('a‍b')).toBe('ab');
  });

  it('빈칸처럼 보이는 글자(한글 채움 글자·점자 빈칸·결합 무시 글자)도 지운다', () => {
    for (const c of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⠀', '͏', '឴']) {
      expect(n(`a${c}b`)).toBe('ab');
      expect(n(c)).toBeNull();
    }
  });

  it('그림 글자 사이의 ZWJ 는 남긴다 — 피부색 수식 글자·FE0F 뒤에서도', () => {
    expect(n('\u{1F469}‍\u{1F4BB} dev')).toBe('\u{1F469}‍\u{1F4BB} dev');
    expect(n('❤️‍\u{1F525}')).toBe('❤️‍\u{1F525}');
    expect(n('\u{1F469}\u{1F3FD}‍\u{1F4BB}')).toBe('\u{1F469}\u{1F3FD}‍\u{1F4BB}');
  });

  it('ZWJ 가 겹치거나 그림 글자 사이가 아니면 지운다', () => {
    expect(n('\u{1F469}‍‍\u{1F4BB}')).toBe('\u{1F469}\u{1F4BB}');
    expect(n('\u{1F469}‍​\u{1F4BB}')).toBe('\u{1F469}\u{1F4BB}');
    expect(n('‍\u{1F4BB}')).toBe('\u{1F4BB}');
  });

  it('변이 선택자는 이모지가 될 수 있는 글자 바로 뒤에서만 남긴다', () => {
    expect(n('❤️')).toBe('❤️');
    expect(n('1️⃣')).toBe('1️⃣');
    expect(n('️ab')).toBe('ab');
    expect(n('a️b')).toBe('ab');
  });

  it('지역 깃발의 태그 글자는 남기고, 깃발 줄 밖의 태그 글자는 지운다', () => {
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    expect(n(`${scotland} box`)).toBe(`${scotland} box`);
    expect(n('a\u{E0067}\u{E0062}b')).toBe('ab');
    // 끝 태그가 없으면 깃발 줄이 아니다.
    expect(n('\u{1F3F4}\u{E0067}\u{E0062}')).toBe('\u{1F3F4}');
  });

  it('깃발 줄은 소문자·숫자 태그 3~7개만 받는다 — 그 밖의 태그 줄은 지운다', () => {
    // 대문자·공백 태그
    expect(n('\u{1F3F4}\u{E0047}\u{E0042}\u{E0020}\u{E007F}')).toBe('\u{1F3F4}');
    // 소문자 사이에 대문자 하나
    expect(n('\u{1F3F4}\u{E0067}\u{E0042}\u{E0073}\u{E007F}')).toBe('\u{1F3F4}');
    // 너무 짧다(2개)·너무 길다(8개)
    expect(n('\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}')).toBe('\u{1F3F4}');
    const eight = '\u{E0061}'.repeat(8);
    expect(n(`\u{1F3F4}${eight}\u{E007F}`)).toBe('\u{1F3F4}');
    // 숫자 태그는 받는다(3개·7개 경계)
    const three = '\u{1F3F4}\u{E0075}\u{E0073}\u{E0031}\u{E007F}';
    expect(n(three)).toBe(three);
    const seven = `\u{1F3F4}${'\u{E0061}'.repeat(7)}\u{E007F}`;
    expect(n(seven)).toBe(seven);
  });

  it('짝 없는 서러게이트는 지운다', () => {
    expect(n('a\uD800b')).toBe('ab');
    expect(n('a\uDC00b')).toBe('ab');
    expect(n('\uD83D')).toBeNull();
  });

  it('결합 문자·한글은 그대로 둔다', () => {
    expect(n('é 회사')).toBe('é 회사');
  });

  it('남는 것이 없으면 null(호스트명으로 돌아간다)', () => {
    expect(n(null)).toBeNull();
    expect(n(undefined)).toBeNull();
    expect(n('')).toBeNull();
    expect(n(' ​‎\n')).toBeNull();
  });
});
