/**
 * #600 회귀선(데스크탑) — **어느 모델이 말했는가**를 상시 픽셀 없이 알 수 있다.
 *
 * 이 기능의 요구는 두 문장이었다: "모델을 알고 싶다" 와 "계속 어딘가 표시해서 UX 가
 * 나빠지는 것은 피하고 싶다". 그래서 이 파일이 재는 것은 **보이는 것**만큼이나
 * **보이지 않는 것**이다 — 모델 ID 가 글자로 서 있으면(3번) 이 기능은 요구를 어긴 것이다.
 *
 * 판정 함수 자체는 `shared/test/modelMeta.test.ts` 가, meta 를 싣는 경로는
 * `server/test/mcp.test.ts` 가 잰다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const OPUS = 'claude-opus-5[1m]';

function show(meta: Record<string, unknown>): void {
  render(<MessageItem message={msg('m1', 'c1', 1, '다 했다', 'a1', { meta })} />);
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'jaebin'),
    accounts: { u1: acc('u1', 'jaebin'), a1: acc('a1', 'murmur', 'agent') },
  });
});
afterEach(() => cleanup());

describe('#600 발화에 실린 모델', () => {
  it('1. 이름줄 hover 가 모델을 말한다 — 클릭도, 겹창도 필요하지 않다', () => {
    show({ model: { id: OPUS } });

    expect(screen.getByTestId('author-name').getAttribute('title')).toBe(`모델 ${OPUS}`);
  });

  it('2. 모델이 안 실린 말은 hover 도 없다 — 빈 툴팁이 뜨지 않는다', () => {
    show({});

    expect(screen.getByTestId('author-name').getAttribute('title')).toBeNull();
    expect(screen.queryByTestId('model-mismatch')).toBeNull();
  });

  it('3. 모델 ID 가 **글자로는 서지 않는다** — 이것이 "UX 를 해치지 않는다"의 뜻이다', () => {
    show({ model: { id: OPUS } });

    // 본문·이름줄 어디에도 ID 가 없다. 있으면 모든 말 옆에 모델 이름이 붙어 있는 것이다.
    expect(screen.queryByText(OPUS)).toBeNull();
    expect(screen.getByText('다 했다')).toBeTruthy();
  });

  it('4. 설정과 어긋나면 ⚠️ 가 서고, 무엇이 어긋났는지는 hover 가 말한다', () => {
    show({ model: { id: OPUS, mismatch: true } });

    const badge = screen.getByTestId('model-mismatch');
    expect(badge.getAttribute('title')).toContain(OPUS);
    expect(badge.getAttribute('title')).toContain('설정된 모델과 다른 계열');
    // 눈으로 못 보는 사람에게도 같은 사실이 가야 한다.
    expect(badge.getAttribute('aria-label')).toContain(OPUS);
  });

  it('5. 맞을 때는 ⚠️ 가 없다 — 정상은 침묵이다', () => {
    show({ model: { id: OPUS } });

    expect(screen.queryByTestId('model-mismatch')).toBeNull();
  });

  it('6. 완료 보고에도 모델이 실린다 — 모델은 발화의 종류와 직교한다', () => {
    show({ kind: 'report', report: { checks: ['테스트 통과'] }, model: { id: OPUS } });

    expect(screen.getByTestId('author-name').getAttribute('title')).toBe(`모델 ${OPUS}`);
    // 보고 카드가 그대로 있어야 한다 — 모델을 실었다고 보고가 평문으로 흐르면 안 된다.
    expect(screen.getByText('테스트 통과')).toBeTruthy();
  });
});
