import { beforeEach, describe, expect, it } from 'vitest';
import { lastChannelStorage, operatorAutoRegisteredStorage } from '../src/lib/prefs';

describe('operatorAutoRegisteredStorage — 자동 등록은 커뮤니티마다 한 번(격리 C P8)', () => {
  beforeEach(() => localStorage.clear());

  it('표시 전에는 없고, 표시하면 그 커뮤니티만 있다', () => {
    expect(operatorAutoRegisteredStorage.has('https://a.example.com')).toBe(false);
    operatorAutoRegisteredStorage.mark('https://a.example.com');
    expect(operatorAutoRegisteredStorage.has('https://a.example.com')).toBe(true);
    expect(operatorAutoRegisteredStorage.has('https://b.example.com')).toBe(false);
  });

  it('끝 슬래시는 같은 커뮤니티로 본다', () => {
    operatorAutoRegisteredStorage.mark('https://a.example.com/');
    expect(operatorAutoRegisteredStorage.has('https://a.example.com')).toBe(true);
  });

  it('로그아웃(마지막 채널 지우기)과 수명이 다르다 — 기계의 사실이라 남는다', () => {
    operatorAutoRegisteredStorage.mark('https://a.example.com');
    lastChannelStorage.clear();
    expect(operatorAutoRegisteredStorage.has('https://a.example.com')).toBe(true);
  });

  it('깨진 값이면 없는 것으로 본다', () => {
    localStorage.setItem('harkroom.operatorAutoRegistered', '{not json');
    expect(operatorAutoRegisteredStorage.has('https://a.example.com')).toBe(false);
  });
});
