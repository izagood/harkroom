import { describe, it, expect } from 'vitest';
import { createTypingRegistry } from '../src/ws/typing.js';

const TTL = 5000;

describe('who is typing', () => {
  it('reports nobody at the start', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });

    expect(reg.who('c1')).toEqual([]);
  });

  it('reports the person who just started', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });

    reg.mark('c1', 'u1');

    expect(reg.who('c1')).toEqual(['u1']);
  });

  it('keeps channels apart', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });

    reg.mark('c1', 'u1');

    expect(reg.who('c2')).toEqual([]);
  });

  it('counts one person once however often they keep typing', () => {
    let t = 0;
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => t });

    reg.mark('c1', 'u1');
    t = 100;
    reg.mark('c1', 'u1');

    expect(reg.who('c1')).toEqual(['u1']);
  });

  // 타이핑은 멈춘 것을 알려 주는 신호가 없을 수도 있다 — 탭을 닫거나 네트워크가 끊기면
  // stop 이 오지 않는다. 만료가 없으면 '입력 중'이 영원히 남는다.
  it('forgets someone who stopped sending signals', () => {
    let t = 0;
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => t });
    reg.mark('c1', 'u1');

    t = TTL + 1;

    expect(reg.who('c1')).toEqual([]);
  });

  it('keeps someone who is still within the window', () => {
    let t = 0;
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => t });
    reg.mark('c1', 'u1');

    t = TTL - 1;

    expect(reg.who('c1')).toEqual(['u1']);
  });

  it('extends the window each time they type again', () => {
    let t = 0;
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => t });
    reg.mark('c1', 'u1');

    t = TTL - 1;
    reg.mark('c1', 'u1');
    t = TTL + 1;

    expect(reg.who('c1')).toEqual(['u1']);
  });

  // 메시지를 보내면 입력이 끝난 것이다. 만료를 기다리면 자기 메시지 아래에 '입력 중'이 남는다.
  it('clears someone the moment they stop', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });
    reg.mark('c1', 'u1');

    reg.clear('c1', 'u1');

    expect(reg.who('c1')).toEqual([]);
  });

  it('clears only that person', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });
    reg.mark('c1', 'u1');
    reg.mark('c1', 'u2');

    reg.clear('c1', 'u1');

    expect(reg.who('c1')).toEqual(['u2']);
  });

  // 소켓이 닫히면 그 사람은 어느 채널에서도 입력 중이 아니다.
  it('forgets a person everywhere at once', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });
    reg.mark('c1', 'u1');
    reg.mark('c2', 'u1');
    reg.mark('c1', 'u2');

    reg.forget('u1');

    expect(reg.who('c1')).toEqual(['u2']);
    expect(reg.who('c2')).toEqual([]);
  });

  it('is fine clearing someone who was never typing', () => {
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => 0 });

    expect(() => reg.clear('c1', 'nobody')).not.toThrow();
    expect(() => reg.forget('nobody')).not.toThrow();
  });

  // 만료된 항목을 읽기만 하고 지우지 않으면 오래 돌수록 메모리가 는다.
  it('does not keep expired entries around', () => {
    let t = 0;
    const reg = createTypingRegistry({ ttlMs: TTL, now: () => t });
    for (let i = 0; i < 50; i++) reg.mark(`c${i}`, `u${i}`);

    t = TTL + 1;
    for (let i = 0; i < 50; i++) reg.who(`c${i}`);

    expect(reg.size()).toBe(0);
  });
});
