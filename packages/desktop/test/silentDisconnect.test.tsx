/**
 * `#443` 회귀선 — **연결이 끊기면 화면이 생사를 단정하지 않는다.**
 *
 * ## 무엇이 문제였나 — 실측 (2026-09-06, 릴리즈 `.app`)
 *
 * 서버가 죽은 그 순간 화면이 이랬다:
 *
 * ```
 * 타이틀 옆 점       🔴 빨강        ← 맞음
 * 에이전트 6개       전부 초록      ← 거짓. 실제로는 알 수 없음
 * 좌하단             "대화 가능"    ← 거짓 (아래 참고 — `#488 A1` 이 이미 없앴다)
 * ```
 *
 * 한 화면이 **두 가지 반대되는 말**을 동시에 하고 있었고, 사람은 아래쪽(초록)을 믿었다.
 *
 * 셋째 줄에는 이 파일에 회귀선이 없다 — 그 글자가 화면에서 사라져 고칠 자리가 없어졌다.
 * 근거는 아래 「좌하단」 주석 블록에 적었다. **빠뜨린 것이 아니다.**
 *
 * ## 왜 그랬나 — 낡은 값을 지금 사실처럼 그렸다
 *
 * presence 는 **서버가 주는 것**이다(`presence.snapshot`·`presence.changed`). 소켓이
 * 끊기면 `controller.ts::handleDown` 이 `connected` 만 내리고 `online` 배열은 그대로 둔다.
 * **그것이 옳다** — 비우면 "전원 오프라인"이라는 또 다른 거짓말이 된다. 문제는 화면이
 * 그 낡은 배열을 `connected` 없이 읽었다는 것이다.
 *
 * 이 규약은 이미 저장소 안에 있었다(`threadState.ts::Liveness`, `MessageItem`,
 * `ThreadPanel`, `Profile`, `SidebarWaitChain`). **점을 그리는 자리들만 그 밖에 있었다.**
 *
 * ## 이 파일의 규율 — **대조군이 없으면 통과가 무의미하다**
 *
 * "끊기면 초록이 아니다"만 재면 `presenceView` 가 무조건 `'unknown'` 을 돌려줘도 초록이다 —
 * 즉 정보를 통째로 없애는 것으로 이 이슈를 '고칠' 수 있다. 그래서 모든 회귀선에
 * **붙어 있을 때 초록이다**를 짝으로 둔다. 이 저장소가 반복해서 겪은 실패 모드다
 * (`#482` 의 회귀선 ⑦이 같은 자리).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { Directory } from '../src/components/Directory';
import { acc, chan } from './helpers/fakeApi';
import { presenceView, anyPresenceView, PRESENCE_LABEL } from '../src/lib/presenceView';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), setStatus: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(),
    // 디렉터리는 열릴 때 목록을 **강제로** 다시 받는다(스로틀을 끄면 죽은 서버에서도
    // 초록으로 보이므로). 스토어는 위 `beforeEach` 가 이미 채워 두었다.
    refreshAccounts: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const renderSidebar = () => render(
  <Sidebar panel="dm"
    onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}} onOpenInbox={() => {}}
    collapsed={false} onToggleCollapse={vi.fn()}
  />,
);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(cleanup);

/** 소켓이 끊긴 상태를 실물과 같이 만든다 — **`online` 은 비우지 않는다.** */
const 끊는다 = () => {
  // `handleDown('network')` 이 하는 일과 같다: `connected` 만 내리고 `online` 은 그대로.
  // 이 낡은 배열이 남아 있는 것이 이 이슈의 재료다 — 비워 버리면 재현이 안 된다.
  useAppStore.getState().set({ connected: false });
};

describe('판정 — presenceView (#443)', () => {
  /**
   * 판정을 순수 함수로 떼어낸 이유가 이 회귀선이다. 컴포넌트를 거치지 않고 직접 잴 수
   * 있어야 "화면이 우연히 초록이 아닌 것"과 "판정이 초록이 아닌 것"이 구분된다.
   *
   * **되돌려 RED**: `presenceView` 의 `if (!connected) return 'unknown';` 을 지우면
   * 낡은 배열이 그대로 읽혀 `'online'` 이 나오고 이 단언이 빨개진다. 실제로 되돌려
   * 실행해 확인했다.
   */
  it('끊겼으면 낡은 online 배열에 있어도 online 이 아니다', () => {
    expect(presenceView('u2', ['u2'], false)).toBe('unknown');
    expect(anyPresenceView(['u2', 'u3'], ['u2'], false)).toBe('unknown');
  });

  /** **대조군.** 없으면 위 단언은 "언제나 unknown" 으로도 통과한다. */
  it('대조군 — 붙어 있으면 online 이다', () => {
    expect(presenceView('u2', ['u2'], true)).toBe('online');
    expect(anyPresenceView(['u2', 'u3'], ['u2'], true)).toBe('online');
  });

  /**
   * **두 번째 대조군 — 붙어 있는데 목록에 없으면 offline 이다.**
   *
   * 이것이 없으면 판정이 `connected ? 'online' : 'unknown'` 으로 무너져도 통과한다.
   * 그 구현은 "서버가 없다고 한 것"과 "서버가 있다고 한 것"을 뭉개므로 여전히 거짓말이다.
   */
  it('대조군 — 붙어 있는데 목록에 없으면 offline 이다', () => {
    expect(presenceView('u9', ['u2'], true)).toBe('offline');
    expect(anyPresenceView(['u9'], ['u2'], true)).toBe('offline');
  });

  /** 세 값이 서로 다른 말을 한다 — 문구가 겹치면 사람에게는 값이 둘뿐이다. */
  it('세 값의 문구가 서로 다르고, unknown 은 오프라인이라고 말하지 않는다', () => {
    const labels = new Set(Object.values(PRESENCE_LABEL));
    expect(labels.size).toBe(3);
    expect(PRESENCE_LABEL.unknown).toContain('알 수 없음');
    // **"오프라인"이라고 쓰지 않는다** — 그것은 아는 척이고, 사람은 러너를 되살리려 한다.
    expect(PRESENCE_LABEL.unknown).not.toBe(PRESENCE_LABEL.offline);
  });
});

describe('사이드바 — DM 옆의 점 (#443)', () => {
  /**
   * **되돌려 RED**: `dmPeers` 의 `anyPresenceView(peers, online, connected)` 를 앞 판본
   * (`peers.some((id) => online.includes(id))`)으로 되돌리면 끊긴 뒤에도 `'true'` 가 나와
   * 이 단언이 빨개진다. 실제로 되돌려 실행해 확인했다.
   */
  it('끊기면 초록이 아니다', () => {
    fakeController();
    끊는다();
    renderSidebar();

    const dot = screen.getByTestId('presence-d1');
    expect(dot.dataset.online).toBe('unknown');
    // 색만 바꾸면 스크린리더에는 아무 말도 안 한 것과 같다 — **글자로도 말한다.**
    expect(dot.getAttribute('title')).toBe(PRESENCE_LABEL.unknown);
    expect(dot.className).not.toContain('bg-success');
  });

  it('대조군 — 붙어 있으면 초록이다', () => {
    fakeController();
    renderSidebar();

    const dot = screen.getByTestId('presence-d1');
    expect(dot.dataset.online).toBe('online');
    expect(dot.className).toContain('bg-success');
  });

  /**
   * 타이틀 옆 점은 실측에서 **유일하게 맞았던** 표시다. 그것이 계속 맞는지, 그리고
   * 끊김이 무엇을 뜻하는지 말하는지 함께 잰다 — 한 단어(`disconnected`)로는 아래 점들이
   * 전부 '알 수 없음'이 된다는 사실이 전해지지 않는다.
   */
  it('타이틀 옆 점은 끊김을 말하고, 그것이 뜻하는 바까지 말한다', () => {
    fakeController();
    끊는다();
    renderSidebar();

    const dot = screen.getByTestId('connection-dot');
    expect(dot.dataset.connected).toBe('false');
    expect(dot.className).toContain('bg-danger');
    expect(dot.getAttribute('title')).toContain('알 수 없다');
  });

  it('대조군 — 붙어 있으면 타이틀 점은 초록이고 겁주지 않는다', () => {
    fakeController();
    renderSidebar();

    const dot = screen.getByTestId('connection-dot');
    expect(dot.dataset.connected).toBe('true');
    expect(dot.className).toContain('bg-success');
    expect(dot.getAttribute('title')).not.toContain('알 수 없다');
  });
});

/**
 * ## 좌하단 "대화 가능" — **`#488 A1` 이 이미 없앴다. 여기서 손대지 않는다**
 *
 * 실측 표의 셋째 줄(`좌하단 "대화 가능" ← 거짓`)에는 이 파일에 회귀선이 없다.
 * 빠뜨린 것이 아니라 **고칠 자리가 사라졌기 때문**이고, 그 판단의 근거를 남긴다.
 *
 * ### 이 이슈가 재려던 것과 `#488` 이 한 일
 *
 * 이 줄이 거짓이었던 이유는 상태값이 틀려서가 아니었다. `대화 가능` 이라는 글자가
 * **화면에 상주하며 "지금 나는 대화 가능하다"고 계속 주장**했고, 소켓이 끊긴 동안
 * 그 주장이 남에게 닿지 않는다는 사실이 어디에도 없었다.
 *
 * `#488 A1` 이 그 글자를 **행에서 통째로 걷어냈다.** 지금 좌하단이 그리는 것은
 * 아바타 · 핸들 · `StatusMark` 셋인데, `StatusMark` 는 `available` 에 `null` 을 준다
 * (`Identity.tsx::STATUS_MARKS` — *"기본값에는 표시를 붙이지 않는다"*). 상태를 고르는
 * 일은 계정 메뉴의 `상태 바꾸기` 항목으로 옮겼다.
 *
 * **즉 정상 상태에서 좌하단은 이제 아무 주장도 하지 않는다.** 거짓말할 글자가 없다.
 *
 * ### 왜 다른 자리에 억지로 붙이지 않았나
 *
 * "그러면 계정 행이나 메뉴 항목에 붙이면 되지 않나"를 따져 봤고, **붙이지 않는 것이
 * 맞다**고 판단했다:
 *
 * - **계정 행에 붙이면** `#488` 이 방금 걷어낸 상주 어휘를 다른 이름으로 되살리는
 *   것이다. 그 행은 이제 `away`·`dnd` 일 때만 글자가 서는데(그때는 사람이 스스로
 *   고른 것이라 놀랄 일이 없다), 거기에 연결 상태를 얹으면 **정상 상태에는 표시를
 *   붙이지 않는다**는 규칙이 다시 깨진다
 * - **연결 끊김은 이미 화면이 말하고 있다** — 타이틀 옆 빨간 점이고, 이 커밋이 그
 *   점의 `title` 에 *"다시 붙을 때까지 아래 목록의 생사는 알 수 없다"* 를 넣었다.
 *   같은 사실로 한 화면을 두 번 붙잡지 않는다(`#443` 코멘트의 강조 규율과 같은 선)
 * - 그리고 이 파일의 대조군 주석이 적은 것이 여기에도 그대로 적용된다:
 *   **늘 붙어 있으면 곧 아무도 안 읽는다**
 *
 * ### 남은 위험과, 그것이 이 이슈가 아닌 이유
 *
 * 끊긴 동안 `상태 바꾸기` 로 상태를 고르면 `setStatus` 가 나가지 못한다. 그런데
 * 그것은 **조용히 실패하지 않는다** — `StatusPicker.apply` 의 `catch` 가 사유를
 * `role="alert"` 로 세운다. 즉 사람이 그 조작을 했을 때 화면이 답한다.
 *
 * 이것이 `#443` 과 다른 점이다. 이 이슈는 **아무도 묻지 않았는데 화면이 틀린 말을
 * 하고 있던 것**이고, 저쪽은 **사람이 물었을 때 답이 오는 것**이다. 후자는 이미 답한다.
 */

describe('디렉터리 — 목록의 점 (#443)', () => {
  /**
   * 이 자리는 저장소에서 `connected` 를 **아예 안 보던** 유일한 곳이었다. 그래서 끊기면
   * 여기만 반대 방향으로 틀렸다 — 모두가 회색이 되어 "전원 오프라인"으로 읽혔다.
   * 초록으로 남는 것과 회색으로 가라앉는 것은 **같은 크기의 거짓말**이고, 이 회귀선이
   * 그 둘 다를 막는다.
   *
   * **되돌려 RED**: `presenceView(a.id, online, connected)` 를 `online.includes(a.id)` 로
   * 되돌리면 `data-online` 이 `'false'` 가 되어 빨개진다.
   */
  it('끊기면 오프라인이라고 단정하지도 않는다', async () => {
    fakeController();
    끊는다();
    render(<Directory open onClose={vi.fn()} accountId={null} />);

    const dot = await screen.findByTestId('directory-presence-u2');
    expect(dot.dataset.online).toBe('unknown');
    expect(dot.className).not.toContain('bg-success');
    // 회색(오프라인)으로도 두지 않는다 — 죽지 않은 것을 죽었다고 읽게 만든다.
    expect(dot.className).not.toContain('bg-fg-subtle');
  });

  it('대조군 — 붙어 있으면 초록과 회색으로 갈린다', async () => {
    fakeController();
    render(<Directory open onClose={vi.fn()} accountId={null} />);

    const live = await screen.findByTestId('directory-presence-u2');
    expect(live.dataset.online).toBe('online');
    expect(live.className).toContain('bg-success');

    // 붙어 있는데 목록에 없는 사람은 **여전히 회색이다** — 아는 것은 말한다.
    const me = await screen.findByTestId('directory-presence-u1');
    expect(me.dataset.online).toBe('offline');
    expect(me.className).toContain('bg-fg-subtle');
  });
});
