// 동시 턴 상한(R1) — 오퍼레이터의 자리 장부(`turnSlots.ts`).
import { describe, expect, it } from 'vitest';
import type { RunnerLinkRequest } from '@harkroom/shared/runnerLink';
import { createTurnSlots, parseMaxTurns, TURN_SLOTS_PATH, TURN_SLOTS_RELEASE_PATH } from '../src/turnSlots.js';

let n = 0;
const req = (path: string, key: unknown = 'ch/T'): RunnerLinkRequest => ({
  type: 'http.forward', id: `r${n++}`, method: 'POST', path, body: JSON.stringify({ key }), contentType: 'application/json',
});
const status = (r: ReturnType<ReturnType<typeof createTurnSlots>['maybeHandle']>) => (r && r.type === 'http.response' ? r.status : null);

describe('parseMaxTurns', () => {
  it('없음·빈 값·0 은 상한 없음, 정수는 그 값, 이상한 값은 상한 없음 + 경고', () => {
    const logs: string[] = [];
    expect(parseMaxTurns(undefined)).toBeNull();
    expect(parseMaxTurns('')).toBeNull();
    expect(parseMaxTurns('0')).toBeNull();
    expect(parseMaxTurns(' 16 ')).toBe(16);
    expect(parseMaxTurns('-3', (l) => logs.push(l))).toBeNull();
    expect(parseMaxTurns('lots', (l) => logs.push(l))).toBeNull();
    expect(logs).toHaveLength(2);
  });
});

describe('createTurnSlots', () => {
  it('자리 요청이 아니면 손대지 않는다 — 서버로 갈 요청을 가로채지 않는다', () => {
    const s = createTurnSlots({ max: 1 });
    expect(s.maybeHandle('r1', req('/agent/thread-claims'))).toBeNull();
    expect(s.maybeHandle('r1', { type: 'mcp.request', id: 'x', payload: {} })).toBeNull();
    expect(s.maybeHandle('r1', { ...req(TURN_SLOTS_PATH), method: 'GET' } as RunnerLinkRequest)).toBeNull();
  });

  it('러너를 합쳐 센다: 상한 2 면 세 번째는 409, 놓으면 다시 200', () => {
    const s = createTurnSlots({ max: 2 });
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'a')))).toBe(200);
    expect(status(s.maybeHandle('r2', req(TURN_SLOTS_PATH, 'a')))).toBe(200);
    expect(status(s.maybeHandle('r3', req(TURN_SLOTS_PATH, 'a')))).toBe(409);
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_RELEASE_PATH, 'a')))).toBe(204);
    expect(status(s.maybeHandle('r3', req(TURN_SLOTS_PATH, 'a')))).toBe(200);
    expect(s.inUse()).toBe(2);
  });

  it('같은 (러너, 키)를 다시 잡으면 두 번 세지 않는다', () => {
    const s = createTurnSlots({ max: 1 });
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'a')))).toBe(200);
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'a')))).toBe(200);
    expect(s.inUse()).toBe(1);
  });

  it('남의 자리는 놓지 못한다 — 키는 링크 인증이 정한 runnerId 아래에 있다', () => {
    const s = createTurnSlots({ max: 1 });
    s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'a'));
    expect(status(s.maybeHandle('r2', req(TURN_SLOTS_RELEASE_PATH, 'a')))).toBe(204);
    expect(s.inUse()).toBe(1);
    expect(status(s.maybeHandle('r2', req(TURN_SLOTS_PATH, 'b')))).toBe(409);
  });

  /** 되돌려 RED: `releaseRunner` 를 비우면 죽은 러너의 자리가 영영 남아 r2 가 409 를 받는다. */
  it('러너가 죽으면(링크 끊김) 그 러너의 자리를 전부 돌려받는다', () => {
    const s = createTurnSlots({ max: 2 });
    s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'a'));
    s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'b'));
    expect(status(s.maybeHandle('r2', req(TURN_SLOTS_PATH, 'c')))).toBe(409);
    s.releaseRunner('r1');
    expect(s.inUse()).toBe(0);
    expect(status(s.maybeHandle('r2', req(TURN_SLOTS_PATH, 'c')))).toBe(200);
  });

  it('상한이 없으면 언제나 준다', () => {
    const s = createTurnSlots({ max: null });
    for (let i = 0; i < 50; i++) expect(status(s.maybeHandle(`r${i}`, req(TURN_SLOTS_PATH, 'k')))).toBe(200);
  });

  it('key 가 없거나 너무 길면 400', () => {
    const s = createTurnSlots({ max: 1 });
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_PATH, '')))).toBe(400);
    expect(status(s.maybeHandle('r1', req(TURN_SLOTS_PATH, 'x'.repeat(600))))).toBe(400);
    expect(status(s.maybeHandle('r1', { ...req(TURN_SLOTS_PATH), body: 'not json' } as RunnerLinkRequest))).toBe(400);
  });
});
