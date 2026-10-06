// 확인창 줄바꿈 — 한국어 제목·본문이 낱말 가운데서 접히지 않게(break-keep), 공백 없는 긴 글은 상자 안에서 접히게.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { ko } from '../src/i18n/ko';

afterEach(() => cleanup());

describe('ConfirmDialog 줄바꿈', () => {
  it('제목·본문을 담은 칸이 낱말 단위로만 접고, 긴 글은 상자 안에서 접는다', () => {
    render(<ConfirmDialog title="'작업용 맥북 (jaebin-mbp)' 오퍼레이터를 삭제할까?" detail="되돌릴 수 없다." detailKind="note" confirmLabel="삭제" onConfirm={() => {}} onCancel={() => {}} />);
    const box = screen.getByText("'작업용 맥북 (jaebin-mbp)' 오퍼레이터를 삭제할까?").parentElement!;
    expect(box.className).toContain('break-keep');
    expect(box.className).toContain('[overflow-wrap:anywhere]');
    expect(box.contains(screen.getByText('되돌릴 수 없다.'))).toBe(true);
  });

  it('삭제 확인 제목은 조사를 이름 끝 글자에 기대지 않는다', () => {
    expect(ko['mcpServers.confirmTitle']).toBe("'{name}' MCP 서버를 삭제할까?");
    expect(ko['operators.confirmTitle']).toBe("'{name}' 오퍼레이터를 삭제할까?");
  });
});
