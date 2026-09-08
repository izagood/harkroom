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
import { GallerySettings } from '../src/components/settings/GallerySettings';
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
    render(<MessageBody body="@alpha 이것 좀 봐" messageId="m1" />);
    const chip = screen.getByTestId('mention-alpha');
    expect(chip.className).not.toContain('text-accent');
    // 구별 자체는 남아 있어야 한다 — 배경과 굵기가 그 일을 한다.
    expect(chip.className).toMatch(/bg-/);
    expect(chip.className).toContain('font-medium');
  });

  /** **나를 부른 것은 다르다** — 그것은 실제로 내 차례를 만든다. */
  it('나를 부른 멘션은 그대로 눈에 띈다', () => {
    render(<MessageBody body="@me 확인해 줘" messageId="m1" />);
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

  /**
   * **접힌 주고받기의 결론은 강조색을 쓰지 않는다**(#488 C1).
   *
   * C1 이 그 줄에 처음으로 *읽으라고 있는 글자*(결론)를 넣었다. 읽히는 글자가 생기면
   * 강조를 붙이려는 손이 따라오는데, 접힌 대화는 **나를 막지 않는다** — 막는 말이 있으면
   * `agentExchange::blocksHuman` 이 애초에 접지 않으므로, 접힌 줄에 강조가 서는 경우는
   * 정의상 없다. 진하게 하고 싶으면 `text-fg-muted` 까지가 예산이다.
   */
  it('접힌 주고받기 줄은 강조색을 쓰지 않는다 — 나를 막지 않는 말이다', () => {
    expect(read('components/AgentExchange.tsx')).not.toContain('accent');
  });
});

/**
 * **갤러리의 강조 카드는 하나뿐이다** — 기준자에 예산을 박는다.
 *
 * 갤러리는 다른 화면을 재는 자다: *"여덟 가지 말과 그 경계 상태. 여기가 깨지면 어휘가
 * 깨진 것이다."* 그래서 강조 예산이 새는지를 **가장 먼저** 여기서 잰다 — 한 화면에 여덟
 * 가지가 다 서 있으므로, 예산이 새면 다른 어느 화면보다 먼저 여기서 둘째 강조가 보인다.
 *
 * 실측 회귀(v0.1.52): 에이전트가 하나도 없는 계정에서 *"에이전트에게 간 것"* 칸이
 * *"나에게 온 것"* 과 **픽셀 단위로 같아졌다.** 수신자를 만드는 폴백이 `undefined` 를
 * `{ kind: 'human' }` 으로 바꿨고, 그래서 강조 카드가 **둘**이 됐다 — 그 칸 자신이
 * *"무채색. 읽히되 누를 수 없다(규칙 04)"* 라고 적어 둔 자리에서. 기준자가 규칙과 반대로
 * 그려지면 그것으로 잰 판정이 전부 흔들리므로, 이 단정이 그 자리를 잠근다.
 *
 * **계정 목록에 관계없이** 재는 것이 요점이다: 앞의 결함은 에이전트가 있을 때는 보이지
 * 않았고 없을 때만 나타났다. 그래서 셋을 다 돌린다.
 */
describe('컴포넌트 갤러리 — 강조 카드는 하나뿐이다', () => {
  const AGENTS = {
    'a-forge': acc('a-forge', 'forge', 'agent', false, { ownerAccountId: ME }),
    'a-codex': acc('a-codex', 'codex', 'agent'),
  };

  /** 강조 배경(`bg-accent-surface`)을 입은 카드 수. 이 화면의 강조 예산이 곧 이 숫자다. */
  const accentCards = (): number =>
    document.querySelectorAll('[data-testid="ask-card"].bg-accent-surface').length;

  for (const [label, accounts] of [
    ['에이전트 없음', {}],
    ['에이전트 하나', { 'a-forge': AGENTS['a-forge'] }],
    ['에이전트 둘', AGENTS],
  ] as const) {
    it(`${label} — 강조 카드가 하나다`, () => {
      useActiveStore.getState().set({ me: acc(ME, 'me'), accounts: { [ME]: acc(ME, 'me'), ...accounts } });
      render(<GallerySettings />);

      // 여덟 가지가 다 서 있는데 강조는 하나 — 그것이 "나를 막는 것만 강조를 받는다"다.
      expect(accentCards()).toBe(1);

      /**
       * 강조를 받는 것이 **바로 그 칸**인지도 잰다. 개수만 세면 강조가 엉뚱한 칸으로
       * 옮겨 가도 통과한다 — "나에게 온 것"이 무채색이 되고 "남에게 간 것"이 강조를
       * 받으면 개수는 여전히 하나다.
       */
      const cards = screen.getAllByTestId('ask-card');
      expect(cards.map((c) => c.dataset.forMe)).toEqual(['true', 'false', 'true']);
      // 강조를 받는 유일한 카드는 **첫째**(나에게 왔고 아직 안 답한 것)다.
      expect(cards[0]!.className).toContain('bg-accent-surface');
      // 남에게 간 것은 무채색이고 **누를 수 없다**(규칙 04) — 색만 맞고 눌리면 반쪽이다.
      expect(cards[1]!.className).toContain('bg-surface-agent');
      expect(cards[1]!.querySelectorAll('button:not([disabled])')).toHaveLength(0);
    });
  }
});
