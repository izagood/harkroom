// **강조색을 회수한다**(#488 B2).
//
// 컨셉은 *"나를 막는 것만 강조를 받는다"* 고 정했는데, 실제로는 같은 주황이 아홉 군데에
// 쓰이고 **그중 나를 막는 것은 하나도 없었다.** 문서가 이것을 인박스(C2)보다 먼저 두라고
// 못 박은 이유가 그것이다: *"강조가 이미 포화라서, 다음 단계에서 막는 말에 색을 칠해도
// 눈에 띄지 않는다."*
//
// 강조를 받는 것은 **둘뿐**이다 — 나를 막는 것(되물음·선택·실패)과 화면당 주 동작 버튼
// 하나. 이 파일은 그 예산이 다시 새지 않게 붙잡는다.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useActiveStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageBody } from '../src/components/MessageBody';
import { acc } from './helpers/fakeApi';

const ME = 'u-me';
const OTHER = 'u-other';

beforeEach(() => {
  setController({ openThread: vi.fn(async () => undefined) } as unknown as Controller);
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME, 'me'),
    accounts: { [ME]: acc(ME, 'me'), [OTHER]: acc(OTHER, 'alpha', 'agent') },
  });
});
afterEach(() => cleanup());

describe('멘션 칩 — 색이 아니라 배경으로 구별한다', () => {
  /**
   * 문서: *"본문에 여러 번 나오는 것은 색이 아니라 옅은 배경으로 구별한다."*
   * 남을 부른 멘션까지 강조색을 쓰면 한 화면에 강조가 열 개씩 서고, 그러면 정작
   * 나를 막는 말에 색을 칠해도 눈에 띄지 않는다.
   */
  it('남을 부른 멘션은 강조색을 받지 않는다', () => {
    render(<MessageBody body="@alpha 이것 좀 봐" />);
    const chip = screen.getByTestId('mention-alpha');
    expect(chip.className).not.toContain('text-accent');
    // 구별 자체는 남아 있어야 한다 — 배경과 굵기가 그 일을 한다.
    expect(chip.className).toMatch(/bg-/);
    expect(chip.className).toContain('font-medium');
  });

  /** **나를 부른 것은 다르다** — 그것은 실제로 내 차례를 만든다. */
  it('나를 부른 멘션은 그대로 눈에 띈다', () => {
    render(<MessageBody body="@me 확인해 줘" />);
    const chip = screen.getByTestId('mention-me');
    expect(chip.dataset.self).toBe('true');
    expect(chip.className).toContain('warning');
  });
});

/**
 * 소스를 직접 읽어 **강조색이 다시 새지 않는지** 본다.
 *
 * 렌더로는 이 규칙을 다 잴 수 없다 — 자리마다 화면을 세워야 하고, 그러면 정작 새로
 * 생긴 자리를 놓친다. 그래서 `bundleSignable.test.ts` 와 같은 태도로 **좁게** 잰다:
 * 한 번 회수한 자리가 조용히 되돌아가지 않게 붙잡는 것뿐이다.
 */
describe('회수한 자리가 되돌아가지 않는다', () => {
  const read = (p: string) => readFileSync(join(import.meta.dirname, '..', 'src', p), 'utf8');

  it('답장 수는 강조색을 쓰지 않는다', () => {
    const src = read('components/MessageItem.tsx');
    // 답장 수를 그리는 자리에 `text-accent` 가 돌아오면 잡는다.
    const replyLine = src.slice(src.indexOf('ThreadStateBadge state={summaryState}'));
    expect(replyLine.slice(0, 600)).not.toContain('text-accent');
  });

  it('리액션 칩은 강조색을 쓰지 않는다', () => {
    expect(read('components/Reactions.tsx')).not.toContain('accent');
  });

  it('멘션 칩은 강조색을 쓰지 않는다 — 링크는 예외다', () => {
    const src = read('components/MessageBody.tsx');
    // 멘션 칩을 만드는 자리(`isGroup` 삼항)에 accent 가 없어야 한다.
    const chip = src.slice(src.indexOf('const className = `rounded px-0.5'));
    expect(chip.slice(0, 300)).not.toContain('accent');
  });
});
