import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Composer } from '../src/components/Composer';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';
import { undoSendStorage } from '../src/lib/prefs';
import { usePrefsStore } from '../src/state/prefsStore';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 **그 언어로 표현된
 * 규율**이다 — 문구가 사전을 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로,
 * 한국어 문구를 재는 줄을 지우는 대신 언어를 못 박는다. `gallery.test.tsx`·
 * `skillsSettings.test.tsx`·`agentGrid.test.tsx`·`accountAvatar.test.tsx` 가 세운 선례다.
 */
beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => usePrefsStore.getState().setLocale('system'));

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
  // 초판은 `에이전트` 배지가 후보 목록에 나오는 것으로 "같은 컴포넌트를 쓰는가"를 쟀다.
  // 그 배지는 사라졌다(#455) — 이제 계정 후보는 종류를 말하지 않는다. 재는 사실을 바꾼다:
  // 후보 줄에 **하드코딩된 종류 표시가 되살아나지 않는지**를 본다. 집합·팀 배지는 별개다.
  it('컴포저 후보 목록은 계정의 종류를 말하지 않는다', () => {
    render(<Composer onSend={vi.fn()} scopeKey="c1" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@b' } });

    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) {
      expect(o.textContent).not.toContain('🤖');
      expect(o.textContent).not.toContain('에이전트');
    }
  });

  /**
   * 초판은 "메시지 작성자 옆에서도 같은 표시가 쓰인다" 였고, `에이전트` 배지가 메시지
   * 화면에 나오는 것으로 그것을 쟀다.
   *
   * **identity 문서로 뒤집혔다** — 메시지 대화 화면에는 그 배지가 없다. 그런데 #146 이
   * 지키는 것은 *"같은 배지가 두 곳에 하드코딩돼 있었다"* 이고, **배지가 사라진 자리에
   * 누군가 손으로 🤖·@소유자를 그려 넣는 것**이 바로 이 회귀선이 막아야 하는 것이다.
   * 그래서 재는 방향을 뒤집는다: 메시지 화면에 `Identity` 를 거치지 않은 종류·소유자
   * 표기가 **하나도 없다**.
   *
   * 컴포저 쪽(위 회귀선)이 배지가 실제로 살아 있음을 계속 재므로, 이 단언이 "배지
   * 컴포넌트를 통째로 지워서" 만족되는 것이 아니다 — 두 회귀선이 함께 그것을 가른다.
   */
  it('메시지 화면에 손으로 그린 종류·소유자 표기가 없다', () => {
    const { container } = render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);
    // 거터는 `Identity` 를 통과한 아바타 하나뿐이다 — 핸들로 자신을 말한다.
    expect(screen.getByTestId('author-gutter').textContent).toContain('bot');
    // 배지 마크업의 조각들이 어디에도 없다. 문자열로 보는 이유는 컴포넌트가 아니라
    // **손으로 적어 넣은 리터럴**을 잡는 것이 이 회귀선의 일이기 때문이다.
    expect(container.textContent).not.toContain('🤖');
    expect(container.textContent).not.toContain('에이전트');
    expect(container.textContent).not.toContain('@');
  });

  it('사람과 에이전트가 다르게 표시된다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);
    expect(screen.queryByText('에이전트')).toBeNull();
    // 사람은 이니셜이 보이고 핸들이 숨은 텍스트로 남는다. 작성자 이름도 'me' 라
    // 중복되므로 이니셜(대문자 한 글자)로 아이덴티티를 특정한다.
    // #161 2단계는 거터와 작성자 옆 두 곳에 그려 이니셜이 둘이었다. #365 로 사람의 badge
    // 자리는 아무것도 그리지 않으므로 **거터 하나뿐**이다 — 이름은 이름줄이 이미 낸다.
    expect(screen.getAllByText('M')).toHaveLength(1);
  });

  // "없다"와 "모른다"는 다르다. 디렉터리에 없는 계정을 빈 칸으로 그리면 "에이전트가
  // 아니다"로 읽힌다 — 초판이 null 을 반환했다.
  it('계정 디렉터리에 없으면 빈 칸이 아니라 명시적으로 표시한다', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'ghost')} />);
    // 초판은 **2** 였다 — "#161 2단계: 거터와 작성자 옆 두 곳". 이름 옆 호출이 사라져
    // 하나가 됐다. 그러나 이 회귀선이 지키는 것은 개수가 아니라 *"없다와 모른다는
    // 다르다"* 다(초판 주석: 빈 칸으로 그리면 "에이전트가 아니다"로 읽힌다). 그 사실은
    // 그대로 유효하므로 **남은 한 자리에서 계속** 잰다.
    expect(screen.getAllByText('알 수 없는 계정')).toHaveLength(1);
    // 그 하나가 거터의 것이다. 개수만 세면 거터가 조용히 비어도 초록이다.
    expect(screen.getByTestId('author-gutter').textContent).toContain('알 수 없는 계정');
    // 이름줄은 핸들을 모를 때 '…' 로 자리를 지킨다 — 빈 칸이 아니다.
    expect(screen.getByTestId('author-name').textContent).toBe('…');
  });
});
