import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ChannelFileRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { ChannelFiles } from '../src/components/ChannelFiles';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * #232 회귀선(화면). 채널에 오간 파일을 모아 보는 표면이 없었다. 여기 묶어 둔 것은 그 표면이
 * 지켜야 하는 약속들이다 — 항목을 누르면 **그 메시지로 간다**는 것(내려받기가 아니다), 그리고
 * 조회 실패를 "오간 파일이 없다"로 삼키지 않는다는 것.
 */

const file = (id: string, filename: string, messageId: string, messageSeq: number): ChannelFileRow =>
  ({
    id, filename, contentType: 'text/plain', sizeBytes: 1234,
    messageId, messageSeq, authorId: 'u2', createdAt: '2026-09-01T00:00:00.000Z',
  });

function mount(api: ReturnType<typeof fakeApi>) {
  setController(new Controller(api, fakeWsFactory().makeWs));
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'peer') },
    channels: [chan('c1', 'general')],
  });
  render(<ChannelFiles channelId="c1" onClose={() => {}} />);
}

beforeEach(() => {
  useAppStore.getState().reset();
  setController(null);
});
afterEach(() => { cleanup(); setController(null); });

describe('채널 파일 패널', () => {
  it('항목을 누르면 그 메시지로 간다', async () => {
    const api = fakeApi({
      channelFiles: vi.fn(async () => ({
        files: [file('a1', 'spec.pdf', 'm7', 7)], hasMore: false,
      })),
      // `openMessage` 는 서버에서 메시지를 다시 읽어 채널·스레드를 판단한다.
      message: vi.fn(async () => msg('m7', 'c1', 7, '파일 공유', 'u2')),
    });
    mount(api);

    fireEvent.click(await screen.findByText('spec.pdf'));

    // 내려받기가 아니라 이동이다 — 파일을 다시 찾는 사람이 원하는 것은 그 파일이 오간 맥락이다.
    expect(api.message).toHaveBeenCalledWith('m7');
    expect(api.fetchAttachment).not.toHaveBeenCalled();
    // 그 메시지에 강조가 걸려야 도착했다는 것이 보인다(#178).
    await vi.waitFor(() => expect(useAppStore.getState().highlightedMessageId).toBe('m7'));
    expect(useAppStore.getState().activeChannelId).toBe('c1');
  });

  it('조회 실패가 "없다"가 아니라 오류로 보인다', async () => {
    mount(fakeApi({
      channelFiles: vi.fn(async () => { throw new Error('네트워크가 끊겼다'); }),
    }));

    // 실패를 빈 목록으로 삼키면 화면이 "오간 파일이 없다"고 거짓말한다(docs/design.md §4).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('네트워크가 끊겼다');
    expect(screen.queryByText('아직 오간 파일이 없다')).toBeNull();
  });

  it('파일이 없으면 "없다"를 보여 준다', async () => {
    mount(fakeApi());
    expect(await screen.findByText('아직 오간 파일이 없다')).toBeTruthy();
    // 비어 있음은 오류가 아니다 — 여기서 alert 가 뜨면 둘을 구분하지 못한 것이다.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
