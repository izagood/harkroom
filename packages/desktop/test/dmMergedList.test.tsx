/**
 * **DM 한 목록** — 정본 문서 `docs/desktop-rail.html` 2단계.
 *
 * 문서: *"DM 은 사람과 에이전트를 안 가른다. 한 목록에 최근순으로 섞이고 줄 모양이 같다 —
 * 목록만 봐서는 누가 에이전트인지 알 수 없다. '사람끼리 일하듯'이 컨셉이면 대화 목록이
 * 그것을 가장 먼저 보여주는 자리다."*
 *
 * 그리고 2단계 항목: *"`DIRECT MESSAGES` 와 `AGENTS` 두 묶음을 최근순 한 목록으로. 상태
 * 표현은 아바타 규칙을 그대로 쓴다(「나머지 여덟 곳」 B1)."*
 *
 * ## 이 파일이 재는 세 가지
 *
 * 1. **최근순** — 그리고 실시간 메시지가 그 순서를 고친다
 * 2. **줄 모양이 같다** — 사람 줄과 에이전트 줄의 DOM 이 같은 모양이고, 에이전트에게만
 *    붙는 표시가 없다. 이것이 문서가 원한 **의도한 결과**다
 * 3. **상태는 아바타가 말한다** — 그리고 그 판정은 격자와 **같은 함수**(`faceState`)다
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, msg } from './helpers/fakeApi';
import { PRESENCE_LABEL } from '../src/lib/presenceView';
import type { RunnerState } from '../src/lib/runnerLauncher';
import type { DmView } from '@murmur/shared';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(async () => undefined), startDm: vi.fn(async () => undefined),
    logout: vi.fn(), createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), setStatus: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

const renderDmPanel = () =>
  render(
    <Sidebar panel="dm" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
  );

const dm = (id: string, peerId: string, lastMessageAt: string | null): DmView =>
  ({ id, memberIds: ['me', peerId], lastMessageAt });

/**
 * 러너 상태 하나. **`as never` 로 타입을 뚫지 않는다** — `RunnerState` 는 `exitCode` 와
 * `message` 를 옵셔널로 두지 않았고(그 이유는 그 인터페이스 주석에 있다: *"`failed` 는
 * 반드시 이유를 갖는다"*), 시험이 그 계약을 우회하면 필드가 하나 늘 때 여기가 조용히
 * 낡는다. 기본값을 여기 한 번 적고 시험은 필요한 것만 덮어쓴다.
 */
const runner = (
  status: RunnerState['status'], extra: Partial<RunnerState> = {},
): RunnerState => ({ agentId: 'forge', status, exitCode: null, message: null, ...extra });

/** 사람 하나 · 에이전트 하나. 목록에 섞여 서는 최소 구성이다. */
const 사람과에이전트 = {
  me: acc('me', 'jaebin'),
  accounts: {
    me: acc('me', 'jaebin'),
    nari: acc('nari', 'nari'),
    forge: acc('forge', 'forge', 'agent'),
  },
  channels: [chan('c1', 'general')],
  online: ['nari', 'forge'],
  connected: true,
  activeChannelId: 'c1',
};

/** 목록에 선 DM 줄들 — 순서대로. 아바타 칸의 testid 로 찾는다. */
const 줄들 = () =>
  Array.from(document.querySelectorAll('[data-testid^="dm-face-"]'))
    .map((el) => el.getAttribute('data-testid')!.replace('dm-face-', ''));

beforeEach(() => { useAppStore.getState().reset(); });
afterEach(() => { cleanup(); });

describe('최근순 한 목록 (docs/desktop-rail.html 2단계)', () => {
  it('사람과 에이전트가 한 목록에 최근순으로 섞인다 — 묶음이 없다', () => {
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      dms: [
        // **일부러 최근순의 반대로 넣는다.** 서버 순서를 그대로 그리는 구현이라면
        // 이 순서가 그대로 화면에 남아 빨개진다.
        dm('d-nari', 'nari', '2026-09-01T00:00:00.000Z'),
        dm('d-forge', 'forge', '2026-09-05T00:00:00.000Z'),
      ],
    });
    renderDmPanel();

    // 최근 대화가 위다 — **에이전트가 사람 위에 선다.** 종류로 갈렸다면 불가능한 순서고,
    // 그것이 이 단계의 요점이다.
    expect(줄들()).toEqual(['d-forge', 'd-nari']);

    // **묶음 머리글이 없다.** 둘 중 하나라도 남아 있으면 목록이 여전히 갈려 보인다.
    expect(screen.queryByText(/direct messages/i)).toBeNull();
    // 에이전트 칸의 `Agents` 머리글은 다른 패널의 것이다 — 이 패널에는 없어야 한다.
    expect(screen.queryByText(/^agents$/i)).toBeNull();
  });

  it('실시간으로 온 메시지가 순서를 고친다 — 서버 응답을 다시 받지 않고', () => {
    // `dms` 는 부트스트랩과 `startDm` 때만 새로 온다(`controller.ts`). 그 사이에 오는
    // `message.created` 로 목록이 안 움직이면, **지금 대화 중인 DM 이 안 올라온다** —
    // 이 화면의 존재 이유를 정면으로 부수는 결함이다.
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      dms: [
        dm('d-forge', 'forge', '2026-09-05T00:00:00.000Z'),
        dm('d-nari', 'nari', '2026-09-01T00:00:00.000Z'),
      ],
    });
    renderDmPanel();
    expect(줄들()).toEqual(['d-forge', 'd-nari']);

    // 아래에 있던 DM 에 **새 말이 온다.** 서버 `dms` 는 그대로다.
    act(() => {
      useAppStore.getState().upsertMessages('d-nari', [
        msg('m-new', 'd-nari', 1, '방금 온 말', 'nari',
          { createdAt: '2026-09-06T00:00:00.000Z' }),
      ]);
    });

    expect(줄들()).toEqual(['d-nari', 'd-forge']);
  });

  it('말이 없는 DM(`lastMessageAt: null`)은 맨 아래다 — 위가 아니다', () => {
    // `null` 은 여기서 '모른다'가 아니라 **'대화한 적 없다'** 는 확정된 사실이다(서버가
    // 세어 봤고 0이었다 — shared 의 `DmView` 주석). 최근순 목록에서 대화가 없는 것이
    // 있는 것보다 최근일 수는 없다.
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      dms: [
        dm('d-empty', 'forge', null),
        dm('d-nari', 'nari', '2026-09-01T00:00:00.000Z'),
      ],
    });
    renderDmPanel();

    expect(줄들()).toEqual(['d-nari', 'd-empty']);
  });
});

describe('줄 모양이 같다 — 목록만 봐서 누가 에이전트인지 알 수 없다', () => {
  /**
   * **이것이 이 단계의 의도한 결과다**(문서: *"목록만 봐서는 누가 에이전트인지 알 수
   * 없다"*). 합치기 전에는 `RunnerStatusDot` 이 에이전트 줄에만 네모난 점을 하나 더
   * 붙여서, 목록이 합쳐져도 줄만 보면 종류를 알 수 있었다.
   */
  it('에이전트 줄에만 붙는 표시가 없다 — 두 줄의 표시 개수가 같다', () => {
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      dms: [
        dm('d-nari', 'nari', '2026-09-05T00:00:00.000Z'),
        dm('d-forge', 'forge', '2026-09-01T00:00:00.000Z'),
      ],
      // **러너가 정상으로 돌고 있다.** 이 상태가 앞 판본에서 초록 네모를 하나 더 그렸다.
      runnerStates: { forge: runner('running') },
    });
    renderDmPanel();

    const 사람줄 = screen.getByTestId('dm-face-d-nari').closest('button')!;
    const 에이전트줄 = screen.getByTestId('dm-face-d-forge').closest('button')!;

    // 상태를 말하는 칸은 **각 줄에 하나씩**이다. 개수를 세는 것이 요점이다 — "있다"만
    // 보면 에이전트 줄에 하나 더 있어도 초록으로 남는다(`#365` 가 같은 셈을 썼다).
    expect(사람줄.querySelectorAll('[data-testid^="dm-face-"]').length).toBe(1);
    expect(에이전트줄.querySelectorAll('[data-testid^="dm-face-"]').length).toBe(1);

    // 러너 점(`runner-*`)이 **어느 줄에도 없다.** 있으면 그 줄이 곧 에이전트다.
    expect(사람줄.querySelector('[data-testid^="runner-"]')).toBeNull();
    expect(에이전트줄.querySelector('[data-testid^="runner-"]')).toBeNull();

    // 그리고 정상 상태에서는 두 줄이 **같은 얼굴 값**을 갖는다 — 사람은 붙어 있어서
    // `ok`, 에이전트는 러너가 돌아서 `ok` 다. 판정 경로가 다른데 결과가 같은 것이
    // 문서가 원한 "줄 모양이 같다"의 실체다.
    expect(screen.getByTestId('dm-face-d-nari').dataset.face).toBe('ok');
    expect(screen.getByTestId('dm-face-d-forge').dataset.face).toBe('ok');
  });
});

describe('상태는 아바타가 말한다 — B1 의 세 얼굴 (「나머지 여덟 곳」)', () => {
  const 한줄 = (runnerStates: Record<string, RunnerState>, connected = true) => {
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      connected,
      dms: [dm('d-forge', 'forge', '2026-09-05T00:00:00.000Z')],
      runnerStates,
    });
    renderDmPanel();
    return screen.getByTestId('dm-face-d-forge');
  };

  it('멈춘 러너는 색이 빠진다', () => {
    /**
     * **`online` 에서도 빼야 `stopped` 다.** 실측으로 배운 것이라 적어 둔다: 처음에
     * `online: ['forge']` 를 둔 채 `stopped` 를 기대했는데 `ok` 가 나왔다.
     *
     * `faceState` 를 다시 읽으면 그것이 맞다 — daemon 이 이기는 것은 `running`·`adopted`
     * **둘뿐**이고, `stopped` 는 그 분기에 없다. 그래서 "daemon 이 모르는 것은 서버에
     * 묻는다"로 떨어져 presence 가 답한다. **일부러 그렇게 돼 있다**: daemon 의 장부에서
     * 꺼진 러너가 서버에는 붙어 있으면, 남의 기계에서 같은 에이전트가 돌고 있다는 뜻이라
     * "꺼졌다"고 말하면 거짓이 된다.
     *
     * 여기서 재려는 것은 "꺼진 것이 화면에서 색을 잃는가"이므로 두 출처를 **둘 다**
     * 꺼진 상태로 둔다.
     */
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      online: [],
      dms: [dm('d-forge', 'forge', '2026-09-05T00:00:00.000Z')],
      runnerStates: { forge: runner('stopped', { exitCode: 0 }) },
    });
    renderDmPanel();

    const face = screen.getByTestId('dm-face-d-forge');
    expect(face.dataset.face).toBe('stopped');
    expect(face.innerHTML).toContain('grayscale');
  });

  it('daemon 이 도는 것을 확인했으면 서버가 끊겨도 `ok` 다 (#482)', () => {
    // `faceState` 의 "daemon 이 아는 것이 먼저다" — `kill(pid,0)` 은 관측이고 presence 는
    // 보고다. **소켓이 끊겨도 daemon 은 안 끊긴다.** 이 순서가 뒤집히면 `#430` 이
    // 되돌아온다(그 이슈가 정확히 "presence 를 판정자로 썼다"였다).
    const face = 한줄({ forge: runner('running') }, false);
    expect(face.dataset.face).toBe('ok');
    expect(face.innerHTML).not.toContain('grayscale');
  });

  it('실패한 러너는 붉은 테와 **사유 한 줄**을 받는다 — 유일하게 글자가 느는 상태', () => {
    // `#368` 이 세운 것이다: *"사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다."*
    const face = 한줄({ forge: runner('failed', { message: '하네스가 죽었다' }) });
    expect(face.dataset.face).toBe('failed');
    expect(face.className).toContain('ring-state-stuck');
    // 사유가 **보이는 글자**로 있다. `sr-only` 도 `title` 도 아니다.
    const reason = screen.getByTestId('runner-reason-forge');
    expect(reason.textContent).toContain('하네스가 죽었다');
    expect(reason.className).not.toContain('sr-only');
  });

  it('`needs_harness` 도 얼굴이 갈린다 — 새 사용자의 기본 상태다 (#476)', () => {
    // `#476` 이 고친 결함이 이것이다: 하네스가 없어 물러난 러너가 격자에서 **멀쩡한
    // 얼굴**로 보였다. 그 판정이 `faceState` 안에 있으므로 이 줄도 자동으로 맞다 —
    // 판정을 복제하지 않은 것의 값이 여기서 드러난다.
    const face = 한줄({ forge: runner('needs_harness', { message: 'claude 를 찾을 수 없다' }) });
    expect(face.dataset.face).toBe('failed');
    // 고장이 아니라 **설치가 안 된 것**이라 색이 갈린다(`RunnerStatus.tsx` 의 `TONE`).
    const reason = screen.getByTestId('runner-reason-forge');
    expect(reason.className).toContain('text-warning');
    expect(reason.textContent).toContain('claude 를 찾을 수 없다');
  });

  it('생존을 모르면 `unknown` 이다 — 초록도 회색도 아니다 (#443)', () => {
    // 이 저장소의 규약: `connected === false` 는 '아무도 없다'가 아니라 **'모른다'** 다.
    // 러너 기록이 없으므로 `faceState` 는 서버에 물어야 하고, 서버가 말을 못 한다.
    const face = 한줄({}, false);
    expect(face.dataset.face).toBe('unknown');
    // 색이 빠지지만 ▶ 를 권하지 않는다 — 그 이유는 `faceState` 주석에 있다(이미 도는
    // 러너를 하나 더 띄우게 된다). 여기서는 사유가 **글자로** 닿는지만 본다.
    expect(face.innerHTML).toContain('grayscale');
    // 색은 스크린리더에 아무 말도 하지 않는다(`#443` 의 요지). 같은 말이 글자로도 있고,
    // 그 문구는 `PRESENCE_LABEL.unknown` 이다 — **"오프라인"이라고 쓰지 않는다**(아는 척).
    expect(face.textContent).toContain(PRESENCE_LABEL.unknown);
  });

  it('사람에게도 같은 칸이 상태를 말한다 — 표시가 에이전트에만 있지 않다', () => {
    // 사람에게는 러너가 없다. 그렇다고 사람 아바타를 늘 또렷하게 두면 **표시가
    // 에이전트에만 있는 상태로 되돌아간다** — 합치기 전의 그 결함이다.
    fakeController();
    useAppStore.getState().set({
      ...사람과에이전트,
      online: [],
      dms: [dm('d-nari', 'nari', '2026-09-05T00:00:00.000Z')],
    });
    renderDmPanel();

    const face = screen.getByTestId('dm-face-d-nari');
    expect(face.dataset.face).toBe('stopped');
    expect(face.innerHTML).toContain('grayscale');
  });

  /**
   * **DM 줄은 다섯 번째 얼굴을 모른다 — 그리고 그것이 맞다.**
   *
   * `docs/desktop-agent-cards.pdf` 2쪽이 카드에 **멈추는 중**(`stopRequestedAt` 은 있고
   * `stopAckedAt` 이 없는 동안)을 더했다. 그 판정을 `FaceState` 유니온에 넣지 않은 이유가
   * `lib/faceState.ts` 의 `isStopping` 주석에 있다 — 두 필드는 `AgentConfig` 소속이고,
   * 이 줄이 손에 든 것은 스토어의 `AccountView` 라 **거기에 없다.** 이 줄이 그 값을 얻는
   * 길은 `listAgents()` 를 한 번 더 왕복하는 것뿐이고, `AgentCardSubject` 주석이 그
   * 방향을 이미 거부했다(*"그때부터 같은 목록이 두 곳에 유지된다"*).
   *
   * 그래서 `faceState()` 의 **시그니처가 안 바뀌었다** — 인자는 여전히 넷이고 반환 유니온도
   * 여전히 넷이다. 이 시험이 재는 것은 그 사실의 결과다: 카드 작업이 이 줄을 한 픽셀도
   * 건드리지 않는다.
   *
   * 되돌려 RED: `faceState` 에 `'stopping'` 을 얹고 이 줄이 그것을 받게 만들면 `data-face`
   * 가 `ok` 가 아니게 되고, `dm-face-*` 의 값 집합이 격자의 `data-face` 와 갈린다.
   */
  it('종료 요청 중이어도 DM 줄은 `ok` 다 — 그 판정이 이 줄에 오지 않는다', () => {
    // 러너가 돌고 있고, 서버 쪽 정의에는 종료 요청이 걸려 있는 상황이다. 카드라면
    // 점선 테 + `멈추는 중` 한 줄을 받지만, 이 줄은 그 두 필드를 애초에 갖지 않는다.
    const face = 한줄({ forge: runner('running') });
    expect(face.dataset.face).toBe('ok');
    // 아바타가 흐려지지도, 점선 테가 붙지도 않는다.
    expect(face.innerHTML).not.toContain('grayscale');
    expect(face.className).not.toContain('border-dashed');
    // 글자도 늘지 않는다 — 이 줄이 글자를 받는 것은 여전히 실패뿐이다.
    expect(screen.getByTestId('dm-face-d-forge').closest('button')!.textContent)
      .not.toContain('멈추는 중');
  });
});
