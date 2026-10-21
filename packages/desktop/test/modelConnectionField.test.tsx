// 실행 탭 「모델 연결」(API 키 연결, designer v3 ②·입력 상태). 저장은 사람의 클릭에서만, 끄기는 칸을 지운다(security n2).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { usePrefsStore } from '../src/state/prefsStore';
import { ModelConnectionField, opencodeLaneModel, urlProblem } from '../src/components/settings/ModelConnectionField';
import { laneCodeKey, laneCodeName } from '../src/lib/laneCodes';
import type { LaneSecretOption, ProviderLaneState } from '../src/lib/useProviderLane';

const secret = (name: string, over: Partial<LaneSecretOption> = {}): LaneSecretOption => ({
  id: `s-${name}`, name, expiresAt: null, granted: true, suspended: false, channelLimited: false, unreadable: false, ...over,
});

function laneState(over: Partial<ProviderLaneState> = {}): ProviderLaneState {
  return {
    available: true, present: true, lane: null, status: null, secrets: [secret('llm-api-key')], secretsError: null, error: null,
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

  it('opencode 모델 칸은 harkroom-lane/<id> 로 — 이미 그 모양이거나 비었으면 안 고친다', () => {
    expect(opencodeLaneModel('example-model')).toBe('harkroom-lane/example-model');
    expect(opencodeLaneModel('anthropic/example-model')).toBe('harkroom-lane/example-model');
    expect(opencodeLaneModel('harkroom-lane/example-model')).toBeNull();
    expect(opencodeLaneModel(null)).toBeNull();
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
    renderField(laneState(), 'codex');
    fireEvent.click(screen.getByRole('radio', { name: 'API 키' }));
    expect(screen.queryByTestId('lane-form')).toBeNull();
    expect(screen.getByText(/claude-code·opencode에서만/)).toBeTruthy();
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
