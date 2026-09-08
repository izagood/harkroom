import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAttentionLedger } from '../src/attentionLedger.js';

/**
 * 관문은 계정 단위다(실측: `.claude.json` 의 `hasCompletedOnboarding`,
 * `settings.json` 의 `skipDangerousModePermissionPrompt`). 한 번 지나면 그 계정의
 * 나머지 턴이 풀리므로, 같은 계정으로 창을 여러 개 띄우면 사람이 같은 승인을 여러 번
 * 한다 — 2026-09-08 에 7개 스레드가 동시에 걸렸다.
 */
describe('attention 원장', () => {
  it('같은 계정은 한 번만 부른다', () => {
    const l = createAttentionLedger();
    expect(l.claim('lime', 's1')).toBe(true);
    expect(l.claim('lime', 's2')).toBe(false);
  });

  it('계정이 다르면 각각 부른다 — 관문은 계정마다 따로다', () => {
    const l = createAttentionLedger();
    expect(l.claim('lime', 's1')).toBe(true);
    expect(l.claim('plum', 's2')).toBe(true);
  });

  it('놓으면 다시 부를 수 있다 — 다음 관문은 또 사람이 필요하다', () => {
    const l = createAttentionLedger();
    l.claim('lime', 's1');
    l.release('lime');
    expect(l.claim('lime', 's2')).toBe(true);
  });

  it('같은 세션이 두 번 불러도 한 번만 나간다 — 준비 실패와 주입 실패가 겹칠 수 있다', () => {
    // `pty.ts` 는 두 자리에서 부른다(준비 상한, 주입 확인 창). 한 턴이 둘 다 태우는
    // 경로는 없지만, 있더라도 사람에게 같은 말을 두 번 하지 않는다.
    const l = createAttentionLedger();
    expect(l.claim('lime', 's1')).toBe(true);
    expect(l.claim('lime', 's1')).toBe(false);
  });

  it('계정 이름이 없는 러너(풀 미구성)도 한 번은 부른다', () => {
    // 계정 풀을 안 만든 러너의 경로다. 라벨이 없다고 사람을 못 부르면, 그 러너는 관문에
    // 걸렸을 때 아무 말도 못 한다.
    const l = createAttentionLedger();
    expect(l.claim('(기본)', 's1')).toBe(true);
    expect(l.claim('(기본)', 's2')).toBe(false);
  });

  it('부르지 않은 계정을 놓아도 조용하다 — 세션 종료 경로가 항상 부른다', () => {
    const l = createAttentionLedger();
    expect(() => l.release('한번도-안부른-계정')).not.toThrow();
  });
});

// `mentionTurn.ts` 의 배선이 그 자리에 있는지 본다. 이 기능이 깨지는 방식이 정확히
// "함수는 있는데 턴이 안 부른다"라서, `mainCredentialSites.test.ts` 와 같은 종류의
// 약한 검사가 여기서도 필요하다.
describe('mentionTurn 의 배선', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/mentionTurn.ts'), 'utf8');

  it('TUI 턴에 onAttention 을 넘긴다 — 없으면 관문에서 그냥 죽는다', () => {
    expect(source).toContain('onAttention:');
  });

  it('주입 확인 창을 건다 — 준비 신호만으로는 부족하다', () => {
    expect(source).toContain('confirmDelivery:');
    expect(source).toContain('sessionTranscriptExists(');
  });

  it('원장을 거쳐 부른다 — 같은 계정으로 창을 여러 개 띄우지 않는다', () => {
    expect(source).toContain('attentionLedger.claim(');
  });

  it('계정 이름이 없으면 (기본) 으로 부른다 — 풀 미구성 러너도 말할 수 있어야 한다', () => {
    expect(source).toContain("deps.accountLabel ?? '(기본)'");
  });
});

describe('main.ts 의 원장 배선', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

  it('원장을 한 번 만들어 턴에 넘긴다 — 턴마다 새로 만들면 항상 처음이 된다', () => {
    expect(source).toContain('createAttentionLedger(');
    expect(source).toContain('attentionLedger');
  });

  it('계정 이름을 턴에 넘긴다 — 원장의 키다', () => {
    expect(source).toContain('accountLabel');
  });
});

// 2026-09-08 실물 검증에서 드러난 어긋남의 회귀선. 관측 결과: 계정 전환이 **한 번도**
// 일어나지 않고 첫 계정에서 바로 사람을 불렀다 — 스펙 §2-3 이 정한 순서와 반대다.
describe('사람 부르기는 축의 마지막에서만 열린다', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/mentionTurn.ts'), 'utf8');
  const main = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');
  const scheduler = readFileSync(path.resolve(__dirname, '../src/mentionScheduler.ts'), 'utf8');

  it('마지막 계정이 아니면 injectPrompt 에서 통째로 뺀다', () => {
    // `pty.ts` 는 콜백의 **유무로** 두 정책을 가른다 — 넘겨 놓고 안 부르는 방식으로는
    // 안 된다. 넘기는 순간 그 턴은 던지지 않게 되고, 계정 전환이 사라진다.
    expect(source).toContain('deps.callsForHuman === false ? {} : {');
  });

  it('스케줄러가 마지막 여부를 축에서 받아 넘긴다', () => {
    expect(scheduler).toContain('(account, isLastAccount) =>');
    expect(scheduler).toContain('isLastAccount');
  });

  it('main 이 그 플래그로 원장과 부름을 함께 닫는다', () => {
    // 원장만 닫고 부름을 열어 두면 원장 없이 매번 부른다(claim 검사를 건너뛴다).
    expect(main).toContain('attentionLedger: isLastAccount ? attentionLedger : undefined');
    expect(main).toContain('callsForHuman: isLastAccount');
  });
});
