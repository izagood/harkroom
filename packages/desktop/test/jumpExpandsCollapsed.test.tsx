/**
 * **강조 점프의 대상이 접힌 묶음 안에 있으면 펼친다**(2026-10-01, Saved 클릭 이동이 중간에 멈춤 — 원인 3).
 *
 * 접힌 주고받기·진행 묶음은 `MessageItem` 을 그리지 않는다 — 그 안의 말에 강조를 걸어도 그릴
 * DOM 이 없어 강조도 스크롤도 일어나지 않았다. 스레드 쪽 재현은 `savedThreadJumpRepro.test.tsx` ③.
 * 여기서는 묶음 하나만 그려서 펼침의 규칙(언제 펴고, 언제 접지 않는가)을 지킨다.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentExchange } from '../src/components/AgentExchange';
import { ProgressRow } from '../src/components/ProgressRow';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const exchange = (): MessageRow[] =>
  Array.from({ length: 4 }, (_, i) => msg(`x${i}`, 'c1', 10 + i, `주고받기 x${i}`, i % 2 ? CODEX : FORGE));
const progress = (): MessageRow[] =>
  Array.from({ length: 3 }, (_, i) => msg(`p${i}`, 'c1', 20 + i, `진행 p${i}`, FORGE, { kind: 'progress' }));

const highlight = (id: string | null) => act(() => { useAppStore.getState().set({ highlightedMessageId: id }); });
const exchangeOpen = () => screen.getByTestId('agent-exchange').dataset.open;

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  setController({} as unknown as Controller);
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [FORGE]: acc(FORGE, 'forge', 'agent'),
      [CODEX]: acc(CODEX, 'codex', 'agent'),
    },
  });
});

afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('접힌 주고받기 — 강조가 들어오면 펼친다', () => {
  it('안의 말에 강조가 걸리면 펼쳐져 그 말이 그려진다', () => {
    render(<AgentExchange messages={exchange()} />);
    expect(exchangeOpen()).toBe('false');
    highlight('x2');
    expect(exchangeOpen()).toBe('true');
    expect(screen.getByText('주고받기 x2')).toBeTruthy();
  });

  it('처음부터 강조된 채로 마운트되면(창 밖에서 들어온 줄) 첫 렌더부터 펼친다', () => {
    useAppStore.getState().set({ highlightedMessageId: 'x1' });
    render(<AgentExchange messages={exchange()} />);
    expect(exchangeOpen()).toBe('true');
  });

  it('밖의 말에 강조가 걸리면 접힌 채로 둔다', () => {
    render(<AgentExchange messages={exchange()} />);
    highlight('elsewhere');
    expect(exchangeOpen()).toBe('false');
  });

  it('강조가 풀려도 다시 접지 않고, 사람이 접으면 접힌다', () => {
    render(<AgentExchange messages={exchange()} />);
    highlight('x2');
    highlight(null);
    expect(exchangeOpen()).toBe('true');
    fireEvent.click(screen.getByTestId('agent-exchange-toggle'));
    expect(exchangeOpen()).toBe('false');
  });
});

describe('접힌 진행 묶음 — 강조가 들어오면 펼치고 그 줄을 보인다', () => {
  it('안의 진행 줄에 강조가 걸리면 펼쳐지고 그 줄에 강조가 선다', () => {
    render(<ProgressRow messages={progress()} />);
    expect(screen.queryByTestId('progress-detail')).toBeNull();
    highlight('p1');
    expect(screen.getByTestId('progress-detail')).toBeTruthy();
    const marked = document.querySelector<HTMLElement>('[data-highlighted="true"]');
    expect(marked?.textContent).toBe('진행 p1');
  });

  it('강조가 풀려도 다시 접지 않고, 사람이 접으면 접힌다', () => {
    render(<ProgressRow messages={progress()} />);
    highlight('p1');
    highlight(null);
    expect(screen.getByTestId('progress-detail')).toBeTruthy();
    expect(document.querySelector('[data-highlighted="true"]')).toBeNull();
    fireEvent.click(screen.getByTestId('progress-expand'));
    expect(screen.queryByTestId('progress-detail')).toBeNull();
  });
});
