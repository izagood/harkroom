// 팀 카드(`docs/desktop-agent-cards.html` 4단계 — 정본의 마지막 단계).
//
// 문서가 이 카드를 **에이전트 카드와 같은 틀**로 두라고 했고, *"다른 것은 얼굴 자리에
// 얼굴이 여럿이라는 것뿐이다"* 라고 적었다. 이 파일이 재는 것은 그 "여럿"이 실제로 뜻을
// 갖는가다 — 넷이 서는 것만으로는 부족하고, **어느 넷이 어느 순서로** 서는지가 이 카드가
// 말하려는 사실 전부다.
import { describe, it, expect, afterEach, vi, beforeEach} from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AccountView, AgentTeamMemberRow } from '@murmur/shared';
import type { RunnerState } from '../src/lib/runnerLauncher';
import { TeamGrid, type TeamCardSubject } from '../src/components/settings/TeamGrid';
import { acc } from './helpers/fakeApi';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

/** 러너 상태 하나. `agentGrid.test.tsx` 가 같은 네 필드를 손으로 적는다. */
const rs = (
  agentId: string, status: RunnerState['status'], message: string | null = null,
): RunnerState => ({ agentId, status, exitCode: null, message });

/** 계정 하나. `acc` 헬퍼를 쓴다 — 모양을 손으로 적으면 `AccountView` 에 필드가 하나
 *  더 늘 때 고칠 자리가 테스트 파일 수만큼 생긴다(그 헬퍼 주석). */
const account = (id: string, handle: string): AccountView => acc(id, handle, 'agent');

const member = (accountId: string, handle: string, disabled = false): AgentTeamMemberRow =>
  ({ accountId, handle, disabled });

const team = (name: string, members?: AgentTeamMemberRow[], memberCount?: number): TeamCardSubject => ({
  id: `t-${name}`, name, createdBy: 'u1', createdAt: '2026-09-08T00:00:00.000Z',
  memberCount: memberCount ?? members?.length ?? 0,
  members,
});

/** 팀원 전부의 계정을 만든다 — 얼굴을 그리려면 계정이 필요하다(팀원 행에는 handle 만 있다). */
const accountsFor = (teams: TeamCardSubject[]): Record<string, AccountView> =>
  Object.fromEntries(
    teams.flatMap((t) => t.members ?? []).map((m) => [m.accountId, account(m.accountId, m.handle)]),
  );

const grid = (props: Partial<Parameters<typeof TeamGrid>[0]> = {}) => {
  // `null`(목록을 못 받았다)을 **그대로 넘길 수 있어야 한다** — `?? 기본값` 이면 그 사실이
  // 팀 하나로 바뀌어, 이 파일이 그 상태를 아예 못 세운다.
  const teams = props.teams === undefined ? [team('ops', [member('a1', 'bot')])] : props.teams;
  return render(
    <TeamGrid
      teams={teams}
      accounts={props.accounts ?? accountsFor(teams ?? [])}
      runnerStates={props.runnerStates ?? {}}
      online={props.online ?? []}
      connected={props.connected ?? true}
      onPick={props.onPick ?? vi.fn()}
      onCreate={props.onCreate ?? vi.fn()}
      canCreate={props.canCreate ?? true}
    />,
  );
};

/** 카드에 실제로 선 얼굴들을 **왼쪽부터** 읽는다 — 이 파일이 재는 것이 순서다. */
const facesOf = (name: string): { handle: string; face: string; z: number }[] =>
  [...screen.getByTestId(`team-faces-${name}`).querySelectorAll('[data-face]')]
    .map((el) => ({
      handle: (el as HTMLElement).dataset.testid!.replace(`team-face-${name}-`, ''),
      face: (el as HTMLElement).dataset.face!,
      z: Number((el as HTMLElement).style.zIndex),
    }));

afterEach(() => cleanup());

/**
 * ## 겹치는 순서가 **고장난 것부터** (문서 4단계)
 *
 * > *"실패 → 멈춤 → 도는 중 순으로 왼쪽에 서고 **왼쪽이 위로** 겹친다. 이름순으로 겹치면
 * > 붉은 테가 옆 얼굴에 잘려 사라지고, 다섯 중 하나가 죽은 팀이 멀쩡한 팀과 같아 보인다."*
 *
 * 이 절이 이 파일의 중심이다. 문서가 값을 매긴 문장을 그대로 잰다 — **두 축을 따로 잰다**:
 *
 * 1. **자리**(누가 왼쪽인가) — `sortTeamFaces` 가 정한다
 * 2. **쌓임**(누가 위인가) — `zIndex` 가 정한다
 *
 * 둘 다 필요하다는 것이 실측이다: 정렬만 고치면 실패 얼굴이 왼쪽에 서지만 그 오른쪽 얼굴이
 * **위로 겹쳐** 붉은 테를 여전히 잘라 먹는다(`-space-x-1` 의 기본 쌓임은 뒤가 위다).
 * 문서가 *"왼쪽이 위로"* 를 따로 적은 이유가 그것이고, 한 축만 재는 회귀선은 다른 축이
 * 지워지는 것을 못 잡는다.
 */
describe('팀 카드 — 겹침 순서가 고장난 것부터다', () => {
  /**
   * 다섯 팀원 · 다섯 얼굴. `handle` 을 **역 가나다**로 지어 이름순 정렬과 상태순 정렬이
   * 서로 다른 답을 내게 만든다 — 그러지 않으면 정렬을 지워도 초록이 될 수 있다.
   */
  const five = () => team('release', [
    member('ok1', 'a-fine'), // ok
    member('bad', 'b-broken'), // failed
    member('off', 'c-stopped'), // stopped
    member('ret', 'd-retiring'), // retiring
    member('unk', 'e-unknown'), // (connected 라 stopped 가 된다 — 아래 별도 시험이 unknown 을 만든다)
  ], 5);

  const states: Record<string, RunnerState> = {
    ok1: rs('ok1', 'running'),
    bad: rs('bad', 'failed'),
    off: rs('off', 'stopped'),
    ret: rs('ret', 'restarting'),
  };

  /**
   * 되돌려 RED: `TeamGrid` 의 `sortTeamFaces(...)` 를 `team.members` 로 바꾸면(정렬을
   * 지우면) 순서가 `a-fine · b-broken · …` 즉 이름순이 되어 이 단언이 빨개진다.
   * `RANK` 표에서 `failed: 0` 을 `4` 로 바꿔도 잡힌다.
   */
  it('실패 → 멈춤 → 물러남 → 도는 중 순으로 왼쪽에 선다', () => {
    grid({ teams: [five()], runnerStates: states, online: ['ok1'] });
    // 넷까지만 서고 다섯째는 `+1` 이다 — 그래서 **잘리는 것이 `ok` 여야 한다.**
    expect(facesOf('release').map((f) => f.face)).toEqual(['failed', 'stopped', 'stopped', 'retiring']);
    /*
      `e-unknown` 은 `connected: true` 라 `stopped` 이고, `c-stopped` 와 같은 등급이다.
      같은 등급 안에서는 **이름순**이므로 `c-stopped` 가 `e-unknown` 보다 왼쪽이다
      (`sortTeamFaces` 의 그 절: 격자의 가나다 고정이 두 번째 키로 남는다).
    */
    expect(facesOf('release').map((f) => f.handle))
      .toEqual(['b-broken', 'c-stopped', 'e-unknown', 'd-retiring']);
  });

  /**
   * **잘리는 것이 멀쩡한 얼굴이다** — 이것이 문서가 이 순서를 정한 이유 전부다
   * (*"다섯 중 하나가 죽은 팀이 멀쩡한 팀과 같아 보인다"*).
   */
  it('넷을 넘으면 멀쩡한 얼굴이 +N 으로 접힌다 — 고장난 것은 남는다', () => {
    grid({ teams: [five()], runnerStates: states, online: ['ok1'] });
    // 유일한 `ok`(`a-fine`)가 잘렸다.
    expect(screen.queryByTestId('team-face-release-a-fine')).toBeNull();
    expect(screen.getByTestId('team-overflow-release').textContent).toBe('+1');
    // 실패는 남았다 — 이름순이면 `a-fine` 이 첫 칸이고 `b-broken` 이 둘째라 둘 다 남지만,
    // 여섯째부터는 실패가 잘린다. 그 경우를 아래에서 잰다.
  });

  /** 여섯이면 이름순 정렬이 실제로 **실패를 잘라 낸다**. 그 결함을 직접 겨눈다. */
  it('여섯 중 하나가 죽어 있으면 그 얼굴이 남는다 — 이름순이면 잘렸다', () => {
    grid({
      teams: [team('big', [
        member('n1', 'a1'), member('n2', 'a2'), member('n3', 'a3'),
        member('n4', 'a4'), member('n5', 'a5'),
        // 이름이 마지막이고 **유일하게 죽은 것**. 이름순 겹침이면 `+2` 안으로 사라진다.
        member('bad', 'zz-broken'),
      ], 6)],
      runnerStates: { bad: rs('bad', 'failed') },
      online: ['n1', 'n2', 'n3', 'n4', 'n5'],
    });
    expect(screen.getByTestId('team-face-big-zz-broken')).toBeTruthy();
    expect(facesOf('big')[0]!.face).toBe('failed');
    expect(screen.getByTestId('team-overflow-big').textContent).toBe('+2');
  });

  /**
   * ## **왼쪽이 위로 겹친다** — 두 번째 축
   *
   * 되돌려 RED: `style={{ zIndex: TEAM_FACE_SLOTS - i }}` 를 지우면 `z` 가 전부 `NaN`
   * (빈 문자열)이 되어 단조 감소 단언이 빨개진다. `i` 로 바꿔도(오름차순) 잡힌다.
   *
   * 이 축이 없으면 `-space-x-1` 의 기본 쌓임(뒤가 위)이 실패 얼굴의 붉은 테를 그 오른쪽
   * 얼굴로 덮는다 — 정렬을 고쳐도 문서가 경고한 결함이 그대로 남는다.
   */
  it('왼쪽 얼굴이 위로 겹친다 — z 가 왼쪽부터 크다', () => {
    grid({ teams: [five()], runnerStates: states, online: ['ok1'] });
    const z = facesOf('release').map((f) => f.z);
    expect(z).toEqual([4, 3, 2, 1]);
    // 쌓임이 실제로 서려면 `relative` 가 함께 있어야 한다 — `static` 에서 `z-index` 는
    // 아무 일도 하지 않는다.
    expect(screen.getByTestId('team-face-release-b-broken').className).toContain('relative');
  });

  /**
   * **붉은 테가 얼굴에 있다.** 에이전트 카드는 그것을 상자로 올렸지만(그 파일의 감싸개
   * 주석) 팀 카드에서는 그 길이 막혀 있다 — 상자가 팀의 것이고 실패는 팀원 하나의 것이라,
   * 상자를 칠하면 다섯 중 하나가 죽은 것이 "이 팀이 죽었다"로 읽힌다.
   *
   * 되돌려 RED: 얼굴의 `ring-state-stuck` 을 지우거나 상자로 옮기면 빨개진다.
   */
  it('실패한 팀원만 붉은 테를 받고 팀 상자는 안 칠해진다', () => {
    grid({
      teams: [team('ops', [member('bad', 'broken'), member('ok1', 'fine')])],
      runnerStates: { bad: rs('bad', 'failed'), ok1: rs('ok1', 'running') },
      online: ['ok1'],
    });
    expect(screen.getByTestId('team-face-ops-broken').querySelector('.ring-state-stuck')).toBeTruthy();
    expect(screen.getByTestId('team-face-ops-fine').querySelector('.ring-state-stuck')).toBeNull();
    // **팀 상자는 멀쩡하다** — 하나가 죽은 것이 팀 전체의 고장으로 읽히지 않는다.
    expect(screen.getByTestId('team-box-ops').className).not.toContain('danger');
  });

  /** 상태 글자가 없다(문서: *"팀 카드는 상태 글자 없이도 … 를 말한다"*). 얼굴이 말한다. */
  it('상태 글자가 없다 — 얼굴이 말한다', () => {
    grid({
      teams: [team('ops', [member('bad', 'broken')])],
      runnerStates: { bad: rs('bad', 'failed', 'PAT 가 폐기되었다') },
    });
    const box = screen.getByTestId('team-box-ops');
    expect(box.textContent).not.toContain('실패');
    expect(box.textContent).not.toContain('멈춤');
    expect(box.textContent).not.toContain('PAT');
    // 얼굴에는 상태가 실려 있다 — 글자가 없는 것이 정보가 없는 것과 다르다.
    expect(screen.getByTestId('team-face-ops-broken').dataset.face).toBe('failed');
  });
});

/**
 * ## 비활성 팀원은 **예외 줄로** (문서 4단계)
 *
 * > *"카드 맨 아래, 실패 사유와 같은 자리에 한 줄. 지우면 왜 안 불렸는지를 알 수 없으므로
 * > 얼굴은 남긴다."*
 *
 * 두 가지를 함께 재는 것이 요점이다: 글자가 **생기고** 얼굴이 **남는다.** 하나만 재면
 * 비활성 팀원을 명단에서 걸러 내면서 글자만 남기는 구현이 통과한다.
 */
describe('팀 카드 — 비활성 팀원은 예외 줄이다', () => {
  const withOff = () => team('release', [
    member('ok1', 'fine'), member('off', 'sleepy', true),
  ], 2);

  /** 되돌려 RED: `off.length > 0 &&` 블록을 지우면 빨개진다. */
  it('비활성 팀원을 한 줄로 말하고 그 얼굴은 남긴다', () => {
    grid({ teams: [withOff()], runnerStates: { ok1: rs('ok1', 'running') }, online: ['ok1'] });

    const line = screen.getByTestId('team-disabled-release');
    expect(line.textContent).toContain('sleepy');
    // **왜 안 불렸는지**를 말한다 — 이름만 적으면 그것이 무슨 뜻인지 알 수 없다.
    expect(line.textContent).toContain('호출에서 빠진다');

    // 얼굴이 남는다(문서의 그 문장). 명단에서 지우는 구현이면 이 단언이 빨개진다.
    expect(screen.getByTestId('team-face-release-sleepy')).toBeTruthy();
    // 그리고 수에도 든다 — `memberCount` 가 비활성을 센다(`AgentTeamRow.memberCount`).
    expect(screen.getByTestId('team-box-release').textContent).toContain('팀 · 2명');
  });

  /** 강조색이 아니다(규칙 04) — 나를 막지 않고, 고장도 아니다(운영자가 의도한 상태다). */
  it('예외 줄이 강조색이 아니라 주의색이다', () => {
    grid({ teams: [withOff()] });
    const cls = screen.getByTestId('team-disabled-release').className;
    expect(cls).toContain('text-warning');
    expect(cls).not.toContain('text-accent');
    expect(cls).not.toContain('text-danger');
  });

  /** 비활성이 없으면 줄이 없다 — 정상에는 표시를 붙이지 않는다. */
  it('전원이 활성이면 그 줄이 없다', () => {
    grid({ teams: [team('ops', [member('ok1', 'fine')])] });
    expect(screen.queryByTestId('team-disabled-ops')).toBeNull();
  });

  /**
   * **명단을 못 받은 팀은 이 줄이 없다.** 없는 것을 없다고 하려면 명단을 알아야 한다 —
   * `undefined` 를 `[]` 로 삼키면 그 팀이 "비활성 없음"으로 단정된다.
   */
  it('명단을 못 받았으면 그 줄을 그리지 않는다', () => {
    grid({ teams: [team('ops', undefined, 5)] });
    expect(screen.queryByTestId('team-disabled-ops')).toBeNull();
  });
});

/**
 * ## 팀 얼굴은 **손잡이가 아니다** (문서 4단계)
 *
 * > *"44px 얼굴 다섯에 각각 손잡이를 달면 어느 것을 눌렀는지 알 수 없다. 팀 카드는 카드
 * > 전체가 상세로 가는 문이고, 팀원을 켜고 끄는 일은 에이전트 묶음에서 한다."*
 *
 * `AgentGrid` 의 `▶`·`■`·`↻` 가 이 격자로 **새지 않는 것**을 잠근다. 그 격자는 셋을
 * 얼굴 위에 겹쳐 얹으므로, 얼굴이 다섯인 카드에서 같은 일을 하면 손잡이가 다섯 겹이 된다.
 */
describe('팀 카드 — 얼굴에 손잡이가 없다', () => {
  /**
   * 되돌려 RED: `TeamFaces` 의 얼굴 `<span>` 을 `<button>` 으로 바꾸거나 `AgentGrid` 의
   * 글리프 블록을 옮겨 오면 빨개진다.
   */
  it('얼굴이 눌리는 것이 아니다 — 카드 전체가 문이다', () => {
    const onPick = vi.fn();
    grid({
      teams: [team('ops', [member('off', 'sleepy'), member('bad', 'broken')])],
      runnerStates: { bad: rs('bad', 'failed') },
      onPick,
    });

    // 얼굴 묶음 안에 `button` 이 하나도 없다.
    expect(screen.getByTestId('team-faces-ops').querySelectorAll('button').length).toBe(0);
    // `AgentGrid` 가 쓰는 손잡이의 testid 가 이 격자에 없다 — 이름을 그대로 재서
    // 그 격자의 블록을 복사해 오는 것을 잡는다.
    expect(screen.queryByTestId('agent-relaunch-sleepy')).toBeNull();
    expect(screen.queryByTestId('agent-stop-sleepy')).toBeNull();
    expect(screen.queryByTestId('team-relaunch-sleepy')).toBeNull();
    // ▶ · ■ · ↻ 글리프 자체가 없다.
    const box = screen.getByTestId('team-box-ops');
    expect(box.textContent).not.toContain('▶');
    expect(box.textContent).not.toContain('■');
    expect(box.textContent).not.toContain('↻');

    // 카드는 **하나의 문**이다 — 카드 안의 `button` 이 그것 하나다.
    expect(box.querySelectorAll('button').length).toBe(1);
    fireEvent.click(screen.getByTestId('team-card-ops'));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  /** 얼굴을 눌러도 **카드를 누른 것과 같다** — 얼굴이 카드 `button` 안에 있기 때문이다. */
  it('얼굴을 눌러도 상세가 열린다', () => {
    const onPick = vi.fn();
    grid({ teams: [team('ops', [member('a1', 'bot')])], onPick });
    fireEvent.click(screen.getByTestId('team-face-ops-bot'));
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});

/**
 * ## 카드가 말하는 것 — 이름 아래 **한 줄**
 *
 * 문서: *"이름 아래 한 줄 `팀 · N명`"* 그리고 *"팀원 이름을 글자로 나열하지 않는다 —
 * 얼굴이 이미 있고, 다섯을 적으면 카드가 목록이 된다."*
 */
describe('팀 카드 — 이름 아래 한 줄', () => {
  it('팀원 수는 memberCount 에서 온다 — 명단 길이가 아니다', () => {
    // 명단은 못 받았고 수만 안다. 카드는 그 수를 말할 수 있다.
    grid({ teams: [team('ops', undefined, 7)] });
    expect(screen.getByTestId('team-box-ops').textContent).toContain('팀 · 7명');
    // 얼굴 자리는 비어 있다 — 모르는 것을 그리지 않는다.
    expect(screen.getByTestId('team-faces-ops').dataset.members).toBe('unknown');
  });

  /**
   * 되돌려 RED: `팀 · {t.memberCount}명` 을 `{(t.members ?? []).length}` 로 바꾸면
   * 위 시험이 `팀 · 0명` 을 얻어 빨개진다. 여기서는 **두 값이 어긋난 경우**를 잰다 —
   * 비활성 팀원 때문에 실제로 어긋날 수 있고(`memberCount` 는 비활성도 센다), 그 어긋남을
   * 말하는 것이 예외 줄의 일이다.
   */
  it('명단을 받았어도 수는 memberCount 다', () => {
    grid({ teams: [team('ops', [member('a1', 'bot')], 4)] });
    expect(screen.getByTestId('team-box-ops').textContent).toContain('팀 · 4명');
  });

  /** **팀원 이름을 나열하지 않는다**(문서). 되돌려 RED: 얼굴 아래 이름줄을 더하면 빨개진다. */
  it('팀원 이름이 카드에 없다 — 다섯을 적으면 카드가 목록이 된다', () => {
    grid({
      teams: [team('release', [
        member('a1', 'bot'), member('a2', 'helper'), member('a3', 'forge'),
      ], 3)],
      online: ['a1', 'a2', 'a3'],
    });
    const box = screen.getByTestId('team-box-release');
    /*
      `Identity` 가 아바타 안에 `sr-only` 핸들을 낸다(그 컴포넌트) — 그것은 이 규칙의
      대상이 아니므로 얼굴 묶음을 뺀 나머지만 잰다. 그러지 않으면 `Identity` 를 고치는
      사람이 이 시험을 깨게 된다(`agentGrid.test.tsx` 의 이름줄 시험이 같은 판단을 한다).
    */
    const faces = screen.getByTestId('team-faces-release');
    const clone = box.cloneNode(true) as HTMLElement;
    clone.querySelector(`[data-testid="team-faces-release"]`)!.remove();
    expect(faces).toBeTruthy();
    expect(clone.textContent).toContain('@release');
    expect(clone.textContent).not.toContain('bot');
    expect(clone.textContent).not.toContain('helper');
    expect(clone.textContent).not.toContain('forge');
  });

  /** 이름에 `@` 가 붙는다 — 부를 수 있는 이름임을 카드마다 되짚는다(문서 「이름의 뜻」). */
  it('이름이 @ 를 달고 선다', () => {
    grid({ teams: [team('release', [member('a1', 'bot')])] });
    expect(screen.getByTestId('team-card-release').textContent).toContain('@release');
  });
});

/**
 * ## 틀이 에이전트 카드와 **같다** (문서: *"에이전트 카드와 같은 틀"*)
 *
 * 별개 컴포넌트로 둔 대가가 이것이다 — `AgentGrid` 의 `PLACE.settings` 표가 바뀌면 이
 * 파일도 따라 고쳐야 한다(`TeamGrid` 머리 주석이 그 대가를 적어 뒀다). **두 값을 함께
 * 재서** 어긋남을 잡는다: 소스에서 그 표의 값을 읽어 이 격자의 값과 맞춰 본다.
 *
 * 되돌려 RED: `TeamGrid` 의 `FRAME.grid` 를 다른 트랙 폭으로 바꾸면 빨개진다. `AgentGrid`
 * 쪽 표를 바꿔도 빨개지고 — 그것이 이 시험의 값이다: 한쪽만 고치면 두 격자가 어긋난다.
 */
describe('팀 카드 — 틀이 에이전트 카드와 같다', () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, '..', 'src', p), 'utf8');

  it('트랙 · 카드 폭 · 상자 · 격자 바닥이 PLACE.settings 와 같은 값이다', () => {
    const agentSrc = src('components/settings/AgentGrid.tsx');
    const teamSrc = src('components/settings/TeamGrid.tsx');

    // `PLACE.settings` 의 네 칸을 소스에서 뽑는다.
    const settings = agentSrc.slice(agentSrc.indexOf('  settings: {'), agentSrc.indexOf('  sidebar: {'));
    const pick = (key: string, from: string): string => {
      const m = new RegExp(`${key}: '([^']*)'`).exec(from);
      expect(m, `${key} 를 소스에서 못 찾았다`).toBeTruthy();
      return m![1]!;
    };

    // `grid`·`card`·`gridBg`·`createBox` 는 **문자열이 같아야** 한다.
    for (const key of ['grid', 'card', 'gridBg', 'createBox']) {
      expect(pick(key, teamSrc), `${key} 가 두 격자에서 갈렸다`).toBe(pick(key, settings));
    }

    /*
      `box` 는 **선 색만 갈린다.** 에이전트 카드는 그 칸에 색을 두지 않고 호출부가 붙이는데
      (실패한 카드가 그 칸만 갈아 끼운다), 팀 카드에는 실패 분기가 없으므로 `border-border`
      를 여기서 박는다. 나머지(면·모서리·여백)는 같아야 한다.
    */
    const teamBox = pick('box', teamSrc);
    for (const part of ['rounded-lg', 'bg-surface-raised', 'p-3']) {
      expect(pick('box', settings)).toContain(part);
      expect(teamBox).toContain(part);
    }
    expect(teamBox).toContain('border-border');
  });

  /**
   * **얼굴이 88px 자리의 절반이다.** 44px 이 문서의 값이고(*"44px 얼굴 넷까지"*), 그것이
   * 에이전트 카드의 얼굴(88px)의 정확히 절반인 것이 두 카드가 나란히 서는 근거다.
   */
  it('겹친 얼굴이 44px 이고 넷까지 선다', () => {
    grid({
      teams: [team('release', [
        member('a1', 'a'), member('a2', 'b'), member('a3', 'c'),
        member('a4', 'd'), member('a5', 'e'),
      ], 5)],
      online: ['a1', 'a2', 'a3', 'a4', 'a5'],
    });
    const faces = screen.getByTestId('team-faces-release');
    expect(faces.querySelectorAll('[data-face]').length).toBe(4);
    // `h-11` = 44px. 에이전트 카드의 `h-[88px]` 이 새면 카드가 트랙을 넘친다.
    expect(faces.querySelector('.h-11')).toBeTruthy();
    expect(faces.querySelector('.h-\\[88px\\]')).toBeNull();
    // 겹침과 링은 **선례의 그것**이다(`ThreadParticipants`·`MessageItem`) — `#471`.
    expect(faces.className).toContain('-space-x-1');
    expect(screen.getByTestId('team-face-release-a').className).toContain('rounded-full');
    expect(screen.getByTestId('team-face-release-a').className).toContain('ring-1');
  });

  /** 검색·`+`·빈 상태의 어휘도 같다 — 탭으로 갈린 형제이므로 여기서 갈리면 화면이 흔들린다. */
  it('검색과 + 카드가 에이전트 격자와 같은 자리에 선다', () => {
    grid({ teams: [] });
    expect(screen.getByTestId('team-search')).toBeTruthy();
    expect(screen.getByTestId('team-create')).toBeTruthy();
    expect(screen.getByTestId('team-grid').textContent).toContain('아직 팀이 없다');

    fireEvent.change(screen.getByTestId('team-search'), { target: { value: 'zzz' } });
    // 못 찾은 것과 아무것도 없는 것은 다른 사실이다.
    expect(screen.getByTestId('team-grid').textContent).toContain('맞는 팀이 없다');
  });

  /**
   * **목록을 못 받은 것과 팀이 없는 것은 다른 사실이다.**
   *
   * 이 시험이 재는 것은 실제로 겪은 화면이다: 팀 라우트는 있는데 `GET /accounts` 에
   * `teams` 가 없는 서버에 붙으면, 팀을 만들어도 격자가 비어 있고 같은 이름으로 다시
   * 만들면 서버가 `name_taken` 으로 거절한다. 그때 격자가 *"아직 팀이 없다"* 라고 하면
   * 화면이 모르는 것을 단언하는 것이고(`docs/design.md` §4), 사람은 서버가 아니라 자기
   * 조작을 의심한다.
   */
  it('목록을 못 받았으면 "아직 팀이 없다" 라고 하지 않는다', () => {
    grid({ teams: null });
    expect(screen.getByTestId('team-list-unavailable')).toBeTruthy();
    expect(screen.getByTestId('team-grid').textContent).not.toContain('아직 팀이 없다');
    // 만들기는 그 서버에서도 된다(`POST /teams`) — 손잡이를 없애면 반대 방향의 거짓이다.
    expect(screen.getByTestId('team-create')).toBeTruthy();
    // 훑을 목록이 없으면 검색줄도 없다 — 그 줄의 `N개` 는 모르는 수를 `0개` 로 단언한다.
    expect(screen.queryByTestId('team-search')).toBeNull();
  });

  it('만들 수 없는 사람에게는 + 가 없다', () => {
    grid({ canCreate: false });
    expect(screen.queryByTestId('team-create')).toBeNull();
  });
});
