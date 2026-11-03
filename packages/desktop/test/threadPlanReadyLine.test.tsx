/** 계획판 ready 시스템 줄 화면(P6, designer 1·2) — ▶ 는 얼굴 칸 하나 · 제목이 있으면 id 를 쓰지 않는다 · 제목은 글자로만. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u2', 'other'), accounts: { u1: acc('u1', 'someone'), u2: acc('u2', 'other') } });
});
afterEach(() => cleanup());

const ready = (ids: string[], titles: Record<string, string>) => msg('r1', 'c1', 1, `▶ 이제 시작할 수 있는 단계 ${ids.length}개: ${ids.join(' · ')}`, 'u1', {
  kind: 'system',
  meta: { planReady: { ids, rev: 2, titles }, i18n: { key: 'system.plan.ready', args: { n: ids.length, ids: ids.join(' · ') } } },
});

describe('계획판 ready 줄', () => {
  it('제목이 있으면 머리 + 제목만, ▶ 는 얼굴 칸 하나, 제목의 @·태그는 글자 그대로', () => {
    render(<MessageItem message={ready(['s2', 'g1', 's5'], { s2: '@someone <b>배포</b>', g1: '화면 다듬기' })} />);
    const line = screen.getByTestId('system-record-line');
    expect(line.textContent).not.toContain('▶');
    expect(line.textContent).not.toContain('s2');
    expect(screen.getAllByTestId('plan-ready-title').map((e) => e.textContent)).toEqual(['@someone <b>배포</b>', ' · 화면 다듬기', ' · s5']);
    expect(line.querySelector('a, b, [data-mention]')).toBeNull();
  });

  it('제목이 하나도 없으면 서버 문장(id 목록)을 쓴다 — ▶ 없이', () => {
    render(<MessageItem message={ready(['s2', 's3'], {})} />);
    const line = screen.getByTestId('system-record-line');
    expect(line.textContent).toContain('s2 · s3');
    expect(line.textContent).not.toContain('▶');
    expect(screen.queryAllByTestId('plan-ready-title')).toHaveLength(0);
  });
});
