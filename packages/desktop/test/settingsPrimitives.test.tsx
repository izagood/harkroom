// Task 15-1(identity 문서) — 폼 프리미티브.
//
// 지금까지 `const field = 'w-full rounded border ...'` 가 파일마다 따로 살았고 **값이 이미
// 갈라져 있었다**(`px-3 py-2` / `px-2 py-1` / `mt-1` 붙은 것). 같은 자리가 화면마다 다르게
// 생겼다는 뜻이다. 여기로 모아 그 갈라짐을 없애고, `AgentsSettings` 를 쪼갤 때 상세 화면이
// **따라갈 것**을 만든다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Button, Field, Segmented, Select, TextInput } from '../src/components/settings/primitives';

afterEach(() => cleanup());

describe('Field — 라벨과 힌트', () => {
  it('라벨이 입력과 연결된다 — 라벨을 눌러 포커스가 간다', () => {
    render(<Field label="작업 디렉터리"><TextInput value="" onChange={vi.fn()} /></Field>);
    expect(screen.getByLabelText('작업 디렉터리')).toBeTruthy();
  });

  /**
   * **힌트는 한 자리에만**(문서 원칙 06). `placeholder` 는 예시만, 규칙은 힌트 줄로.
   * 두 곳에 나뉘면 사람이 규칙을 놓친다.
   */
  it('placeholder 는 예시, 힌트는 규칙 — 둘이 다른 자리다', () => {
    render(
      <Field label="작업 디렉터리" hint="비우면 스레드마다 새로 만든다">
        <TextInput value="" onChange={vi.fn()} placeholder="/Users/me/some-repo" />
      </Field>,
    );
    expect(screen.getByPlaceholderText('/Users/me/some-repo')).toBeTruthy();
    expect(screen.getByText('비우면 스레드마다 새로 만든다')).toBeTruthy();
  });

  it('되돌릴 수 없는 것은 경고 톤을 받는다 — 가장 작은 회색 글씨면 아무도 안 읽는다', () => {
    render(
      <Field label="이름" hint="만든 뒤에는 바꿀 수 없다" tone="warning">
        <TextInput value="" onChange={vi.fn()} />
      </Field>,
    );
    expect(screen.getByText('만든 뒤에는 바꿀 수 없다').className).toContain('text-warning');
  });
});

describe('Segmented — 여럿 중 하나', () => {
  /**
   * 보이는 것이 버튼 무리라도 **스크린리더에게는 "여럿 중 하나"** 로 읽혀야 한다.
   * 그래야 화살표 키 동작이 자연스럽고, 지금 무엇이 골라져 있는지가 전달된다.
   */
  it('radiogroup 이고 고른 것이 checked 다', () => {
    render(
      <Segmented
        label="하네스"
        value="codex"
        onChange={vi.fn()}
        options={[{ value: 'claude-code', label: 'claude-code' }, { value: 'codex', label: 'codex' }]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: '하네스' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'codex' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'claude-code' }).getAttribute('aria-checked')).toBe('false');
  });

  it('고르면 값을 알린다', () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="하네스" value="codex" onChange={onChange}
        options={[{ value: 'claude-code', label: 'claude-code' }, { value: 'codex', label: 'codex' }]}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'claude-code' }));
    expect(onChange).toHaveBeenCalledWith('claude-code');
  });
});

describe('Select · TextInput', () => {
  it('Select 는 고른 값을 알린다', () => {
    const onChange = vi.fn();
    render(
      <Select
        ariaLabel="effort" value="" onChange={onChange}
        options={[{ value: '', label: '기본값' }, { value: 'high', label: 'high' }]}
      />,
    );
    fireEvent.change(screen.getByLabelText('effort'), { target: { value: 'high' } });
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('disabled 면 값을 바꿀 수 없다', () => {
    const onChange = vi.fn();
    render(<TextInput value="x" onChange={onChange} disabled ariaLabel="이름" />);
    expect((screen.getByLabelText('이름') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Button', () => {
  /**
   * **`danger` 를 따로 두는 것이 요점**이다 — 되돌릴 수 없는 조작이 보통 버튼과 같게
   * 생기면 사람이 구별할 수단이 없다.
   */
  it('세 변종이 서로 다르게 생긴다', () => {
    const { container } = render(
      <>
        <Button variant="primary">저장</Button>
        <Button variant="secondary">되돌리기</Button>
        <Button variant="danger">삭제</Button>
      </>,
    );
    const cls = Array.from(container.querySelectorAll('button')).map((b) => b.className);
    expect(new Set(cls).size).toBe(3);
    expect(cls[0]).toContain('bg-accent');
    expect(cls[2]).toContain('danger');
  });

  it('disabled 면 눌리지 않는다', () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>저장</Button>);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
