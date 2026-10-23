// 계정 풀 ↔ 이 맥 배정(2026-10-15, 시안 pool_gate v2, alice E1~E4 전부 A). 판정 다섯 가지와 띠가 상태마다
// 할 일 하나만 내미는지, 잠긴 순서가 고칠 손잡이 없이 「쓰이지 않음」으로 보이는지 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { poolGateEditable, poolGateOf, type PoolGate } from '../src/lib/poolGate';
import { PoolGateBand, PoolGateKept } from '../src/components/settings/PoolGateBand';
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
      gate, operatorName: 'homelab-vm', recent: null, busy: false, canAct: true, canRunHere: true,
      onRunHere: vi.fn(), onEnableHere: vi.fn(), onGoToAssignment: vi.fn(), ...over,
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

  it('② 미배정 — 노란 띠에 할 일 하나, [이 맥에서 돌리기] 는 주 버튼(designer s1). 지우기는 띠 밖(s2)', () => {
    const p = band({ kind: 'unassigned' });
    const el = screen.getByTestId('agent-pool-gate');
    expect(el.textContent).toMatch(/어디에도 배정되지 않아/);
    expect(el.className).toMatch(/bg-warning-surface/);
    expect(buttons()).toEqual(['agent-pool-gate-run-here']);
    expect(screen.getByTestId('agent-pool-gate-run-here').className).toMatch(/bg-accent/);
    fireEvent.click(screen.getByTestId('agent-pool-gate-run-here'));
    expect(p.onRunHere).toHaveBeenCalledTimes(1);
  });

  it('② 이 맥 오퍼레이터가 등록되지 않았으면 [이 맥에서 돌리기] 를 그리지 않는다 — 배정할 곳이 없다', () => {
    band({ kind: 'unassigned' }, { canRunHere: false });
    expect(buttons()).toEqual([]);
  });

  it('③ 다른 머신 — 옮기지 않고 「어디서 돌리나」로 데려가기만 한다(E2 A)', () => {
    const p = band({ kind: 'elsewhere', operatorId: 'op-vm' });
    expect(screen.getByTestId('agent-pool-gate').textContent).toMatch(/^homelab-vm 에서 돈다 — 계정 풀은 그 머신에서 정한다/);
    // 고칠 상태가 아니라 사실이다 — 중립 띠, 보조 버튼(designer s3).
    expect(screen.getByTestId('agent-pool-gate').className).not.toMatch(/bg-warning-surface/);
    expect(screen.getByTestId('agent-pool-gate').className).toMatch(/bg-surface-raised/);
    expect(buttons()).toEqual(['agent-pool-gate-goto']);
    expect(screen.getByTestId('agent-pool-gate-goto').className).not.toMatch(/bg-accent/);
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
    expect(buttons()).toEqual(['agent-pool-gate-enable']);
    expect(screen.getByTestId('agent-pool-gate-enable').className).toMatch(/bg-accent/);
    fireEvent.click(screen.getByTestId('agent-pool-gate-enable'));
    expect(p.onEnableHere).toHaveBeenCalledTimes(1);
  });

  it('배정을 바꿀 수 없는 사람에게는 이유만', () => {
    band({ kind: 'elsewhere', operatorId: 'op-vm' }, { canAct: false });
    expect(buttons()).toEqual([]);
  });
});

describe('PoolGateKept — 잠긴 목록 아래 한 줄(designer s2)', () => {
  it('순서를 남긴다고 말하고, 조용한 [이 순서 지우기] 가 onClear 를 부른다', () => {
    const onClear = vi.fn();
    render(<PoolGateKept busy={false} onClear={onClear} />);
    expect(screen.getByTestId('agent-pool-gate-kept').textContent).toMatch(/이 순서가 그대로 쓰인다/);
    const clear = screen.getByTestId('agent-pool-gate-clear');
    expect(clear.className).toMatch(/underline/);
    expect(clear.className).not.toMatch(/bg-accent/);
    fireEvent.click(clear);
    expect(onClear).toHaveBeenCalledTimes(1);
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
