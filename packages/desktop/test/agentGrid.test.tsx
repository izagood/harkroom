// Task 15-2(identity 문서) — 에이전트 그리드 + 검색.
//
// 문서의 마지막 경고가 이 화면의 규칙이다: **"이 화면에서 정보를 더하는 쪽이 항상 지는
// 쪽이다."** 최악은 에이전트 40개이고, 그 수에서 무너지지 않는 것은 **고정 폭 카드와 검색**
// 둘뿐이다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AgentView } from '@murmur/shared';
import { AgentGrid } from '../src/components/settings/AgentGrid';

const agent = (handle: string, over: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...over,
});

const grid = (props: Partial<Parameters<typeof AgentGrid>[0]> = {}) => render(
  <AgentGrid
    agents={props.agents ?? [agent('alpha')]}
    selectedId={props.selectedId ?? null}
    runnerStates={props.runnerStates ?? {}}
    online={props.online ?? []}
    connected={props.connected ?? true}
    onPick={props.onPick ?? vi.fn()}
    onCreate={props.onCreate ?? vi.fn()}
    canCreate={props.canCreate ?? true}
    onRelaunch={props.onRelaunch}
    canRelaunch={props.canRelaunch}
    onStop={props.onStop}
    appVersion={props.appVersion}
    place={props.place}
  />,
);

afterEach(() => cleanup());

describe('AgentGrid — 검색', () => {
  it('이름으로 찾는다', () => {
    grid({ agents: [agent('alpha'), agent('beta')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'bet' } });
    expect(screen.getByTestId('agent-card-beta')).toBeTruthy();
    expect(screen.queryByTestId('agent-card-alpha')).toBeNull();
  });

  /**
   * **검색은 이름만 훑지 않는다**(문서): "배포 담당이 누구였더라"를 이름을 모르는 채로 찾을
   * 수 있어야 검색이 목록을 대신한다. 설명은 카드에 안 보이지만 찾을 때는 쓰인다.
   */
  it('하는 일로도 찾는다 — 이름을 몰라도 찾힌다', () => {
    grid({
      agents: [agent('alpha'), agent('zeta', { instructions: '릴리스 배포를 맡는다' })],
    });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: '배포' } });
    expect(screen.getByTestId('agent-card-zeta')).toBeTruthy();
    expect(screen.queryByTestId('agent-card-alpha')).toBeNull();
  });

  it('못 찾은 것과 아무것도 없는 것은 다른 말이다', () => {
    grid({ agents: [agent('alpha')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByText(/"zzz" 에 맞는 에이전트가 없다/)).toBeTruthy();

    // 목록이 정말 비어 있는 것은 **다른 사실**이다 — 검색어를 지우고 확인한다.
    cleanup();
    grid({ agents: [] });
    expect(screen.getByText('아직 에이전트가 없다')).toBeTruthy();
  });

  it('가나다 고정이다 — 상태순이면 켜고 꺼질 때마다 카드가 자리를 옮긴다', () => {
    grid({ agents: [agent('zeta'), agent('alpha'), agent('mid')], online: ['id-zeta'] });
    const order = screen.getAllByTestId(/^agent-card-/).map((el) => el.dataset.testid);
    expect(order).toEqual(['agent-card-alpha', 'agent-card-mid', 'agent-card-zeta']);
  });

  it('+ 는 맨 앞이라 개수와 무관하게 자리가 고정된다', () => {
    grid({ agents: [agent('alpha')] });
    const buttons = screen.getAllByRole('button');
    // 검색 입력을 지나 첫 버튼이 `+` 다.
    expect(buttons[0]!.dataset.testid).toBe('agent-create');
  });

  it('검색으로 목록이 비어도 + 는 그대로 있다', () => {
    grid({ agents: [agent('alpha')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('agent-create')).toBeTruthy();
  });
});

/**
 * **상태는 사진이 말한다** — 상태 점도 상태 글자도 없다. 아바타 자체가 세 가지로 갈리므로
 * 카드에 줄이 늘지 않는다.
 */
describe('AgentGrid — 아바타 세 얼굴', () => {
  it('정상은 그냥 사진이다 — 정상이 기본값이므로 표시를 붙이지 않는다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  it('멈추면 ▶ 가 뜨고, 그것은 카드와 다른 동작이다', () => {
    const onPick = vi.fn();
    const onRelaunch = vi.fn();
    grid({ agents: [agent('alpha')], online: [], onPick, onRelaunch });

    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('stopped');
    fireEvent.click(screen.getByTestId('agent-relaunch-alpha'));
    // 실행이 우연히 눌리지 않도록 카드 클릭(=설정 열기)과 갈라 둔다.
    expect(onRelaunch).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('실패는 ↻ 를 받고 사유가 글자로 남는다 — 유일하게 글자가 느는 상태다', () => {
    grid({
      agents: [agent('alpha')],
      runnerStates: { 'id-alpha': { agentId: 'id-alpha', status: 'failed', exitCode: 1, message: '노드를 못 찾았다' } },
      onRelaunch: vi.fn(),
    });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('failed');
    // 사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다(#368).
    expect(screen.getByTestId('agent-runner-failed-id-alpha').textContent).toContain('노드를 못 찾았다');
  });

  /**
   * **`#443` 이 이 단언을 뒤집었다.**
   *
   * 앞 판본은 `toBe('ok')` 였고, 그 근거가 이 이름에 남아 있다 — *"40개가 전부 회색이
   * 되면 그것도 거짓말이다"*. **그 문장은 여전히 옳다.** 틀린 것은 그 다음 걸음이다:
   * 회색이 거짓말이라고 해서 `ok`(정상 얼굴)가 참이 되지는 않는다.
   *
   * 실측(2026-09-06, 릴리즈 `.app`)이 그 대가를 보여 줬다 — 서버가 죽어 타이틀 옆 점이
   * 빨강인 그 순간, 에이전트 여섯이 **전부 초록**이었다. 사람은 화면 두 곳에서 서로
   * 반대되는 말을 듣고 아래쪽을 믿었다.
   *
   * 그래서 값이 하나 늘었다. 두 거짓말 중 하나를 고르는 문제가 아니라 **모른다고 말할
   * 값이 없었던 것**이 문제였다(`#368` 의 규율).
   */
  it('생존을 모르면 초록도 회색도 아니다 — 모른다고 말한다 (#443)', () => {
    grid({ agents: [agent('alpha')], online: [], connected: false, onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('unknown');
    // 얼굴 색만 바꾸면 사람은 `stopped`(꺼짐)와 구분하지 못한다. **글자로도 말한다.**
    expect(screen.getByTestId('agent-presence-unknown').textContent).toContain('알 수 없다');
    // **▶ 를 달지 않는다.** 지금 도는지 모르는 것을 켜라고 권하면 `#430` 의 중복이 된다.
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  /**
   * **대조군.** 위 회귀선만 있으면 `faceState` 가 무조건 `unknown` 을 돌려줘도 초록이다 —
   * 즉 "붙어 있어도 모른다고 말하는" 화면으로 이 이슈를 '고칠' 수 있다. 그것은 고친 것이
   * 아니라 정보를 통째로 없앤 것이다.
   *
   * 이 저장소가 반복해서 겪은 실패 모드라 명시한다(`#482` 의 회귀선 ⑦과 같은 자리).
   */
  it('대조군 — 붙어 있으면 초록이다 (#443)', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], connected: true, onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    // 모른다는 줄이 서지 않는다 — 그 줄이 늘 있으면 사람이 곧 읽지 않게 된다.
    expect(screen.queryByTestId('agent-presence-unknown')).toBeNull();
  });

  /**
   * **daemon 이 서버보다 먼저다**(`#443` 의 판단, `#482` 위에 얹는다).
   *
   * 소켓이 끊겨도 daemon 은 안 끊긴다 — daemon 은 이 앱 옆에 있고 서버는 네트워크 너머에
   * 있다. 그리고 daemon 의 `running`·`adopted` 는 `kill(pid, 0)` 로 **직접 관측한** 것이라
   * presence 의 보고보다 강하다. 끊긴 동안 유일하게 남아 있는 사실이 이것이다.
   *
   * 되돌려 RED: `faceState` 의 `if (st === 'running' || st === 'adopted') return 'ok'` 를
   * 지우면 이 단언이 `unknown` 을 받아 빨개진다.
   */
  it('끊겨도 daemon 이 아는 러너는 초록이다 — daemon 이 서버보다 먼저다 (#443)', () => {
    for (const status of ['running', 'adopted'] as const) {
      grid({
        agents: [agent('alpha')],
        online: [],
        connected: false,
        runnerStates: { 'id-alpha': { agentId: 'id-alpha', status, exitCode: null, message: null } },
        onRelaunch: vi.fn(),
      });
      expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
      cleanup();
    }
  });

  /**
   * **`#476`** — 하네스가 없어 물러난 러너가 격자에서 멀쩡한 얼굴이었다.
   *
   * `#473` 이 `needs_harness` 를 만들었는데 이 화면의 `faceState` 는 `failed` 와
   * `needs_reissue` 만 봤다. **새 사용자의 기본 상태가 이것**이라(`claude`·`codex` 는
   * 사용자가 직접 설치한다, 2026-09-06 방침) 가장 흔한 상태가 화면에서 가장 조용했다.
   *
   * 되돌려 RED: `faceState` 의 `|| st === 'needs_harness'` 를 지우면 얼굴이 `stopped` 가
   * 되고 아래 글자 줄도 사라진다.
   */
  it('하네스가 없어 죽은 러너는 멀쩡한 얼굴이 아니다 — 사유가 글자로 온다 (#476)', () => {
    grid({
      agents: [agent('alpha')],
      online: ['id-alpha'],
      connected: true,
      runnerStates: {
        'id-alpha': {
          agentId: 'id-alpha', status: 'needs_harness', exitCode: 78,
          message: '`claude` 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라. Claude Code 를 설치하면 함께 깔린다: https://claude.com/product/claude-code',
        },
      },
      onRelaunch: vi.fn(),
    });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('failed');
    // **설치 주소가 화면에 글자로 온다.** 이름만으로는 사람이 무엇을 어떻게 할지 모른다.
    const line = screen.getByTestId('agent-runner-harness-id-alpha');
    expect(line.textContent).toContain('claude');
    expect(line.textContent).toContain('https://claude.com/product/claude-code');
  });

  it('띄울 수 없는 사람에게는 ▶ 자체가 없다', () => {
    // `onRelaunch` 를 안 넘기면 문이 없다 — 눌러도 안 되는 버튼을 그리지 않는다.
    grid({ agents: [agent('alpha')], online: [] });
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });
});

/**
 * 목업과 맞춘 것들(2026-09-06 화면 확인). 문서의 목업은 **원과 이름만** 있는 격자이고,
 * 실행 글리프는 "사진 안으로 들어간다".
 */
describe('AgentGrid — 목업의 모양', () => {
  it('카드에 상자가 없다 — 26개가 깔릴 때 격자 선이 얼굴보다 먼저 보이면 안 된다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'] });
    const card = screen.getByTestId('agent-card-alpha');
    expect(card.className).not.toMatch(/border-border|bg-surface-hover/);
  });

  it('실행 글리프는 평소 옅고 호버에서 또렷해진다', () => {
    grid({ agents: [agent('alpha')], online: [], onRelaunch: vi.fn() });
    const glyph = screen.getByTestId('agent-relaunch-alpha');
    // 26개가 깔린 화면에서 26개의 진한 글리프는 소음이다.
    expect(glyph.className).toContain('opacity-50');
    expect(glyph.className).toContain('group-hover:opacity-100');
  });

  it('검색창이 몇 개를 뒤지는지 말한다', () => {
    grid({ agents: [agent('alpha'), agent('beta')] });
    expect(screen.getByText('2개')).toBeTruthy();
    // 걸러지면 그 수도 따라간다 — 뒤지고 있는 범위가 곧 이 숫자다.
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'alp' } });
    expect(screen.getByText('1개')).toBeTruthy();
  });
});

/**
 * 정본 `docs/desktop-agent-cards.pdf` 2쪽 — **설정의 카드가 셋을 올린다.**
 *
 * 앞 문서가 세운 *"정보를 더하는 쪽이 항상 지는 쪽이다"* 는 규칙은 **사이드바 패널**의
 * 규칙이었고(폭 164~224px · 훑는 자리 · 40개), 카드 문서가 그 겨누는 자리를 다시 읽었다:
 * *"설정은 바꾸러 오는 곳이고, 바꾸기 전에 확인하러 오는 곳이다."* 그래서 규칙이 뒤집힌
 * 것이 아니라 **같은 컴포넌트가 두 자리에서 다르게 서는 것**이고, 그 축은 `place` 다.
 */
describe('AgentGrid — 카드가 올리는 셋 (설정)', () => {
  it('하네스와 모델을 적는다', () => {
    grid({
      agents: [agent('alpha', { harness: 'claude-code', model: 'sonnet-4.6' })],
      online: ['id-alpha'],
    });
    const card = screen.getByTestId('agent-grid');
    expect(card.textContent).toContain('하네스');
    expect(card.textContent).toContain('claude-code');
    expect(card.textContent).toContain('sonnet-4.6');
  });

  /**
   * **`model === null` 은 '모른다'가 아니다** — `AgentConfig.model` 의 계약이 *"harness
   * 기본값 사용"* 이고, 그것은 **결정**이다. 빈 칸으로 두면 "모델을 모른다"로 읽히고
   * 사람이 상세를 열어 확인하게 되는데, 카드가 있는 이유가 그것을 없애는 것이다.
   *
   * 되돌려 RED: `{a.model ?? '하네스 기본값'}` 의 `??` 우변을 `''` 로 바꾸면 빨개진다.
   */
  it('모델이 null 이면 `하네스 기본값` 이라고 적는다 — 빈 칸은 모른다는 말이 된다', () => {
    grid({ agents: [agent('alpha', { model: null })], online: ['id-alpha'] });
    expect(screen.getByTestId('agent-grid').textContent).toContain('하네스 기본값');
  });

  /**
   * **활동은 `lastTurnAt` 이다.** 문서가 `lastActivityAt` 이라고 적었지만 실측하니 그
   * 필드는 없다 — 서버가 내려 주는 이름은 `lastTurnAt` 이고 이미 목록에 실려 온다.
   *
   * 그리고 계산은 **한 벌**이다: 상세의 `lastTurnLabel` 이 `lib/lastTurn.ts` 의
   * `lastTurnAgo` 위에 접두만 붙인다. 카드는 왼쪽에 `활동` 라벨을 이미 세워 뒀으므로
   * 접두를 안 붙인다 — `활동  마지막 활동: 11분 전` 이 되면 같은 말이 두 번이다.
   */
  it('활동은 lastTurnAt 이고, 라벨이 있으니 접두는 안 붙는다', () => {
    const now = Date.now();
    grid({
      agents: [agent('alpha', { lastTurnAt: new Date(now - 11 * 60_000).toISOString() })],
      online: ['id-alpha'],
    });
    const text = screen.getByTestId('agent-grid').textContent!;
    expect(text).toContain('활동');
    expect(text).toContain('11분 전');
    // 접두가 붙으면 `활동  마지막 활동: 11분 전` 이 된다.
    expect(text).not.toContain('마지막 활동');
  });

  /**
   * **소유자는 여전히 안 올린다**(문서). 한 사람이 다 만든 워크스페이스에서는 모든 카드가
   * 같은 값이라 구별에 아무 기여도 하지 않는다. 셋이 늘었다고 넷째가 따라오는 것을 막는다.
   */
  it('셋뿐이다 — 소유자·작업 디렉터리·지시문은 상세에 남는다', () => {
    grid({
      agents: [agent('alpha', {
        ownerAccountId: 'u-me', workingDir: '/tmp/work', instructions: '배포를 담당한다',
      })],
      online: ['id-alpha'],
    });
    const text = screen.getByTestId('agent-grid').textContent!;
    expect(text).not.toContain('/tmp/work');
    expect(text).not.toContain('배포를 담당한다');
    expect(text).not.toContain('u-me');
  });

  /**
   * **상태 글자는 여전히 없다.** 정보 세 줄이 늘었어도 그 규칙은 그대로다 — 셋 중 어느
   * 것도 *"도는 중"* 이 아니고, 글자를 받는 것은 예외 둘(실패 사유 · 종료 요청 중)뿐이다.
   */
  it('도는 중이라고 적지 않는다 — 얼굴이 말한다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'] });
    const text = screen.getByTestId('agent-grid').textContent!;
    expect(text).not.toContain('도는 중');
    expect(text).not.toContain('실행 중');
    expect(text).not.toContain('온라인');
  });

  /**
   * **카드 아래 버튼 줄이 없다** — 문서가 *"걷어내라"* 고 적은 항목인데 **실측하니 그
   * 버튼이 애초에 없었다**(2026-09-08). 즉 이 시험은 없앤 것을 지키는 것이 아니라
   * **없던 것이 새로 생기지 않게** 잡는다: 정보 세 줄이 들어오면서 그 아래에 `실행하기`·
   * `멈추기` 줄을 세우려는 손이 따라오기 쉽다.
   *
   * 카드 하나에 서는 버튼은 **둘까지**다 — 카드 자체와 얼굴 글리프 하나(`▶`/`↻`/`■` 는
   * 서로 배타적이다). 뒤처진 버전 칩이 세 번째가 될 수 있지만 그것은 아래 별도 시험이
   * 다루고, 여기서는 최신 버전으로 세워 둔다.
   */
  /**
   * **세 줄이 같은 x 에서 시작한다.** 이 정보를 카드에 올린 이유가 *"여러 에이전트를
   * 나란히 놓고 비교"* 이고, 값이 카드 안에서 지그재그로 서면 세로로 훑는 비교가 안 된다.
   * `Profile.tsx` 의 `Row` 가 같은 이유로 고정 폭 라벨을 쓴다 — 그 형태를 그대로 따랐다.
   *
   * 되돌려 RED: `InfoRow` 의 라벨에서 `w-9` 를 지우면 `하네스`(3자)와 `러너`(2자)의 폭이
   * 달라져 값 칸의 시작이 어긋난다.
   */
  it('세 줄의 라벨이 고정 폭이다 — 값이 같은 x 에서 시작한다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.3' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
    });
    const labels = [...screen.getByTestId('agent-grid').querySelectorAll('.w-9')];
    expect(labels.map((l) => l.textContent)).toEqual(['하네스', '러너', '활동']);
    // 전부 `shrink-0` 여야 긴 값이 라벨을 밀지 않는다.
    labels.forEach((l) => expect(l.className).toContain('shrink-0'));
  });

  /**
   * **한 줄의 구분선이 같은 y 에 있다** — 실측하다 발견한 결함이다(2026-09-08, 720px 폭에
   * 8장을 깔고 화면 확인).
   *
   * 처음 판본에는 `h-full`·`mt-auto` 가 없었고, 화면을 보니 **같은 줄의 구분선이 서로 다른
   * 높이에 떠 있었다** — 이름이 한 줄인 카드, 두 줄인 카드, `멈추는 중` 글자를 얻은 카드가
   * 각각 다른 높이라 그 아래 정보 묶음이 따라 밀렸다. 세 값을 **나란히 놓고 비교하는 것**이
   * 이 정보를 카드에 올린 이유인데, 값이 서로 다른 y 에 있으면 그 비교가 눈으로 안 된다.
   *
   * 되돌려 RED: 카드 감싸개의 `h-full` 이나 정보 묶음의 `mt-auto` 중 하나만 지워도 이
   * 단언이 빨개진다. jsdom 은 레이아웃을 계산하지 않으므로 **높이를 재지 않고 그 두
   * 클래스가 있는지**를 잰다 — 실제 정렬은 브라우저에서 눈으로 확인했다.
   */
  it('정보 묶음이 카드 바닥에 붙는다 — 한 줄의 구분선이 같은 y 다', () => {
    grid({
      agents: [agent('alpha'), agent('beta', { displayName: '이름이 아주 긴 에이전트' })],
      online: ['id-alpha', 'id-beta'],
    });
    for (const handle of ['alpha', 'beta']) {
      const wrapper = screen.getByTestId(`agent-card-${handle}`).parentElement!;
      expect(wrapper.className).toContain('h-full');
      expect(wrapper.querySelector('.border-t')!.className).toContain('mt-auto');
    }
  });

  /**
   * **트랙 폭은 값이 요구하는 폭에서 나왔다**(실측 2026-09-08, 브라우저에서 `max-content`
   * 로 측정). 가장 넓은 값이 뒤처진 버전 칩(`v0.1.1 · 뒤처짐 ↻`)의 93px 이고, 라벨 36 +
   * 간격 8 을 더해 카드가 실제로 필요한 폭이 **137px** 이다.
   *
   * 이 시험이 잡는 것: 누가 트랙을 128px 같은 값으로 줄이면 그 칩이 매번 잘리고, `truncate`
   * 때문에 **조용히** 잘린다 — 화면에 `v0.1.1 · 뒤처…` 가 뜨는 것을 아무도 모른다.
   * 숫자를 여기 박아 두면 줄이는 변경이 이 단언에서 멈춘다.
   */
  it('트랙 폭이 뒤처진 칩이 요구하는 137px 을 만족한다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'] });
    const track = screen.getByTestId('agent-grid').className
      .match(/repeat\(auto-fill,(\d+)px\)/)![1];
    expect(Number(track)).toBeGreaterThanOrEqual(137);
    // 카드 폭과 트랙이 **같아야** 한다(`PLACE` 주석: 다르면 이름이 옆 칸을 침범한다).
    expect(screen.getByTestId('agent-card-alpha').className).toContain(`w-[${track}px]`);
  });

  it('카드 아래에 버튼 줄이 서지 않는다 — 손잡이는 얼굴과 버전 칩뿐이다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.3' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      onRelaunch: vi.fn(),
      onStop: vi.fn(),
    });
    const buttons = screen.getByTestId('agent-grid').querySelectorAll('button');
    // `+` 카드 · 카드 자체 · `■` 셋이다. 그 밖의 버튼이 있으면 줄이 생긴 것이다.
    expect([...buttons].map((b) => b.getAttribute('data-testid'))).toEqual([
      'agent-create', 'agent-card-alpha', 'agent-stop-alpha',
    ]);
  });
});

/**
 * 버전 칩 3종 (`docs/desktop-agent-cards.pdf` 3쪽 상단).
 *
 * 판정은 `lib/runnerVersions.ts` 의 `staleRunners()` 를 **그대로 쓴다** — 그 모듈의
 * 규칙이 *"모르는 것을 뒤처졌다고 하지 않는다"* 이고, `test/runnerVersions.test.ts` 가
 * 이미 그 규칙 자체를 잰다. 여기서 재는 것은 **칩이 그 판정을 어떻게 그리는가**다.
 */
describe('AgentGrid — 러너 버전 칩 3종', () => {
  it('최신은 회색 칩이고 손잡이가 없다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.3' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      onRelaunch: vi.fn(),
    });
    const chip = screen.getByTestId('agent-version-alpha');
    expect(chip.dataset.version).toBe('current');
    expect(chip.textContent).toContain('v0.1.3');
    // 갈아 끼울 것이 없으므로 문이 없다.
    expect(chip.tagName).toBe('SPAN');
  });

  /**
   * **뒤처짐은 칩 자체가 눌린다.** 문서: *"얼굴에 붙이면 `↻` 가 실패와 뒤처짐 두 가지를
   * 뜻하게 되고, 도는 것을 멈출 방법이 사라진다."* 뒤처진 러너는 잘 돌고 있으므로 얼굴은
   * `ok` 이고 그 자리는 `■` 가 쓴다.
   *
   * 되돌려 RED: 칩의 `button` 을 `span` 으로 바꾸면 `tagName`·클릭 단언이 빨개진다.
   */
  it('뒤처짐은 주의색 칩이고 칩 자체가 재기동이다', () => {
    const onRelaunch = vi.fn();
    const onPick = vi.fn();
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.1' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      onRelaunch,
      onPick,
    });
    const chip = screen.getByTestId('agent-version-alpha');
    expect(chip.dataset.version).toBe('stale');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.textContent).toContain('v0.1.1');
    expect(chip.textContent).toContain('뒤처짐');

    fireEvent.click(chip);
    expect(onRelaunch).toHaveBeenCalledTimes(1);
    // 카드 클릭(=상세 열기)과 갈라 둔다 — 겹치면 재기동이 우연히 상세를 연다.
    expect(onPick).not.toHaveBeenCalled();

    // 얼굴은 `ok` 그대로다: 뒤처진 러너는 **잘 돌고 있다**. 그래서 `↻` 가 얼굴에 안 선다.
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  /**
   * **강조색이 아니라 주의색이다**(규칙 04 · `test/accentBudget.test.tsx`). 뒤처진 러너는
   * 나를 막지 않는다 — 잘 돌고 있고, 갈아 끼우는 것은 내가 고를 일이다.
   */
  it('뒤처진 칩은 강조색을 쓰지 않는다 — 나를 막는 것이 아니다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.1' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      onRelaunch: vi.fn(),
    });
    const chip = screen.getByTestId('agent-version-alpha');
    expect(chip.className).not.toContain('accent');
    expect(chip.className).toContain('warning');
    // 실패의 `danger` 와도 섞이지 않는다 — 고장이 아니다.
    expect(chip.className).not.toContain('danger');
  });

  /**
   * **모르는 것을 뒤처졌다고 하지 않는다**(`runnerVersions.ts` 의 판정). `null`(한 번도
   * 보고 없음)과 `'unknown'`(러너가 `AGENT_VERSION` 을 못 받음)은 원인이 다르지만 이
   * 판정에는 같다.
   *
   * 되돌려 RED: `VersionChip` 의 `unknown.length > 0` 분기를 지우면 `null` 이 최신 칩으로
   * 떨어져 빈 칩이 서거나(값이 `null`) 뒤처짐으로 단정된다.
   */
  it('모름은 점선 칩이고 손잡이가 없다', () => {
    for (const runnerVersion of [null, 'unknown']) {
      grid({
        agents: [agent('alpha', { runnerVersion })],
        appVersion: 'v0.1.3',
        online: ['id-alpha'],
        onRelaunch: vi.fn(),
      });
      const chip = screen.getByTestId('agent-version-alpha');
      expect(chip.dataset.version).toBe('unknown');
      expect(chip.textContent).toContain('버전 모름');
      expect(chip.className).toContain('border-dashed');
      expect(chip.tagName).toBe('SPAN');
      cleanup();
    }
  });

  /**
   * **앱 버전을 모르면 아무것도 뒤처졌다고 하지 않는다.** 비교 기준이 없는데 단정하는 것이
   * `docs/design.md` §4 가 금지하는 거짓 신호다 — `staleRunners` 가 이미 그렇게 정했고,
   * 이 시험은 칩이 그 판정을 우회하지 않는 것을 지킨다.
   *
   * 그리고 이것이 **사이드바의 기본값**이다: `appVersion` prop 을 안 넘기면 `null` 이다.
   */
  it('앱 버전을 모르면 뒤처졌다고 하지 않는다 — 기준이 없다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.1' })],
      appVersion: null,
      online: ['id-alpha'],
      onRelaunch: vi.fn(),
    });
    const chip = screen.getByTestId('agent-version-alpha');
    expect(chip.dataset.version).toBe('unknown');
    expect(chip.dataset.version).not.toBe('stale');
  });

  /**
   * **권한 없는 사람에게는 문이 없다**(`AgentGrid` 주석). 사실은 남고 문만 없어진다 —
   * `docs/design.md` §4: 눌러도 아무 일이 없는 버튼을 그리지 않는다.
   */
  it('띄울 수 없는 사람에게는 뒤처진 칩도 안 눌린다 — 사실은 남는다', () => {
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.1' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      // 문이 아예 없는 경우.
    });
    const chip = screen.getByTestId('agent-version-alpha');
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toContain('뒤처짐');
    cleanup();

    // 콜백은 있지만 이 카드에는 권한이 없는 경우 — `canRelaunch` 가 그것을 가른다.
    grid({
      agents: [agent('alpha', { runnerVersion: 'v0.1.1' })],
      appVersion: 'v0.1.3',
      online: ['id-alpha'],
      onRelaunch: vi.fn(),
      canRelaunch: () => false,
    });
    expect(screen.getByTestId('agent-version-alpha').tagName).toBe('SPAN');
  });
});

/**
 * **얼굴 하나가 상태와 손잡이를 겸한다** (`docs/desktop-agent-cards.pdf` 2쪽 하단 다섯 칸).
 *
 * | 상태 | 얼굴 | 손잡이 |
 * |---|---|---|
 * | 도는 중 | 그냥 사진 | 없음(평소) |
 * | 도는 중 · 올렸을 때 | `■` | `■` 로 멈춘다 |
 * | 멈추는 중 | 점선 테 · 반쯤 빠짐 | **없다** |
 * | 멈춤 | 색 빠짐 + `▶` | `▶` 로 켠다 |
 * | 실패 | 붉은 테 + `↻` | `↻` 로 다시 · 사유는 글자 |
 */
describe('AgentGrid — `■` 는 평소 없는 것과 같다', () => {
  /**
   * 문서가 이 비대칭에 값을 매겼다: *"멈추기는 훑는 동작이 아니다. 지금 켤 수 있는 것이
   * 몇 개인지는 스캔 한 번에 와야 하지만(그래서 `▶` 는 늘 보인다), 멈출 것은 이미 고른
   * 다음에 찾는다."*
   *
   * 그래서 `▶`·`↻` 의 `opacity-50`(평소 옅게 보임)이 아니라 `opacity-0`(평소 안 보임)이다.
   * 되돌려 RED: `opacity-0` 을 `opacity-50` 으로 바꾸면 이 단언이 빨개진다.
   */
  it('평소 opacity-0 이고 hover 에서 뜬다 — ▶ 와 다르다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], onStop: vi.fn() });
    const stop = screen.getByTestId('agent-stop-alpha');
    expect(stop.className).toContain('opacity-0');
    expect(stop.className).toContain('group-hover:opacity-100');
    // `▶` 는 평소 옅게 **보인다** — 이 둘이 같은 값이면 문서의 비대칭이 사라진다.
    expect(stop.className).not.toContain('opacity-50');
  });

  /**
   * **키보드는 대가를 치르지 않는다.** 마우스가 없으면 안 보이는 것이 이 비대칭의 대가인데,
   * `GLYPH_FOCUS` 가 `focus-visible:opacity-100` 을 이미 갖고 있어 그 대가가 키보드까지
   * 가지 않는다. 그 상수가 만들어진 이유가 정확히 이것이었다(그 주석).
   *
   * 되돌려 RED: `■` 에서 `GLYPH_FOCUS` 를 떼면 키보드로 격자를 훑는 사람에게 이 버튼이
   * 영원히 안 보인다.
   */
  it('키보드에서는 focus-visible 로 뜬다 — GLYPH_FOCUS 를 쓴다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], onStop: vi.fn() });
    const stop = screen.getByTestId('agent-stop-alpha');
    expect(stop.className).toContain('focus-visible:opacity-100');
    expect(stop.className).toContain('focus-visible:outline-accent');
  });

  it('카드와 다른 동작이다 — 누르면 멈추고 상세는 안 열린다', () => {
    const onStop = vi.fn();
    const onPick = vi.fn();
    grid({ agents: [agent('alpha')], online: ['id-alpha'], onStop, onPick });
    fireEvent.click(screen.getByTestId('agent-stop-alpha'));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  /** 문이 없으면 그리지 않는다 — `onRelaunch` 와 같은 규율이다. */
  it('멈출 수 없는 사람에게는 ■ 자체가 없다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'] });
    expect(screen.queryByTestId('agent-stop-alpha')).toBeNull();
  });

  /**
   * `▶`·`↻` 와 **배타적**이다: `■` 는 `face === 'ok'` 일 때만 서고 그쪽은 `face !== 'ok'`
   * 다. 한 카드에 둘이 함께 서면 사람은 무엇이 지금 상태인지 알 수 없다.
   */
  it('멈춘 카드에는 ■ 가 없다 — 없는 것을 멈추라고 권하지 않는다', () => {
    grid({ agents: [agent('alpha')], online: [], onStop: vi.fn(), onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('stopped');
    expect(screen.queryByTestId('agent-stop-alpha')).toBeNull();
    expect(screen.getByTestId('agent-relaunch-alpha')).toBeTruthy();
  });
});

/**
 * **종료 요청 중** — `stopRequestedAt` 은 있고 `stopAckedAt` 이 없는 동안이다.
 * 문서: *"도는 것도 멈춘 것도 아니다."*
 *
 * 판정은 `lib/faceState.ts` 의 `isStopping` 이고, **`FaceState` 유니온에는 안 들어갔다** —
 * 그 함수 주석이 이유를 적었다: 두 필드가 `AgentConfig` 소속이라 사이드바가 손에 든
 * `AccountView` 에는 없고, 사이드바가 받을 수 없는 값을 유니온에 앉히면 `FaceState` 의
 * 계약(*"이 넷은 각각 그리는 방법이 다르다"*)이 거짓이 된다.
 */
describe('AgentGrid — 종료 요청 중은 도는 것도 멈춘 것도 아니다', () => {
  const stopping = (over = {}) => agent('alpha', {
    stopRequestedAt: '2026-09-08T10:23:00.000Z', stopAckedAt: null, ...over,
  });

  /**
   * **앞 판본은 이것을 `ok`(그냥 사진)로 그렸다.** `faceState` 의 입력이 넷뿐이라
   * (`id`·`runnerStates`·`online`·`connected`) 이 상태를 알 방법이 없었고, 그래서 문서가
   * 적은 결함이 그대로 있었다: *"격자에서 멀쩡히 도는 것처럼 보이면 사람은 멈추기를 한 번
   * 더 누른다."*
   *
   * 되돌려 RED: `AgentGrid` 의 `stopping` 계산을 `false` 로 고정하면 점선 테와 글자 줄이
   * 함께 사라져 세 단언이 빨개진다.
   */
  it('점선 테와 반쯤 빠진 사진 — 그리고 글자 한 줄', () => {
    grid({ agents: [stopping()], online: ['id-alpha'], onStop: vi.fn() });
    const card = screen.getByTestId('agent-card-alpha');
    expect(card.dataset.stopping).toBe('true');
    // 점선이다 — 실선 테는 실패(`ring-state-stuck`)와 선택(`ring-accent`)이 이미 쓴다.
    expect(card.querySelector('.border-dashed')).toBeTruthy();
    // 반쯤만 빠진다: 완전히 빼면 `stopped` 와 같은 회색이 되어 "이미 멈췄다"로 읽힌다.
    expect(card.innerHTML).toContain('grayscale-[0.5]');
    expect(card.innerHTML).not.toContain('brightness-[1.7]');
    // **예외에만 글자를 쓴다** — 이것이 그 예외 둘 중 하나다.
    expect(screen.getByTestId('agent-stopping-alpha').textContent)
      .toContain('멈추는 중 · 러너가 아직 못 봤다');
  });

  /**
   * **손잡이가 없다**(목업 2쪽 하단 세 번째 칸). 문서: *"지금 할 수 있는 일이 기다리는
   * 것뿐이다."* 이미 요청한 것을 한 번 더 요청하는 버튼은 아무 일도 하지 않으면서 사람에게
   * "안 먹었나" 를 묻게 만든다.
   *
   * 되돌려 RED: `canStop` 에서 `&& !stopping` 을 지우면 `■` 가 서서 빨개진다.
   */
  it('손잡이가 하나도 없다 — 기다리는 것 말고 할 일이 없다', () => {
    grid({
      agents: [stopping()], online: ['id-alpha'], onStop: vi.fn(), onRelaunch: vi.fn(),
    });
    expect(screen.queryByTestId('agent-stop-alpha')).toBeNull();
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  /**
   * **수령한 뒤로는 이 상태가 아니다.** `stopAckedAt` 이 채워지면 러너가 요청을 읽어 간
   * 것이고, 그 뒤로 화면이 기다릴 것은 없다(`AgentConfig.stopAckedAt` 주석: 그 값이
   * '멈췄다'를 뜻하지는 않지만, '아직 못 봤다'는 말은 이제 거짓이다).
   *
   * **대조군이다.** 위 두 시험만 있으면 `isStopping` 이 `stopRequestedAt` 하나만 보게
   * 만들어도 초록이고, 그러면 요청을 받아 간 러너가 영원히 "아직 못 봤다"로 남는다.
   */
  it('대조군 — 러너가 받아 간 뒤로는 멈추는 중이 아니다', () => {
    grid({
      agents: [stopping({ stopAckedAt: '2026-09-08T10:23:04.000Z' })],
      online: ['id-alpha'],
      onStop: vi.fn(),
    });
    const card = screen.getByTestId('agent-card-alpha');
    expect(card.dataset.stopping).toBeUndefined();
    expect(screen.queryByTestId('agent-stopping-alpha')).toBeNull();
    // 도는 중으로 돌아간다 — `■` 가 다시 선다.
    expect(screen.getByTestId('agent-stop-alpha')).toBeTruthy();
  });

  /**
   * **`ok` 위에만 얹는다.** 이미 `stopped`·`failed`·`unknown` 인 얼굴을 덮으면 더 강한
   * 사실(러너가 죽었다 · 생사를 모른다)을 약한 사실로 가린다. 특히 `unknown` 을 덮으면
   * 서버와 끊긴 동안 "멈추는 중"이라고 단정하는 셈인데, 그것은 아무도 확인하지 않은 말이다.
   *
   * 되돌려 RED: `stopping` 계산에서 `face === 'ok'` 를 지우면 끊긴 카드가 `unknown` 얼굴에
   * 점선 테를 함께 달고, `실패`한 카드가 "아직 못 봤다"고 말한다.
   */
  it('더 강한 사실을 가리지 않는다 — unknown·failed 를 덮지 않는다', () => {
    grid({ agents: [stopping()], online: [], connected: false, onStop: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('unknown');
    expect(screen.getByTestId('agent-card-alpha').dataset.stopping).toBeUndefined();
    expect(screen.queryByTestId('agent-stopping-alpha')).toBeNull();
    cleanup();

    grid({
      agents: [stopping()],
      online: ['id-alpha'],
      runnerStates: {
        'id-alpha': {
          agentId: 'id-alpha', status: 'failed', exitCode: 1, message: 'PAT 가 폐기되었다',
        },
      },
      onStop: vi.fn(),
      onRelaunch: vi.fn(),
    });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('failed');
    expect(screen.getByTestId('agent-card-alpha').dataset.stopping).toBeUndefined();
    // 실패 사유가 그대로 온다 — 그것이 두 예외 중 다른 하나다.
    expect(screen.getByTestId('agent-runner-failed-id-alpha').textContent)
      .toContain('PAT 가 폐기되었다');
  });

  /**
   * **강조색이 아니다**(규칙 04). 멈추는 중은 나를 막지 않고 — 기다리면 끝난다 — 고장도
   * 아니라 `danger` 가 아니다.
   */
  it('주의색이다 — 나를 막지도, 고장도 아니다', () => {
    grid({ agents: [stopping()], online: ['id-alpha'], onStop: vi.fn() });
    const line = screen.getByTestId('agent-stopping-alpha');
    expect(line.className).toContain('warning');
    expect(line.className).not.toContain('accent');
    expect(line.className).not.toContain('danger');
  });
});

/**
 * # 사이드바 격리 회귀선 — **한 픽셀도 안 바뀐다**
 *
 * ## 왜 이것이 새로 필요했나 (실측 2026-09-08)
 *
 * `AgentGrid` 의 두 `place` 는 **완전히 같은 JSX 를 공유했고** `place` 로 갈리는 조건부
 * 렌더가 하나도 없었다 — 갈리는 것은 `PLACE` 표의 클래스 치환뿐이었다. 그래서 기존
 * 회귀선(`agentsPanelGrid.test.tsx` 의 *"자리를 안 주면 설정의 그 격자다"*)은 `place` 를
 * **안 줬을 때**의 트랙·아바타·바닥색 넷만 보고, 그것으로 충분했다.
 *
 * 이 작업이 그 전제를 깼다: 정보 블록·`■`·종료 요청 중이 **첫 `place` 조건부 렌더**다.
 * 조건이 하나라도 빠지면 그 블록이 폭 164px 짜리 사이드바로 새고, 기존 회귀선은 그것을
 * 보지 않는다(`place` 를 안 주는 경우를 재므로 오히려 서 있어야 맞다).
 *
 * `AgentGridPlace` 주석이 그 위험을 미리 적어 뒀다: *"그 이상으로 늘릴 축이 아니다 —
 * 늘어나기 시작하면 카드가 다시 두 벌이 된다."* 그래서 축을 늘리는 대신 조건부로 얹었고,
 * **얹은 것이 새지 않는 것을 여기서 잠근다.**
 *
 * ## 사이드바가 이 값들을 애초에 못 받는다는 것과 별개다
 *
 * 스토어의 `AccountView` 에는 `harness`·`runnerVersion`·`lastTurnAt`·`stopRequestedAt`
 * 이 하나도 없으므로 오늘은 두 겹으로 막혀 있다. 그래도 이 시험은 **필드를 다 채운
 * `AgentView` 를 사이드바 자리에 넣는다** — 사이드바가 언젠가 `AgentView` 를 얻는 날
 * (또는 누가 그 방향을 다시 시도하는 날) 타입 쪽 방어가 사라지고 자리 분기만 남기 때문이다.
 * 그 하루를 위해 회귀선이 있다.
 */
describe('AgentGrid — 사이드바는 한 픽셀도 안 바뀐다', () => {
  /** 사이드바가 오늘 넘기는 것 + **넘길 수 있는 것을 다 넘긴 최악의 경우**. */
  const sidebar = (over: Partial<Parameters<typeof AgentGrid>[0]> = {}) => grid({
    agents: [agent('alpha', {
      harness: 'claude-code', model: 'sonnet-4.6', runnerVersion: 'v0.1.1',
      lastTurnAt: '2026-09-08T10:12:00.000Z',
      stopRequestedAt: '2026-09-08T10:23:00.000Z', stopAckedAt: null,
    })],
    online: ['id-alpha'],
    onRelaunch: vi.fn(),
    // 사이드바는 이 둘을 안 넘긴다. 그래도 **넘겨 보고** 자리 분기가 막는지 본다.
    onStop: vi.fn(),
    appVersion: 'v0.1.3',
    place: 'sidebar',
    ...over,
  });

  /**
   * 되돌려 RED: `place === 'settings' && (…)` 정보 블록의 조건을 지우면 네 단언이 한꺼번에
   * 빨개진다. 하나씩 빼도 잡힌다 — 라벨 셋을 따로 재는 이유가 그것이다.
   */
  it('하네스·모델·버전 칩·활동 줄이 하나도 없다', () => {
    sidebar();
    const g = screen.getByTestId('agent-grid');
    expect(g.textContent).not.toContain('하네스');
    expect(g.textContent).not.toContain('claude-code');
    expect(g.textContent).not.toContain('sonnet-4.6');
    expect(g.textContent).not.toContain('러너');
    expect(g.textContent).not.toContain('활동');
    expect(g.textContent).not.toContain('분 전');
    // 칩은 testid 로도 없어야 한다 — 글자만 재면 빈 칩이 서 있어도 통과한다.
    expect(screen.queryByTestId('agent-version-alpha')).toBeNull();
    // 구분선도 없다: 사이드바 카드는 얼굴과 이름 한 줄뿐이다.
    expect(g.querySelector('.border-t')).toBeNull();
  });

  /**
   * **사이드바에는 오늘 `▶`·`↻` 만 있다**(실측: `Sidebar.tsx` 의 호출부가 `onRelaunch`·
   * `canRelaunch` 만 넘긴다). `■` 가 새면 폭 164px 짜리 카드에 얼굴을 덮는 손잡이가 하나
   * 더 생기고, 그 자리에서 *"멈출 것은 이미 고른 다음에 찾는다"* 는 전제가 성립하지 않는다 —
   * 사이드바는 정확히 **훑는 자리**다.
   *
   * 되돌려 RED: `canStop` 에서 `place === 'settings'` 를 지우면 이 단언이 빨개진다.
   */
  it('카드에 ■ 손잡이가 없다 — 사이드바는 ▶·↻ 만 갖는다', () => {
    // 도는 중이고 `onStop` 을 넘겼는데도 `■` 가 없어야 한다.
    sidebar({ agents: [agent('alpha', { stopRequestedAt: null, stopAckedAt: null })] });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    expect(screen.queryByTestId('agent-stop-alpha')).toBeNull();
    cleanup();

    // 멈춘 카드의 `▶` 는 **그대로 있다** — 없애는 것이 아니라 새 것이 안 새는 것이다.
    sidebar({ agents: [agent('alpha')], online: [] });
    expect(screen.getByTestId('agent-relaunch-alpha')).toBeTruthy();
  });

  /**
   * 되돌려 RED: `stopping` 계산에서 `place === 'settings'` 를 지우면 점선 테와 글자 줄이
   * 사이드바 카드에 서서 빨개진다.
   */
  it('종료 요청 중 표시가 없다', () => {
    sidebar();
    const card = screen.getByTestId('agent-card-alpha');
    expect(card.dataset.stopping).toBeUndefined();
    expect(card.querySelector('.border-dashed')).toBeNull();
    expect(screen.queryByTestId('agent-stopping-alpha')).toBeNull();
    expect(screen.getByTestId('agent-grid').textContent).not.toContain('멈추는 중');
  });

  /**
   * **이름줄도 오늘 그대로다.** 설정은 `displayName` + `@handle` 두 줄이지만 사이드바는
   * 내용 폭이 164px 부터라 두 줄을 세울 자리가 없다 — 오늘처럼 `handle` 한 줄이다.
   *
   * `textContent` 전체를 재지 않는 이유: `Identity` 가 머리글자(`A`)와 `sr-only` 핸들을
   * 함께 낸다(그 컴포넌트 주석) — 그것들은 이 변경과 무관하고, 함께 재면 `Identity` 를
   * 고치는 사람이 이 시험을 깨게 된다. `font-semibold` 도 못 쓴다: **실측하니 아바타 원의
   * 머리글자가 이미 그 클래스를 쓴다.** 남는 것이 `text-[13px]` 이고, 그것은 이 격자에서
   * 설정의 이름줄 하나만 쓴다(사이드바는 11px 한 줄이다).
   */
  it('이름줄이 한 줄이다 — 두 줄로 늘지 않는다', () => {
    sidebar();
    const card = screen.getByTestId('agent-card-alpha');
    // 설정에서만 서는 `displayName` 줄(13px)이 없다.
    expect(card.querySelector('.text-\\[13px\\]')).toBeNull();
    // `@` 접두도 없다(오늘 모양).
    expect(card.textContent).not.toContain('@');
    cleanup();

    // **대조군** — 설정에서는 실제로 두 줄이다. 이 단언이 없으면 이름줄을 통째로 없애도
    // 위 두 단언이 초록이고, 그것은 사이드바를 지킨 것이 아니라 기능을 없앤 것이다.
    grid({ agents: [agent('alpha', { displayName: '알파' })], online: ['id-alpha'] });
    const settingsCard = screen.getByTestId('agent-card-alpha');
    expect(settingsCard.querySelector('.text-\\[13px\\]')!.textContent).toBe('알파');
    expect(settingsCard.textContent).toContain('@alpha');
  });

  /** **크기와 바닥색도 그대로다** — 이 축이 원래 갈랐던 것이 안 바뀌는지 함께 잠근다. */
  it('트랙 64px · 아바타 40px 이 그대로다', () => {
    sidebar();
    const g = screen.getByTestId('agent-grid');
    expect(g.className).toContain('repeat(auto-fill,64px)');
    expect(screen.getByTestId('agent-card-alpha').querySelector('.h-10')).toBeTruthy();
    // 설정의 88px 이 새면 카드가 칸을 넘친다.
    expect(screen.getByTestId('agent-card-alpha').querySelector('.h-\\[88px\\]')).toBeNull();
    expect(screen.getByTestId('agent-search').closest('.sticky')!.className)
      .toContain('bg-surface-sunken');
  });
});
