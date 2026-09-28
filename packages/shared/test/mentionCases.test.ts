import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mentionedHandles } from '../src/index.js';

/**
 * **멘션 판정의 계약**. 이 표는 `test/fixtures/mentionCases.json` 하나이고,
 * **TypeScript 와 Dart 가 같은 파일을 읽는다**(`apps/mobile/test/mention_test.dart`).
 *
 * ## 왜 표가 필요해졌나
 *
 * 지금까지 이 규칙은 `packages/shared` 에 **한 벌**이었고, 서버와 데스크탑이 그 하나를
 * 함께 읽었으므로 갈라질 수가 없었다. 모바일 클라이언트가 Dart 로 생기면서 **두 번째
 * 구현**이 생긴다 — 공유가 막아 주던 것이 거기서 처음 뚫린다.
 *
 * 갈라지면 무슨 일이 나는가: 강조되지 않은 글이 **몰래 에이전트를 깨우거나**, 강조된
 * 글이 **아무도 안 깨운다**. 둘 다 사람이 화면을 믿을 수 없게 만드는 종류의 실패다.
 *
 * ## 이 시험이 지키는 것
 *
 * 여기(TS)가 **원본**이다. 이 시험은 표가 지금 구현과 맞는지만 본다. 그러므로:
 *
 * - 구현을 **일부러** 바꿨다면 표를 다시 뽑는다. 그러면 Dart 쪽 시험이 빨개지고,
 *   포팅을 안 고쳤다는 사실이 **사람보다 CI 에게 먼저** 보인다.
 * - 구현을 **모르고** 바꿨다면 여기가 먼저 빨개진다.
 *
 * 표를 손으로 적지 않는다 — 손으로 적은 표는 그 자체가 세 번째 구현이다.
 */
interface MentionCase {
  body: string;
  handles: string[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/mentionCases.json', import.meta.url), 'utf8'),
) as { cases: MentionCase[] };

describe('멘션 판정 계약 (TS ↔ Dart 공용 표)', () => {
  it('표가 비어 있지 않다 — 비면 이 계약은 아무것도 지키지 않는다', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  it('표의 모든 줄이 지금 구현과 같다', () => {
    const mismatched = fixture.cases
      .map((c) => ({ body: c.body, expected: c.handles, actual: mentionedHandles(c.body).sort() }))
      .filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));

    expect(
      mismatched,
      '구현을 일부러 바꿨다면 표를 다시 뽑고, Dart 포팅(apps/mobile/lib/mention/mention.dart)도 함께 고쳐라',
    ).toEqual([]);
  });

  it('표가 지키는 갈래가 실제로 들어 있다', () => {
    // 표가 "전부 빈 배열" 같은 시시한 것으로 줄어들면 위 시험은 초록인데 아무것도
    // 지키지 못한다. 양쪽 답이 다 있어야 계약이다.
    const found = fixture.cases.filter((c) => c.handles.length > 0).length;
    const empty = fixture.cases.filter((c) => c.handles.length === 0).length;
    expect(found).toBeGreaterThan(5);
    expect(empty).toBeGreaterThan(5);
  });
});
