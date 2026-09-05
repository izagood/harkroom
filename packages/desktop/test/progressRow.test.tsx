// Task 4 — 진행(progress)을 상태 한 줄로 접는다(#144, 규칙 02).
//
// `kind='progress'` 는 이미 서버에 있고 러너가 `message.progress` 로 보내는데, 데스크탑이
// 특별히 그리지 않아 **일반 발화로 흘렀다** — 규칙 02("로그가 아니라 사람의 말")가 새고 있던
// 자리다. 이 파일은 그 구멍이 다시 열리지 않게 잠근다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { ProgressRow } from '../src/components/ProgressRow';
import { groupProgress, elapsedLabel } from '../src/lib/progressGroup';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const FORGE = 'a-forge';
const CODEX = 'a-codex';

const prog = (id: string, body: string, authorId = FORGE, createdAt?: string): MessageRow =>
  msg(id, 'c1', 1, body, authorId, { kind: 'progress', ...(createdAt ? { createdAt } : {}) });

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc(ME, 'jaebin'),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      // 소유자가 나인 에이전트 — 터미널 링크가 뜬다.
      [FORGE]: acc(FORGE, 'forge', 'agent', false, { ownerAccountId: ME }),
      // 소유자가 남인 에이전트 — 링크가 **없어야** 한다.
      [CODEX]: acc(CODEX, 'codex', 'agent', false, { ownerAccountId: 'someone-else' }),
    },
  });
});
afterEach(() => cleanup());

describe('groupProgress — 무엇이 한 묶음인가', () => {
  it('같은 저자의 연속 progress 를 하나로 접는다', () => {
    const slots = groupProgress([prog('p1', 'a'), prog('p2', 'b'), prog('p3', 'c')]);
    expect(slots).toHaveLength(1);
    expect(slots[0]!.kind).toBe('progress');
    expect(slots[0]!.kind === 'progress' && slots[0]!.messages).toHaveLength(3);
  });

  it('사이에 사람의 발화가 끼면 묶음이 갈린다', () => {
    const slots = groupProgress([
      prog('p1', 'a'), prog('p2', 'b'),
      msg('u1', 'c1', 3, '잠깐, 그거 말고', ME),
      prog('p3', 'c'),
    ]);
    // 진행 · 발화 · 진행 — 세 자리다. 발화 앞뒤는 다른 구간이다.
    expect(slots.map((s) => s.kind)).toEqual(['progress', 'message', 'progress']);
    expect(slots[0]!.kind === 'progress' && slots[0]!.messages).toHaveLength(2);
    expect(slots[2]!.kind === 'progress' && slots[2]!.messages).toHaveLength(1);
  });

  it('저자가 바뀌면 묶음이 갈린다 — 누가 무엇을 하는지가 사라지면 안 된다', () => {
    const slots = groupProgress([prog('p1', 'a', FORGE), prog('p2', 'b', CODEX)]);
    expect(slots).toHaveLength(2);
  });

  it('progress 가 없으면 원래 목록 그대로다', () => {
    const slots = groupProgress([msg('u1', 'c1', 1, '안녕', ME), msg('u2', 'c1', 2, '응', FORGE)]);
    expect(slots.map((s) => s.kind)).toEqual(['message', 'message']);
  });
});

describe('elapsedLabel — 경과는 묶음의 시작부터', () => {
  const t0 = new Date('2026-09-06T00:00:00.000Z').getTime();
  it('1분 미만은 숫자를 붙이지 않는다 — 0분째는 정보가 아니라 잡음이다', () => {
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 30_000)).toBeNull();
  });
  it('분과 시간을 사람이 읽는 말로 준다', () => {
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 3 * 60_000)).toBe('3분째');
    expect(elapsedLabel('2026-09-06T00:00:00.000Z', t0 + 90 * 60_000)).toBe('1시간째');
  });
});

describe('ProgressRow — 상태 한 줄', () => {
  it('본문이 아니라 저자 + 작업 중을 그리고, 펼치면 접힌 줄이 보인다', () => {
    render(<ProgressRow messages={[prog('p1', '파일을 읽는다'), prog('p2', '테스트를 돌린다')]} />);

    expect(screen.getByTestId('progress-row')).toBeTruthy();
    expect(screen.getByText('forge')).toBeTruthy();
    expect(screen.getByText('작업 중')).toBeTruthy();
    // **본문은 기본으로 안 보인다** — progress 본문은 요약의 재료이지 발화가 아니다.
    expect(screen.queryByText('파일을 읽는다')).toBeNull();
    expect(screen.queryByTestId('progress-detail')).toBeNull();

    // 다만 버리지도 않는다 — 펼치면 러너가 남긴 진행 기록이 그대로 있다.
    fireEvent.click(screen.getByTestId('progress-expand'));
    expect(screen.getByTestId('progress-detail')).toBeTruthy();
    expect(screen.getByText('파일을 읽는다')).toBeTruthy();
    expect(screen.getByText('테스트를 돌린다')).toBeTruthy();
  });

  it('한 줄뿐이면 펼치기를 그리지 않는다 — 접힌 것이 없다', () => {
    render(<ProgressRow messages={[prog('p1', '혼자')]} />);
    expect(screen.queryByTestId('progress-expand')).toBeNull();
  });

  it('소유자가 아니면 터미널 링크가 없다 — 비활성이 아니라 부재다', () => {
    render(<ProgressRow messages={[prog('p1', 'a', CODEX)]} />);
    // 남의 러너 셸이 여기 있다는 사실 자체가 새면 안 된다(`TerminalChip` 주석).
    expect(screen.queryByText('터미널 보기')).toBeNull();
  });

  it('소유자에게는 터미널 링크가 있다', () => {
    render(<ProgressRow messages={[prog('p1', 'a', FORGE)]} />);
    expect(screen.getByText('터미널 보기')).toBeTruthy();
  });
});
