import { describe, expect, it } from 'vitest';
import { normalizeOperatorLabel } from '../src/operatorLabel.js';

describe('normalizeOperatorLabel — 서버와 앱이 같은 정리를 한다', () => {
  it('앞뒤 공백을 자르고 줄바꿈·탭·특수 공백은 공백 하나로 접는다', () => {
    expect(normalizeOperatorLabel('  작업용\n맥북\t ')).toBe('작업용 맥북');
    expect(normalizeOperatorLabel('a  b c')).toBe('a b c');
  });

  it('보이지 않는 글자(폭 없는 글자·방향 바꾸는 글자·제어 문자)는 지운다', () => {
    expect(normalizeOperatorLabel('ab​c')).toBe('abc');
    expect(normalizeOperatorLabel('x‮gnp.exe')).toBe('xgnp.exe');
    expect(normalizeOperatorLabel('⁦abc⁩')).toBe('abc');
    expect(normalizeOperatorLabel('a\u0007b﻿')).toBe('ab');
    expect(normalizeOperatorLabel('a‍b')).toBe('ab');
  });

  it('그림 글자 사이의 ZWJ 는 남긴다 — 이모지 이름이 깨지지 않게', () => {
    expect(normalizeOperatorLabel('👩‍💻 dev')).toBe('👩‍💻 dev');
    expect(normalizeOperatorLabel('❤️‍🔥')).toBe('❤️‍🔥');
  });

  it('결합 문자·한글은 그대로 둔다', () => {
    expect(normalizeOperatorLabel('é 회사')).toBe('é 회사');
  });

  it('남는 것이 없으면 null(호스트명으로 돌아간다)', () => {
    expect(normalizeOperatorLabel(null)).toBeNull();
    expect(normalizeOperatorLabel(undefined)).toBeNull();
    expect(normalizeOperatorLabel('')).toBeNull();
    expect(normalizeOperatorLabel(' ​‎\n')).toBeNull();
  });
});
