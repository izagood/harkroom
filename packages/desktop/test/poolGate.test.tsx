// 계정 풀 ↔ 이 맥 배정(2026-10-15, 시안 pool_gate v2, jaebin E1~E4 전부 A). 판정 다섯 가지와 띠가 상태마다
// 할 일 하나만 내미는지, 잠긴 순서가 고칠 손잡이 없이 「쓰이지 않음」으로 보이는지 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { poolGateEditable, poolGateOf, type PoolGate } from '../src/lib/poolGate';
import { PoolGateBand } from '../src/components/settings/PoolGateBand';
import { AgentPoolChain } from '../src/components/settings/AgentPoolChain';
import { onLocalAgentsChanged, removeLocalAgent, setLocalAgent } from '../src/lib/operatorLocal';
import { usePrefsStore } from '../src/state/prefsStore';

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); usePrefsStore.getState().setLocale('system'); });

describe('poolGateOf', () => {
  const here = { operatorId: 'op-mac', present: true };

  it('① 배정이 이 맥이고 설정에도 있으면 이 맥에서 돈다', () => {
    expect(poolGateOf('op-mac', here)).toEqual({ kind: 'here' });
  });
  it('② 배정이 없으면 미배정 — 설정에 있어도 서버가 띄우라고 하지 않는다', () => {
    expect(poolGateOf(null, here)).toEqual({ kind: 'unassigned' });
    expect(poolGateOf(null, { operatorId: null, present: false })).toEqual({ kind: 'unassigned' });
  });
  it('③ 다른 오퍼레이터에 배정됐으면 그 머신이다 — 이 맥이 등록되지 않았어도 같다', () => {
    expect(poolGateOf('op-vm', here)).toEqual({ kind: 'elsewhere', operatorId: 'op-vm' });
    expect(poolGateOf('op-vm', { operatorId: null, present: false })).toEqual({ kind: 'elsewhere', operatorId: 'op-vm' });
  });
  it('④ 배정은 이 맥인데 설정에 없으면 반쪽 — 러너가 뜨지 않으니 「쓰는 중」이 아니다', () => {
    expect(poolGateOf('op-mac', { operatorId: 'op-mac', present: false })).toEqual({ kind: 'half' });
  });
  it('⑤ 설정을 못 읽었으면 모름 — 배정과 무관하게 잠그지 않는다', () => {
    for (const a of [null, 'op-mac', 'op-vm']) expect(poolGateOf(a, 'unknown')).toEqual({ kind: 'unknown' });
  });
  it('고칠 수 있는 것은 ①·⑤ 뿐이다', () => {
    const all: PoolGate[] = [{ kind: 'here' }, { kind: 'unassigned' }, { kind: 'elsewhere', operatorId: 'x' }, { kind: 'half' }, { kind: 'unknown' }];
    expect(all.filter(poolGateEditable).map((g) => g.kind)).toEqual(['here', 'unknown']);
  });
});

describe('PoolGateBand', () => {
  function band(gate: PoolGate, over: Partial<Parameters<typeof PoolGateBand>[0]> = {}) {
    const props = {
      gate, operatorName: 'homelab-vm', recent: null, hasChain: true, busy: false, canAct: true, canRunHere: true,
      onRunHere: vi.fn(), onEnableHere: vi.fn(), onGoToAssignment: vi.fn(), onClear: vi.fn(), ...over,
    };
    render(<PoolGateBand {...props} />);
    return props;
  }
  const buttons = () => screen.queryAllByRole('button').map((b) => b.dataset.testid);

  it('① 이 맥에서 돌면 띠가 없다', () => {
    band({ kind: 'here' });
    expect(screen.queryByTestId('agent-pool-gate')).toBeNull();
  });

  it('⑤ 모르면 회색 한 줄만 — 버튼도 잠금도 없다', () => {
    band({ kind: 'unknown' });
    const el = screen.getByTestId('agent-pool-gate');
    expect(el.dataset.gate).toBe('unknown');
    expect(el.textContent).toBe('이 맥에서 도는지 확인하지 못했다.');
    expect(buttons()).toEqual([]);
  });

  it('② 미배정 — [이 맥에서 돌리기] 와 [이 순서 지우기], 순서는 남긴다고 말한다', () => {
    const p = band({ kind: 'unassigned' });
    expect(screen.getByTestId('agent-pool-gate').textContent).toMatch(/어디에도 배정되지 않아/);
    expect(screen.getByTestId('agent-pool-gate').textContent).toMatch(/이 순서가 그대로 쓰인다/);
    expect(buttons()).toEqual(['agent-pool-gate-run-here', 'agent-pool-gate-clear']);
    fireEvent.click(screen.getByTestId('agent-pool-gate-run-here'));
    expect(p.onRunHere).toHaveBeenCalledTimes(1);
  });

  it('② 이 맥 오퍼레이터가 등록되지 않았으면 [이 맥에서 돌리기] 를 그리지 않는다 — 배정할 곳이 없다', () => {
    band({ kind: 'unassigned' }, { canRunHere: false });
    expect(buttons()).toEqual(['agent-pool-gate-clear']);
  });

  it('③ 다른 머신 — 옮기지 않고 「어디서 돌리나」로 데려가기만 한다(E2 A)', () => {
    const p = band({ kind: 'elsewhere', operatorId: 'op-vm' });
    expect(screen.getByTestId('agent-pool-gate').textContent).toMatch(/^homelab-vm 에서 돈다 — 계정 풀은 그 머신에서 정한다/);
    expect(buttons()).toEqual(['agent-pool-gate-goto', 'agent-pool-gate-clear']);
    fireEvent.click(screen.getByTestId('agent-pool-gate-goto'));
    expect(p.onGoToAssignment).toHaveBeenCalledTimes(1);
    // 최근 턴 값이 없으면 그 줄을 생략한다(E4 A).
    expect(screen.queryByTestId('agent-pool-gate-recent')).toBeNull();
  });

  it('③ 그 머신의 최근 턴이 실어 온 풀이 있으면 한 줄 더 — 순위가 없으면 순위를 빼고 말한다', () => {
    band({ kind: 'elsewhere', operatorId: 'op-vm' }, { recent: { pool: 'work', account: 'lychee', rank: 1 } });
    expect(screen.getByTestId('agent-pool-gate-recent').textContent).toBe('그 머신에서 최근 턴: work › lychee (1번 풀)');
    cleanup();
    band({ kind: 'elsewhere', operatorId: 'op-vm' }, { recent: { pool: 'work', account: 'lychee', rank: null } });
    expect(screen.getByTestId('agent-pool-gate-recent').textContent).toBe('그 머신에서 최근 턴: work › lychee');
  });

  it('④ 반쪽 — [이 맥 오퍼레이터에서 켜기] 체크 하나만', () => {
    const p = band({ kind: 'half' });
    expect(screen.getByTestId('agent-pool-gate').textContent).toMatch(/오퍼레이터에 켜져 있지 않다/);
    expect(buttons()).toEqual(['agent-pool-gate-enable', 'agent-pool-gate-clear']);
    fireEvent.click(screen.getByTestId('agent-pool-gate-enable'));
    expect(p.onEnableHere).toHaveBeenCalledTimes(1);
  });

  it('저장된 순서가 없으면 「남겨 둔다」와 [지우기] 가 없다', () => {
    band({ kind: 'unassigned' }, { hasChain: false });
    expect(screen.getByTestId('agent-pool-gate').textContent).not.toMatch(/남겨 둔다/);
    expect(buttons()).toEqual(['agent-pool-gate-run-here']);
  });

  it('배정을 바꿀 수 없는 사람에게는 이유만 — 지우기는 이 기기 설정이라 남는다', () => {
    band({ kind: 'elsewhere', operatorId: 'op-vm' }, { canAct: false });
    expect(buttons()).toEqual(['agent-pool-gate-clear']);
  });

  it('[이 순서 지우기] 는 onClear 를 부른다', () => {
    const p = band({ kind: 'unassigned' });
    fireEvent.click(screen.getByTestId('agent-pool-gate-clear'));
    expect(p.onClear).toHaveBeenCalledTimes(1);
  });
});

describe('AgentPoolChain — 잠긴 순서(E1 A)', () => {
  it('흐리게 보이기만 한다 — ↑↓✕·끌기·추가·상태 줄이 없고 칩은 「쓰이지 않음」', () => {
    const onChange = vi.fn();
    render(<AgentPoolChain chain={['work', 'personal']} pools={['work', 'personal', 'spare']} defaultPool="work"
      state={null} ready onChange={onChange} locked />);
    for (const pool of ['work', 'personal']) {
      expect(screen.getByTestId(`agent-pool-chain-row-${pool}`).className).toMatch(/opacity-60/);
      expect(screen.getByTestId(`agent-pool-chain-chip-${pool}`).textContent).toBe('쓰이지 않음');
      expect(screen.queryByTestId(`agent-pool-chain-handle-${pool}`)).toBeNull();
    }
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByLabelText('＋ 풀 추가')).toBeNull();
    expect(screen.queryByTestId('agent-pool-chain-status')).toBeNull();
    expect(screen.queryByTestId('agent-pool-chain-add-none')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('onLocalAgentsChanged', () => {
  it('넣기·빼기가 끝난 뒤 알린다 — 「이 머신」 체크와 풀 칸이 서로 따라오는 근거', async () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal('__TAURI_INTERNALS__', { transformCallback: () => 1, invoke });
    const cb = vi.fn();
    const off = onLocalAgentsChanged(cb);
    await setLocalAgent('https://x', 'a1', {});
    expect(cb).toHaveBeenCalledTimes(1);
    await removeLocalAgent('https://x', 'a1');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    await setLocalAgent('https://x', 'a1', {});
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('쓰기가 실패하면 알리지 않는다', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', { transformCallback: () => 1, invoke: vi.fn(async () => { throw new Error('daemon down'); }) });
    const cb = vi.fn();
    const off = onLocalAgentsChanged(cb);
    await expect(setLocalAgent('https://x', 'a1', {})).rejects.toThrow('daemon down');
    expect(cb).not.toHaveBeenCalled();
    off();
  });
});
