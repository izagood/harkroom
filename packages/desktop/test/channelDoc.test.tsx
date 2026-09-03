import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ChannelDoc } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { ChannelDocPanel } from '../src/components/ChannelDocPanel';
import { ChannelPane } from '../src/components/ChannelPane';
import { ApiError } from '../src/lib/api';
import { acc, chan, fakeApi, fakeWsFactory } from './helpers/fakeApi';

/**
 * #188 회귀선(화면). 채널 문서 패널이 지켜야 하는 약속들이다.
 *
 * 가장 중요한 것은 **409 를 사람에게 보이면서 그 사람의 편집을 버리지 않는다**는 것이다.
 * 낙관적 동시성은 조용한 손실을 막으려고 넣은 장치인데, 남의 것을 지키려고 내 것을 조용히
 * 버리면 손실의 주체만 바뀐다.
 */

const doc = (body: string, updatedAt: string | null, updatedBy: string | null = 'u2'): ChannelDoc =>
  ({ channelId: 'c1', body, updatedBy, updatedAt });

function mount(api: ReturnType<typeof fakeApi>) {
  setController(new Controller(api, fakeWsFactory().makeWs));
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'peer') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
  });
  render(<ChannelDocPanel channelId="c1" onClose={() => {}} />);
}

beforeEach(() => {
  useAppStore.getState().reset();
  setController(null);
});
afterEach(() => { cleanup(); setController(null); });

describe('채널 문서 패널', () => {
  it('저장한 문서를 읽기 모드로 보여 주고 "누가 언제"를 붙인다', async () => {
    mount(fakeApi({
      channelDoc: vi.fn(async () => doc('이 채널의 전제', '2026-09-01T03:04:05.000Z')),
    }));

    expect(await screen.findByText('이 채널의 전제')).toBeTruthy();
    // "누가"는 handle 로 뜬다 — id 를 그대로 보여 주면 사람이 못 읽는다.
    expect(screen.getByText(/peer/)).toBeTruthy();
  });

  it('아직 아무도 쓰지 않은 문서에는 "누가 언제"를 붙이지 않는다', async () => {
    // 지금 시각과 보는 사람으로 채우면 화면이 거짓말한다 — 아무도 쓴 적 없는 문서를
    // 내가 방금 고친 것처럼 보여 준다.
    mount(fakeApi({ channelDoc: vi.fn(async () => doc('', null, null)) }));

    expect(await screen.findByText('아직 문서가 없다')).toBeTruthy();
    expect(screen.queryByText(/me/)).toBeNull();
    expect(screen.queryByText(/peer/)).toBeNull();
  });

  it('조회 실패가 "빈 문서"가 아니라 오류로 보인다', async () => {
    mount(fakeApi({
      channelDoc: vi.fn(async () => { throw new Error('네트워크가 끊겼다'); }),
    }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('네트워크가 끊겼다');
    // 못 읽은 문서를 "없다"로 보여 주면 그 위에 저장해서 남의 문서를 지운다.
    expect(screen.queryByText('아직 문서가 없다')).toBeNull();
    expect(screen.queryByText('편집')).toBeNull();
  });

  it('8. 409 가 사람에게 보이고 편집 내용이 사라지지 않는다', async () => {
    const updateChannelDoc = vi.fn(async () => {
      throw new ApiError(409, 'doc_stale', 'the document changed since you read it', {
        error: { code: 'doc_stale', message: 'the document changed since you read it' },
        doc: doc('남이 먼저 고친 판', '2026-09-02T00:00:00.000Z'),
      });
    });
    mount(fakeApi({
      channelDoc: vi.fn(async () => doc('내가 읽은 판', '2026-09-01T00:00:00.000Z')),
      updateChannelDoc,
    }));

    fireEvent.click(await screen.findByText('편집'));
    const textarea = screen.getByLabelText('문서 편집') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '내가 오래 쓴 편집' } });
    fireEvent.click(screen.getByText('저장'));

    // (i) 실패가 사람에게 보인다. `sr-only` 가 아니라 실제로 읽히는 자리여야 한다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('다른 사람이 먼저 고쳤다');

    // (ii) **내 편집이 그대로 있다.** 이것이 이 테스트의 핵심이다 — 여기서 편집칸을
    // 서버 본문으로 덮으면 조용한 손실의 방향만 바뀐다.
    expect((screen.getByLabelText('문서 편집') as HTMLTextAreaElement).value)
      .toBe('내가 오래 쓴 편집');

    // (iii) 서버의 현재 내용도 함께 보인다 — 두 판을 보고 사람이 정한다.
    expect(screen.getByText('남이 먼저 고친 판')).toBeTruthy();

    // (iv) 다시 누르는 저장은 "봤고 내 것으로 간다"는 뜻이다. 그때는 서버가 준 최신
    // 기대값을 실어 보내므로 또 튕기지 않는다.
    updateChannelDoc.mockImplementation(
      (async (channelId: string, body: string) => doc(body, '2026-09-02T00:00:01.000Z', 'u1')) as never,
    );
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(updateChannelDoc).toHaveBeenCalledTimes(2));
    expect(updateChannelDoc.mock.calls[1]).toEqual([
      'c1', '내가 오래 쓴 편집', new Date('2026-09-02T00:00:00.000Z').getTime(),
    ]);
  });

  it('첫 저장은 기대값 null 로 보낸다 — 가짜 시각을 만들지 않는다', async () => {
    const updateChannelDoc = vi.fn(async (channelId: string, body: string) =>
      doc(body, '2026-09-02T00:00:00.000Z', 'u1'));
    mount(fakeApi({ channelDoc: vi.fn(async () => doc('', null, null)), updateChannelDoc }));

    fireEvent.click(await screen.findByText('편집'));
    fireEvent.change(screen.getByLabelText('문서 편집'), { target: { value: '첫 문서' } });
    fireEvent.click(screen.getByText('저장'));

    await waitFor(() => expect(updateChannelDoc).toHaveBeenCalled());
    expect(updateChannelDoc.mock.calls[0]).toEqual(['c1', '첫 문서', null]);
  });

  it('저장 실패(409 아님)도 사람에게 보이고 편집 모드를 벗어나지 않는다', async () => {
    mount(fakeApi({
      channelDoc: vi.fn(async () => doc('원래 본문', '2026-09-01T00:00:00.000Z')),
      updateChannelDoc: vi.fn(async () => { throw new ApiError(403, 'forbidden', '권한이 없다'); }),
    }));

    fireEvent.click(await screen.findByText('편집'));
    fireEvent.change(screen.getByLabelText('문서 편집'), { target: { value: '고친 것' } });
    fireEvent.click(screen.getByText('저장'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('권한이 없다');
    expect((screen.getByLabelText('문서 편집') as HTMLTextAreaElement).value).toBe('고친 것');
  });
});

describe('채널 헤더의 문서 진입점', () => {
  function mountPane(api: ReturnType<typeof fakeApi>, opts: { dm?: boolean } = {}) {
    setController(new Controller(api, fakeWsFactory().makeWs));
    useAppStore.getState().set({
      me: acc('u1', 'me'),
      accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'peer') },
      channels: opts.dm ? [] : [chan('c1', 'general')],
      dms: opts.dm ? [{ id: 'c1', memberIds: ['u1', 'u2'] }] : [],
      activeChannelId: 'c1',
    });
    render(<ChannelPane />);
  }

  // 단위 테스트가 패널만 그리면 "헤더 버튼이 그 패널을 실제로 연다"는 배선은 확인되지
  // 않는다. 그래서 헤더까지 함께 띄운다.
  it('헤더의 문서 버튼이 패널을 연다', async () => {
    mountPane(fakeApi({ channelDoc: vi.fn(async () => doc('헤더에서 연 문서', '2026-09-01T00:00:00.000Z')) }));

    fireEvent.click(screen.getByText('문서'));
    expect(await screen.findByText('헤더에서 연 문서')).toBeTruthy();
  });

  it('DM 에는 문서 버튼이 없다', () => {
    // 문서는 채널에 붙는다. 패널이 채널에서만 열리는데 버튼은 늘 그리면 DM 에서 눌러도
    // 아무 일이 없는 죽은 버튼이 된다.
    mountPane(fakeApi(), { dm: true });
    expect(screen.queryByText('문서')).toBeNull();
  });
});
