// 오퍼레이터 표시 이름(스레드 e12e6780) — label ?? name, 고르개는 보이는 이름이 겹칠 때만 「— 호스트명」.
import { describe, it, expect } from 'vitest';
import { operatorDisplayName, operatorFullName, operatorNameOf, operatorPickerLabels } from '../src/lib/operatorName';

describe('operatorName', () => {
  it('label 이 있으면 label, 없으면 호스트명', () => {
    expect(operatorDisplayName({ name: 'h.local', label: '맥북' })).toBe('맥북');
    expect(operatorDisplayName({ name: 'h.local', label: null })).toBe('h.local');
    expect(operatorDisplayName({ name: 'h.local' })).toBe('h.local'); // 옛 서버 — 키 없음
    expect(operatorNameOf(undefined)).toBeUndefined();
  });
  it('이름과 호스트명을 함께 — 바꾸지 않았으면 호스트명 하나', () => {
    expect(operatorFullName({ name: 'h.local', label: '맥북' })).toBe('맥북 (h.local)');
    expect(operatorFullName({ name: 'h.local', label: null })).toBe('h.local');
    expect(operatorFullName({ name: 'h.local', label: 'h.local' })).toBe('h.local');
  });
  it('고르개는 겹치는 이름에만 호스트명을 붙인다', () => {
    const labels = operatorPickerLabels([
      { id: '1', name: 'vm', label: 'VM' },
      { id: '2', name: 'vm2', label: 'VM' },
      { id: '3', name: 'mac', label: null },
    ]);
    expect(labels.get('1')).toBe('VM — vm');
    expect(labels.get('2')).toBe('VM — vm2');
    expect(labels.get('3')).toBe('mac');
  });
});
