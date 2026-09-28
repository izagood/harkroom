// 모델 고르개 — 하네스가 받는다고 밝힌 모델에서 고르고, 모를 때는 자유 입력으로 물러선다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ModelPicker } from '../src/components/settings/ModelPicker';

afterEach(() => cleanup());

const models = [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-6-astra' }];

describe('ModelPicker', () => {
  it('목록이 있으면 그 안에서 고르고, 고른 id 가 그대로 값이 된다', () => {
    const onChange = vi.fn();
    render(<ModelPicker className="" value="" models={models} onChange={onChange} />);
    const select = screen.getByTestId('model-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'gpt-5.5', 'gpt-6-astra', '__custom__']);
    fireEvent.change(select, { target: { value: 'gpt-6-astra' } });
    expect(onChange).toHaveBeenCalledWith('gpt-6-astra');
    expect(screen.queryByTestId('model-custom-input')).toBeNull();
  });

  it('저장된 값이 목록에 없으면 직접 입력으로 연다 — 조용히 다른 값으로 바꾸지 않는다', () => {
    render(<ModelPicker className="" value="claude-opus-5-5" models={models} onChange={vi.fn()} />);
    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('__custom__');
    expect((screen.getByTestId('model-custom-input') as HTMLInputElement).value).toBe('claude-opus-5-5');
  });

  it('직접 입력을 고르면 입력칸이 열린다', () => {
    render(<ModelPicker className="" value="" models={models} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__custom__' } });
    expect(screen.getByTestId('model-custom-input')).toBeTruthy();
  });

  it('목록을 모르면(undefined) 자유 입력과 사유를 그린다 — "고를 것이 없다" 로 그리지 않는다', () => {
    render(<ModelPicker className="" value="opus" models={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTestId('model-select')).toBeNull();
    expect((screen.getByTestId('model-custom-input') as HTMLInputElement).value).toBe('opus');
    expect(screen.getByTestId('model-list-unknown')).toBeTruthy();
  });

  it('아직 안 읽었으면(null) 고르개를 잠근다', () => {
    render(<ModelPicker className="" value="" models={null} onChange={vi.fn()} />);
    expect((screen.getByTestId('model-select') as HTMLSelectElement).disabled).toBe(true);
  });
});
