// J1 합집합 — 스위치(`HARKROOM_MANDATE_ENFORCE`)를 켜도 사슬 판정이 통과시키던 것은 하나도 막히지 않는다(newly-blocked = 0).
// 사슬 판정의 시험 두 벌(grant·1회 승인·거절 카드, 위임 사슬)을 스위치를 켠 채 그대로 다시 돌려 같은 판정을 확인한다.
// 판정은 부를 때마다 스위치를 읽는다. 작업자는 파일마다 따로 뜨므로(pool: forks) 되돌리지 않는다 — 되돌리면 뒤에 도는 두 벌이 꺼진 채 돈다.
import { describe, expect, it } from 'vitest';
import { mandateEnforced } from '../src/services/mergeGrants.js';

process.env.HARKROOM_MANDATE_ENFORCE = 'on';

describe('J1 parity: chain suites with the switch on', () => {
  it('switch is on for this file', () => { expect(mandateEnforced()).toBe(true); });
  it('and still on after the imported suites ran', () => { expect(mandateEnforced()).toBe(true); });
});

await import('./mergeGrants.test.js');
await import('./mergeCauseChain.test.js');

describe('J1 parity: switch still on at the end', () => {
  it('on', () => { expect(mandateEnforced()).toBe(true); });
});
