import { describe, expect, it } from 'vitest';

import {
  CLAUDE_POOL_NAME_PATTERN,
  orderAccounts,
  parseClaudePoolsConfig,
  resolvePoolName,
} from '../src/claudePools.js';

const EMPTY = { defaultPool: null, order: {}, agents: {} };

describe('parseClaudePoolsConfig', () => {
  it('빈 값·쓰레기 값에서 빈 설정을 낸다 — 던지지 않는다', () => {
    // 이 파일은 UI 가 쓰고 사람이 손댈 수 있다. 던지면 러너가 뜨지 않고, 그때
    // 사용자는 앱에서 고칠 방법이 없다.
    for (const raw of [undefined, null, 42, 'x', []]) {
      expect(parseClaudePoolsConfig(raw)).toEqual(EMPTY);
    }
    expect(parseClaudePoolsConfig({})).toEqual(EMPTY);
  });

  it('세 필드를 읽는다', () => {
    expect(parseClaudePoolsConfig({
      defaultPool: 'work',
      order: { work: ['aria', 'cedar'] },
      agents: { a1: 'personal' },
    })).toEqual({ defaultPool: 'work', order: { work: ['aria', 'cedar'] }, agents: { a1: 'personal' } });
  });

  it('모양이 틀린 항목만 버리고 나머지는 살린다', () => {
    const cfg = parseClaudePoolsConfig({
      defaultPool: 42,                        // 문자열이 아니다
      order: { work: ['aria', 7], bad: 'x' }, // 원소·값이 배열이 아니다
      agents: { a1: 'personal', a2: 9 },      // 값이 문자열이 아니다
    });
    expect(cfg.defaultPool).toBe(null);
    expect(cfg.order).toEqual({ work: ['aria'] });
    expect(cfg.agents).toEqual({ a1: 'personal' });
  });

  it('이름 문법에 안 맞는 풀·계정 이름을 버린다', () => {
    // 이 이름은 경로 세그먼트가 된다 — 문법에서 끊는다.
    const cfg = parseClaudePoolsConfig({
      defaultPool: '../escape',
      order: { 'Work Pool': ['aria'], work: ['Lime', 'cedar'] },
      agents: { a1: '../escape' },
    });
    expect(cfg.defaultPool).toBe(null);
    expect(cfg.order).toEqual({ work: ['cedar'] });
    expect(cfg.agents).toEqual({});
  });
});

describe('resolvePoolName', () => {
  const cfg = parseClaudePoolsConfig({
    defaultPool: 'work',
    order: {},
    agents: { a1: 'personal' },
  });

  it('강제 지정이 가장 세다', () => {
    expect(resolvePoolName(cfg, 'a1', 'forced')).toBe('forced');
  });

  it('에이전트 배정이 기본 풀보다 세다', () => {
    expect(resolvePoolName(cfg, 'a1')).toBe('personal');
  });

  it('배정이 없으면 기본 풀이다', () => {
    expect(resolvePoolName(cfg, 'a2')).toBe('work');
  });

  it('아무것도 없으면 null — 호출자가 암묵 풀로 떨어진다', () => {
    expect(resolvePoolName(EMPTY, 'a1')).toBe(null);
  });
});

describe('orderAccounts', () => {
  it('설정 순서를 따르고 나머지를 사전순으로 뒤에 붙인다', () => {
    // 뒤에 붙이는 이유: UI 가 순서를 쓴 뒤 사람이 계정을 새로 만들 수 있다.
    // 그때 그 계정이 사라지면 "만들었는데 안 쓴다"가 된다.
    const cfg = parseClaudePoolsConfig({ order: { work: ['cedar', 'aria'] } });
    expect(orderAccounts(cfg, 'work', ['aria', 'cedar', 'zebra'])).toEqual(['cedar', 'aria', 'zebra']);
  });

  it('설정에 있지만 디스크에 없는 이름은 조용히 빠진다', () => {
    // 디스크가 멤버십의 진실이다. 사람이 파인더에서 지웠을 수 있다.
    const cfg = parseClaudePoolsConfig({ order: { work: ['gone', 'aria'] } });
    expect(orderAccounts(cfg, 'work', ['aria'])).toEqual(['aria']);
  });

  it('순서 지정이 없으면 사전순이다', () => {
    expect(orderAccounts(EMPTY, 'work', ['cedar', 'aria'])).toEqual(['aria', 'cedar']);
  });
});

describe('CLAUDE_POOL_NAME_PATTERN', () => {
  it('경로 탈출과 대문자·공백을 거절한다', () => {
    for (const bad of ['..', '../x', 'a/b', 'Work', 'a b', '', 'x'.repeat(33)]) {
      expect(CLAUDE_POOL_NAME_PATTERN.test(bad)).toBe(false);
    }
    for (const ok of ['work', 'personal-2', 'a', 'x'.repeat(32)]) {
      expect(CLAUDE_POOL_NAME_PATTERN.test(ok)).toBe(true);
    }
  });
});
