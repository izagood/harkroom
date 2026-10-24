// 실행 탭 「모델 연결」(API 키 연결, designer v3 ②·입력 상태). 저장은 사람의 클릭에서만, 끄기는 칸을 지운다(security n2).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { usePrefsStore } from '../src/state/prefsStore';
import { laneModelRaw, ModelConnectionField, ModelConnectionStatus, urlProblem } from '../src/components/settings/ModelConnectionField';
import { laneCodeKey, laneCodeName } from '../src/lib/laneCodes';
import type { LaneSecretOption, ProviderLaneState } from '../src/lib/useProviderLane';

const secret = (name: string, over: Partial<LaneSecretOption> = {}): LaneSecretOption => ({
  id: `s-${name}`, name, expiresAt: null, granted: true, suspended: false, channelLimited: false, unreadable: false, ...over,
});

function laneState(over: Partial<ProviderLaneState> = {}): ProviderLaneState {
  return {
    available: true, present: true, lane: null, status: null, pending: false, pendingSince: null, secrets: [secret('llm-api-key')], secretsError: null, error: null,
    reload: vi.fn(), save: vi.fn(async () => {}), ...over,
  };
}

function renderField(lane: ProviderLaneState, harness = 'claude-code', onSaved = vi.fn()) {
  render(
    <ModelConnectionField harness={harness} lane={lane} pool={<div data-testid="pool-slot">pool</div>}
      stdioServers={[]} label="" onSaved={onSaved} />,
  );
  return { onSaved };
}

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); });

describe('주소 검사·모델 이름', () => {
  it('https 만, 루프백 http 하나만 예외 — 까닭을 가른다', () => {
    expect(urlProblem('https://gateway.example/anthropic')).toBeNull();
    expect(urlProblem('http://127.0.0.1:8080')).toBeNull();
    expect(urlProblem('http://gateway.example')).toBe('badScheme');
    expect(urlProblem('https://gateway.example/?key=1')).toBe('badParts');
    expect(urlProblem('https://u:p@gateway.example')).toBe('badParts');
    expect(urlProblem('')).toBeNull();
  });

  // 2026-10-24 jaebin: 모델 칸에는 gateway 가 받는 이름 그대로 — opencode 머리는 러너가 안에서 붙인다. 남은 옛 값만 원문으로 되돌린다.
  it('laneModelRaw: 옛 harkroom-lane/ 머리만 떼고, 원문·빈 값은 고치지 않는다', () => {
    expect(laneModelRaw('harkroom-lane/ExampleOrg/example-model')).toBe('ExampleOrg/example-model');
    expect(laneModelRaw('ExampleOrg/example-model')).toBeNull();
    expect(laneModelRaw('harkroom-lane/')).toBeNull();
    expect(laneModelRaw(null)).toBeNull();
  });
});

describe('ModelConnectionField', () => {
  it('[계정 풀]이면 지금 풀 칸을 그대로 그리고, 전환만으로는 아무것도 쓰지 않는다', () => {
    const lane = laneState();
    renderField(lane);
    expect(screen.getByTestId('pool-slot')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.queryByTestId('pool-slot')).toBeNull();
    expect(screen.getByTestId('lane-form')).toBeTruthy();
    expect(lane.save).not.toHaveBeenCalled();
  });

  it('주소와 허락된 비밀을 고르면 저장된다 — 값이 아니라 주소·이름만 넘긴다', async () => {
    const lane = laneState();
    const { onSaved } = renderField(lane);
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    const save = screen.getByTestId('lane-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('lane-url'), { target: { value: 'https://gateway.example/anthropic/' } });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /llm-api-key/ }));
    // 고른 줄은 hover 면이 아니라 점(●)과 테두리로 가린다(designer s1).
    const picked = screen.getByRole('radio', { name: /llm-api-key/ });
    expect(picked.getAttribute('aria-checked')).toBe('true');
    expect(picked.querySelector('[data-testid="lane-secret-dot"]')!.textContent).toBe('●');
    expect(picked.className).toContain('ring-1');
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(lane.save).toHaveBeenCalledWith({ baseUrl: 'https://gateway.example/anthropic', secretName: 'llm-api-key' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // 🔒 「이 맥의 데스크톱에서만」·stdio 경고가 같이 선다.
    expect(screen.getByTestId('lane-desktop-only').textContent).toContain('이 맥의 데스크톱에서만');
  });

  it('잘못된 주소는 까닭을 말하고 저장을 막는다', () => {
    renderField(laneState());
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    fireEvent.change(screen.getByTestId('lane-url'), { target: { value: 'http://gateway.example' } });
    fireEvent.click(screen.getByRole('radio', { name: /llm-api-key/ }));
    expect(screen.getByText(/https 주소만 받는다/)).toBeTruthy();
    expect((screen.getByTestId('lane-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('[계정 풀]로 바꾸면 지운다는 확인을 띄우고, [지우고 저장]은 lane:null 을 보낸다', async () => {
    const lane = laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'llm-api-key' } });
    renderField(lane);
    fireEvent.click(screen.getByRole('radio', { name: '계정 풀' }));
    expect(screen.getByTestId('lane-off-confirm').textContent).toContain('지운다');
    expect(lane.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '지우고 저장' }));
    await waitFor(() => expect(lane.save).toHaveBeenCalledWith(null));
  });

  it('허락된 비밀이 없으면 빈 상태와 허락하기 길, 목록을 못 읽으면 빈 목록이 아니라 「못 읽었다」', () => {
    renderField(laneState({ secrets: [] }));
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByTestId('lane-no-secrets').textContent).toContain('허락된 비밀이 없다');
    cleanup();
    renderField(laneState({ secrets: [], secretsError: 'boom' }));
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByTestId('lane-secrets-error').textContent).toContain('못 읽었다');
    expect(screen.queryByTestId('lane-no-secrets')).toBeNull();
  });

  it('정지·읽지 못한 비밀은 고를 수 없다', () => {
    renderField(laneState({ secrets: [secret('a-key', { granted: false, suspended: true }), secret('b-key', { granted: false, unreadable: true })] }));
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect((screen.getByRole('radio', { name: /a-key/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: /b-key/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('API 키를 못 쓰는 하네스는 [API 키]로 못 바꾸고 까닭을 적는다', () => {
    renderField(laneState(), 'pi');
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.queryByTestId('lane-form')).toBeNull();
    expect(screen.getByText(/claude-code·opencode·codex·omp에서만/)).toBeTruthy();
  });

  // designer #1540 c1·②: omp 는 계정 풀이 없다 — 처음부터 [API 키]로 열고, 주소 칸은 OpenAI chat-completions 이름이다.
  it('omp 는 저장된 연결이 없어도 처음부터 [API 키]로 열고 주소 칸 이름이 omp 것이다', () => {
    renderField(laneState(), 'omp');
    expect(screen.getByTestId('lane-form')).toBeTruthy();
    expect(screen.getByText('API 주소 (OpenAI chat-completions 호환 base URL)')).toBeTruthy();
    expect(screen.queryByText('API 주소 (Anthropic 호환 base URL)')).toBeNull();
  });

  it('omp 에서 [계정 풀]을 누르면 빈자리 대신 「계정 풀이 없다」 한 줄이 서고 풀 칸은 안 그린다', () => {
    renderField(laneState(), 'omp');
    fireEvent.click(screen.getByRole('radio', { name: '계정 풀' }));
    expect(screen.getByTestId('lane-only-pool').textContent).toBe('omp는 계정 풀이 없다 — [API 키]로 연결한다.');
    expect(screen.queryByTestId('pool-slot')).toBeNull();
    expect(screen.queryByTestId('lane-form')).toBeNull();
  });

  // designer #1541 s1: omp 는 풀이 없다 — 끄기 확인이 「계정 풀로 돈다」고 하면 사실과 반대다.
  it('omp 에 저장된 연결이 있을 때 [계정 풀]을 누르면 「턴마다 멈춘다」 확인 문장이 선다', () => {
    renderField(laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'llm-api-key' } }), 'omp');
    fireEvent.click(screen.getByRole('radio', { name: '계정 풀' }));
    expect(screen.getByTestId('lane-off-confirm').textContent).toContain('omp는 계정 풀이 없어서 다시 연결하기 전까지 턴마다 멈춘다');
    expect(screen.getByTestId('lane-off-confirm').textContent).not.toContain('계정 풀로 돈다');
  });

  it('풀이 있는 하네스의 끄기 확인은 그대로 「계정 풀로 돈다」', () => {
    renderField(laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'llm-api-key' } }), 'claude-code');
    fireEvent.click(screen.getByRole('radio', { name: '계정 풀' }));
    expect(screen.getByTestId('lane-off-confirm').textContent).toContain('계정 풀로 돈다');
  });

  it('다른 하네스는 주소 칸 이름이 그대로다(codex 는 후속 n4 몫)', () => {
    renderField(laneState(), 'codex');
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByText('API 주소 (Anthropic 호환 base URL)')).toBeTruthy();
  });

  it('영어에서는 하네스 목록을 쉼표로 잇는다', () => {
    usePrefsStore.getState().setLocale('en');
    renderField(laneState(), 'pi');
    expect(screen.getByText('Available for claude-code, opencode, codex, and omp only.')).toBeTruthy();
  });

  it('마지막 시도 줄의 판 문장은 그 하네스 판만 싣는다(designer n1)', () => {
    render(<ModelConnectionStatus harness="codex" now={Date.parse('2026-10-24T10:00:00Z')}
      lane={laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'llm-api-key' }, status: { at: '2026-10-24T09:59:00Z', ok: false, code: 'harness_version' } })} />);
    const line = screen.getByTestId('lane-status-fail').textContent ?? '';
    expect(line).toContain('codex 0.154.0');
    expect(line).not.toContain('opencode');
  });

  // designer n4 A: 주소 칸 이름이 하네스가 gateway 를 부르는 꼴을 말한다.
  it('주소 칸 이름 — codex 는 OpenAI Responses, claude-code·opencode 는 Anthropic', () => {
    for (const [harness, label] of [['codex', /OpenAI Responses 호환/], ['claude-code', /Anthropic 호환/], ['opencode', /Anthropic 호환/]] as const) {
      renderField(laneState(), harness);
      fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
      expect(screen.getByText(label)).toBeTruthy();
      cleanup();
    }
  });

  it('codex 도 [API 키]로 바꿀 수 있다', () => {
    renderField(laneState(), 'codex');
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByTestId('lane-form')).toBeTruthy();
  });
});

describe('laneCodes', () => {
  it('허용 목록 밖은 unknown 으로 접는다 — 주소 같은 값을 비추지 않는다', () => {
    expect(laneCodeKey('not_granted')).toBe('lane.code.not_granted');
    expect(laneCodeKey('forbidden')).toBe('lane.code.not_granted');
    expect(laneCodeKey('interactive_unsupported')).toBe('lane.code.interactive_unsupported');
    expect(laneCodeKey('https://gateway.example')).toBe('lane.code.unknown');
    expect(laneCodeName('https://gateway.example')).toBe('unknown');
  });
});

// C1: 켜기·끄기는 러너가 다시 떠야 든다. 그 사이는 「적용 대기」로 보인다.
describe('적용 시점(C1)', () => {
  it('켤 때는 「러너가 다시 뜬다」, 이미 켠 연결을 고칠 때는 「다음 턴부터」', () => {
    renderField(laneState());
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByText(/러너가 다시 뜬다/)).toBeTruthy();
    expect(screen.queryByText(/재기동 필요 없음/)).toBeNull();
    cleanup();
    renderField(laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'llm-api-key' } }));
    expect(screen.getByText(/다음 턴부터 적용된다/)).toBeTruthy();
  });

  it('러너 모드가 설정과 다르면 상태 칸에 「적용 대기」 — 끈 직후(설정 없음)에도 보인다', () => {
    render(<ModelConnectionStatus lane={laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'k' }, pending: true })} />);
    expect(screen.getByTestId('lane-pending').textContent).toContain('적용 대기');
    cleanup();
    render(<ModelConnectionStatus lane={laneState({ lane: null, pending: true })} />);
    // 끈 직후(designer s2): 방향을 밝히고, 지운 연결을 설명하는 줄은 숨긴다.
    expect(screen.getByTestId('lane-pending').textContent).toContain('계정 풀로 돈다');
    expect(screen.queryByText(/계정 풀을 쓰지 않는다/)).toBeNull();
    expect(screen.queryByText(/API 키를 쓴 턴이 아직 없다/)).toBeNull();
    cleanup();
    render(<ModelConnectionStatus lane={laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'k' }, pending: false })} />);
    expect(screen.queryByTestId('lane-pending')).toBeNull();
  });
});

// API 키 연결 후속(designer 실물 3차 n11·n14·n15·n16·n18).
describe('상태 칸·stdio 줄(후속)', () => {
  const on = { baseUrl: 'https://gateway.example', secretName: 'k' };
  it('키는 받았는데 그 턴이 API 오류면 초록이 아니라 회색 줄(n16)', () => {
    render(<ModelConnectionStatus lane={laneState({ lane: on, status: { at: '2026-10-23T00:00:00Z', ok: true, apiFailed: true } })} />);
    expect(screen.getByTestId('lane-status-apifail').textContent).toContain('API 오류로 실패');
    expect(screen.queryByTestId('lane-status-ok')).toBeNull();
  });
  it('대기 상자와 마지막 턴 줄은 한 자리를 번갈아 쓴다(n18)', () => {
    render(<ModelConnectionStatus lane={laneState({ lane: on, pending: true, pendingSince: 0, status: { at: '2026-10-23T00:00:00Z', ok: true } })} now={1000} />);
    expect(screen.getByTestId('lane-pending')).toBeTruthy();
    expect(screen.queryByTestId('lane-status-ok')).toBeNull();
  });
  it('대기가 3분을 넘으면 「다시 뜨지 않았다」와 [재시작](n14)', () => {
    const onRestart = vi.fn();
    render(<ModelConnectionStatus lane={laneState({ lane: on, pending: true, pendingSince: 0 })} now={3 * 60_000} onRestart={onRestart} />);
    expect(screen.getByTestId('lane-pending').textContent).toContain('다시 뜨지 않았다');
    fireEvent.click(screen.getByTestId('lane-pending-restart'));
    expect(onRestart).toHaveBeenCalled();
    cleanup();
    render(<ModelConnectionStatus lane={laneState({ lane: on, pending: true, pendingSince: 0 })} now={60_000} onRestart={onRestart} />);
    expect(screen.queryByTestId('lane-pending-restart')).toBeNull();
  });
  it('끈 직후 제목은 「적용 상태」(n15)', () => {
    render(<ModelConnectionStatus lane={laneState({ lane: null, pending: true, pendingSince: 0 })} now={0} />);
    expect(screen.getByText('적용 상태')).toBeTruthy();
  });
  it('붙은 stdio 서버가 없으면 회색 한 줄, 있으면 노란 상자와 [권한 탭에서 떼기](n11·n3)', () => {
    renderField(laneState());
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByTestId('lane-stdio-hint')).toBeTruthy();
    expect(screen.queryByTestId('lane-stdio-warn')).toBeNull();
    cleanup();
    const onOpenPermissions = vi.fn();
    render(<ModelConnectionField harness="claude-code" lane={laneState()} pool={<div />} stdioServers={['local-files']} label="" onOpenPermissions={onOpenPermissions} />);
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.getByTestId('lane-stdio-warn').textContent).toContain('local-files');
    fireEvent.click(screen.getByRole('button', { name: '권한 탭에서 떼기' }));
    expect(onOpenPermissions).toHaveBeenCalled();
  });
});

// designer n20: 다시 읽기가 렌더를 안 일으켜도 3분이 되면 [재시작]이 뜬다(스스로 시계를 건다).
describe('대기 3분 시계(n20)', () => {
  it('다른 렌더 없이 시간만 흘러도 3분 뒤 [재시작]이 보인다', () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-23T00:00:00Z') });
    try {
      const lane = laneState({ lane: { baseUrl: 'https://gateway.example', secretName: 'k' }, pending: true, pendingSince: Date.now() });
      render(<ModelConnectionStatus lane={lane} onRestart={() => {}} />);
      expect(screen.queryByTestId('lane-pending-restart')).toBeNull();
      act(() => { vi.advanceTimersByTime(3 * 60_000 + 100); });
      expect(screen.getByTestId('lane-pending-restart')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
