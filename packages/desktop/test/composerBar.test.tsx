import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';

beforeEach(() => {
  // 이 파일이 검증하는 것은 보냄 취소 창이 아니다(#223) — 창을 끄고 즉시 전송 경로를 본다.
  // 창 자체는 undoSend.test.tsx 가 단독으로 지킨다.
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'bot', 'agent') },
  });
  setController({ typing: vi.fn(), upload: vi.fn() } as unknown as Controller);
});
afterEach(() => cleanup());

describe('컴포저 하단 바 (#146)', () => {
  // 전송이 Enter 전용이라 **마우스만 쓰는 사용자에게 보낼 방법이 아예 없었다.**
  // 이슈가 "리스타일이 아니라 신규 어포던스"이면서 접근성 경로가 없다고 짚은 지점이다.
  it('전송 버튼을 누르면 전송된다', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} scopeKey="c1" />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '보낼 말' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(onSend).toHaveBeenCalled();
  });

  // send() 가 빈 본문·첨부 없음을 막는다. 버튼도 같아야 한다 — 아니면 눌러도 아무 일이
  // 없어서 "내가 뭘 잘못했나"가 된다.
  it('본문이 비어 있으면 전송 버튼이 비활성이다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    const btn = () => screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    expect(btn().disabled).toBe(false);
  });

  // aria-label 은 input 에 있어야 한다. label 에 붙이면 그 요소 자신의 이름이 될 뿐
  // input 과 연결되지 않아 입력이 접근 불가가 된다 — 초판이 그랬다.
  it('첨부 입력이 접근성 이름으로 도달 가능하다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    const input = screen.getByLabelText('Attach a file');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('file');
  });

  it('@ 버튼이 목록을 열고 다시 눌러 닫는다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    const at = screen.getByRole('button', { name: 'Add mention' });

    fireEvent.click(at);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

    fireEvent.click(at);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  // #142 회귀선: 하단 바의 새 버튼은 컨테이너 **안**이어야 한다. 밖에 두면 그 버튼을
  // 누를 때 포커스 이탈 처리가 목록을 닫는다.
  it('하단 바 버튼을 눌러도 자동완성 목록이 닫히지 않는다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@b' } });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);

    const container = screen.getByRole('textbox').closest('.relative')!;
    const attach = screen.getByLabelText('Attach a file');
    fireEvent.blur(container, { relatedTarget: attach });

    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
});

describe('아이덴티티 컴포넌트가 유일한 경로다 (#146)', () => {
  // 같은 agent 필 마크업이 컴포저와 메시지 두 곳에 하드코딩돼 있었다 — 이 저장소에서
  // 반복되는 결함 형태다. 두 화면이 같은 컴포넌트를 쓰는지 지킨다.
  it('컴포저 후보 목록에서 에이전트가 표시된다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@b' } });

    expect(screen.getByText('에이전트')).toBeTruthy();
  });

  it('메시지 작성자 옆에서도 같은 표시가 쓰인다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);
    // #161 2단계: 거터에 하나, 작성자 옆에 하나 — 두 곳에서 에이전트 표시가 같이 써진다.
    expect(screen.getAllByText('에이전트')).toHaveLength(2);
  });

  it('사람과 에이전트가 다르게 표시된다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);
    expect(screen.queryByText('에이전트')).toBeNull();
    // 사람은 이니셜이 보이고 핸들이 숨은 텍스트로 남는다. 작성자 이름도 'me' 라
    // 중복되므로 이니셜(대문자 한 글자)로 아이덴티티를 특정한다.
    // #161 2단계: 거터와 작성자 옆 두 곳에서 이니셜이 보인다.
    expect(screen.getAllByText('M')).toHaveLength(2);
  });

  // "없다"와 "모른다"는 다르다. 디렉터리에 없는 계정을 빈 칸으로 그리면 "에이전트가
  // 아니다"로 읽힌다 — 초판이 null 을 반환했다.
  it('계정 디렉터리에 없으면 빈 칸이 아니라 명시적으로 표시한다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'ghost')} />);
    // #161 2단계: 거터와 작성자 옆 두 곳에서 "알 수 없는 계정"이 표시된다.
    expect(screen.getAllByText('알 수 없는 계정')).toHaveLength(2);
  });
});
