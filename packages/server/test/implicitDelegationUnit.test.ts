import { describe, it, expect } from 'vitest';
import { implicitBodyFacts, implicitDelegationMode, planStepFor } from '../src/services/implicitDelegation.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const step = (id: string, state: 'pending' | 'active' | 'blocked' | 'done', assigneeId: string | null = A) =>
  ({ id, title: id, state, assigneeId, links: [], dependsOn: [] });

describe('implicitDelegationMode', () => {
  it('V2 가 꺼져 있으면 언제나 off', () => {
    expect(implicitDelegationMode({ HARKROOM_DELEGATION_IMPLICIT: 'on' })).toBe('off');
  });
  it('V2 가 켜져 있으면 기본은 shadow, on·off 로 바꾼다', () => {
    expect(implicitDelegationMode({ HARKROOM_DELEGATION_V2: '1' })).toBe('shadow');
    expect(implicitDelegationMode({ HARKROOM_DELEGATION_V2: '1', HARKROOM_DELEGATION_IMPLICIT: 'ON' })).toBe('on');
    expect(implicitDelegationMode({ HARKROOM_DELEGATION_V2: '1', HARKROOM_DELEGATION_IMPLICIT: 'off' })).toBe('off');
    expect(implicitDelegationMode({ HARKROOM_DELEGATION_V2: '1', HARKROOM_DELEGATION_IMPLICIT: 'weird' })).toBe('shadow');
  });
});

describe('implicitBodyFacts', () => {
  it('머리 멘션 런을 빼고 재며, 짧고 물음표가 있으면 짧은 질문', () => {
    expect(implicitBodyFacts(`<@${A}> 어느 브랜치?`)).toEqual({ bodyChars: 7, shortQuestion: true });
    expect(implicitBodyFacts(`<@${A}> 이 버그를 고쳐 달라`).shortQuestion).toBe(false);
    expect(implicitBodyFacts(`<@${A}> ${'가'.repeat(250)}?`).shortQuestion).toBe(false);
  });
});

describe('planStepFor', () => {
  it('끝나지 않은 담당 단계가 하나면 그것', () => {
    expect(planStepFor({ steps: [step('s1', 'done'), step('s2', 'pending')] }, { threadRootId: ROOT, delegateId: A, body: '' })).toBe('s2');
  });
  it('여럿이면 active 하나를, 그것도 애매하면 달지 않는다', () => {
    expect(planStepFor({ steps: [step('s1', 'pending'), step('s2', 'active')] }, { threadRootId: ROOT, delegateId: A, body: '' })).toBe('s2');
    expect(planStepFor({ steps: [step('s1', 'pending'), step('s2', 'blocked')] }, { threadRootId: ROOT, delegateId: A, body: '' })).toBeNull();
  });
  it('본문의 이 스레드 단계 링크가 이긴다 — 다른 스레드 링크는 보지 않는다', () => {
    const doc = { steps: [step('s1', 'active'), step('s3', 'pending')] };
    expect(planStepFor(doc, { threadRootId: ROOT, delegateId: A, body: `harkroom://plan/${ROOT}/s3` })).toBe('s3');
    expect(planStepFor(doc, { threadRootId: ROOT, delegateId: A, body: `harkroom://plan/${A}/s3` })).toBe('s1');
  });
  it('다른 담당의 단계는 고르지 않는다', () => {
    expect(planStepFor({ steps: [step('s1', 'active', null)] }, { threadRootId: ROOT, delegateId: A, body: '' })).toBeNull();
  });
});
