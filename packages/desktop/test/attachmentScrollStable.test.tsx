import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { AttachmentRow, MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import {
  acquireAttachmentUrl, peekAttachmentUrl, resetAttachmentUrlCacheForTest, ATTACHMENT_URL_CACHE_LIMITS,
} from '../src/lib/attachmentUrlCache';
import { acc, msg } from './helpers/fakeApi';

// 채널 스크롤 버벅임 ①(스레드 bf24d7bd). 채널 본문은 가상 목록이라 화면 밖 줄은 언마운트되고
// 돌아오면 다시 마운트된다. 그때 그림을 **다시 받지 않고**, 받는 동안에도 **줄 높이가 같아야** 한다.

const image = (id = 'a1'): AttachmentRow =>
  ({ id, filename: `${id}.png`, contentType: 'image/png', sizeBytes: 10 });
const withImage = (a: AttachmentRow): MessageRow =>
  ({ ...msg('m1', 'c1', 1, '그림', 'u2'), attachments: [a] });

const controller = (fetchAttachment: (id: string) => Promise<Blob>) => {
  const c = { fetchAttachment: vi.fn(fetchAttachment), saveAttachment: vi.fn() };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  resetAttachmentUrlCacheForTest();
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'me'), accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') } });
});
afterEach(() => { cleanup(); setController(null); usePrefsStore.getState().setLocale('system'); });

describe('그림 URL 캐시', () => {
  it('줄이 다시 마운트돼도 다시 받지 않고, 첫 렌더부터 그림을 그린다', async () => {
    const c = controller(async () => new Blob(['x']));
    const first = render(<MessageItem message={withImage(image())} />);
    await screen.findByTestId('attachment-preview');
    first.unmount();

    render(<MessageItem message={withImage(image())} />);
    // findBy 가 아니라 getBy — 기다리지 않고 **바로** 있어야 빈 칸 → 그림 전환이 없다.
    expect(screen.getByTestId('attachment-preview')).toBeTruthy();
    expect(screen.queryByTestId('attachment-placeholder')).toBeNull();
    expect(c.fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('같은 그림을 동시에 그리는 두 자리는 요청 하나를 나눈다', async () => {
    const c = controller(async () => new Blob(['x']));
    render(<><MessageItem message={withImage(image())} /><MessageItem message={{ ...withImage(image()), id: 'm2' }} /></>);
    expect(await screen.findAllByTestId('attachment-preview')).toHaveLength(2);
    expect(c.fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it('실패는 담지 않는다 — 다음 마운트가 다시 묻는다', async () => {
    let fail = true;
    const c = controller(async () => { if (fail) throw new Error('503'); return new Blob(['x']); });
    const first = render(<MessageItem message={withImage(image())} />);
    await screen.findByText(/불러오기 실패/);
    first.unmount();

    fail = false;
    render(<MessageItem message={withImage(image())} />);
    await screen.findByTestId('attachment-preview');
    expect(c.fetchAttachment).toHaveBeenCalledTimes(2);
  });

  it('상한을 넘으면 오래 안 쓴 것부터 revoke 하되, 화면에 붙어 있는 것은 남긴다', async () => {
    controller(async () => new Blob(['x']));
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const held = acquireAttachmentUrl('held');
    const heldUrl = await held.promise;
    for (let i = 0; i < ATTACHMENT_URL_CACHE_LIMITS.MAX_ENTRIES + 5; i += 1) {
      const lease = acquireAttachmentUrl(`x${i}`);
      await lease.promise;
      lease.release();
    }
    expect(peekAttachmentUrl('held')).toBe(heldUrl);
    expect(revoke).not.toHaveBeenCalledWith(heldUrl);
    // 가장 먼저 놓은 것이 가장 먼저 나갔다.
    expect(peekAttachmentUrl('x0')).toBeNull();
    expect(revoke.mock.calls.length).toBeGreaterThanOrEqual(5);
    held.release();
    revoke.mockRestore();
  });

  // security n2: 꺼내 그린(peek) 것은 최근으로 올라가야 한다 — 같은 커밋에서 다른 줄의 release→evict 가
  // 방금 그린 것을 가장 오래된 것으로 보고 revoke 하지 않게.
  it('peek 한 것은 최근으로 올라가 다음 축출에서 살아남는다', async () => {
    controller(async () => new Blob(['x']));
    for (let i = 0; i < ATTACHMENT_URL_CACHE_LIMITS.MAX_ENTRIES; i += 1) {
      const lease = acquireAttachmentUrl(`x${i}`);
      await lease.promise;
      lease.release();
    }
    const drawn = peekAttachmentUrl('x0');
    expect(drawn).not.toBeNull();
    const extra = acquireAttachmentUrl('extra');
    await extra.promise;
    extra.release();
    expect(peekAttachmentUrl('x0')).toBe(drawn);
    expect(peekAttachmentUrl('x1')).toBeNull();
  });

  it('받는 도중 놓은 자리는 참조를 남기지 않는다', async () => {
    let resolve!: (b: Blob) => void;
    controller(() => new Promise<Blob>((r) => { resolve = r; }));
    const lease = acquireAttachmentUrl('a1');
    lease.release();
    await act(async () => { resolve(new Blob(['x'])); await Promise.resolve(); });
    await lease.promise;
    // 참조가 0 이므로 상한이 닿으면 내쫓을 수 있다 — 여기서는 캐시에 남아 있기만 하면 된다.
    expect(peekAttachmentUrl('a1')).not.toBeNull();
  });

  it('커뮤니티(컨트롤러)가 바뀌면 옛 세션이 받은 것을 쓰지 않는다', async () => {
    controller(async () => new Blob(['x']));
    await acquireAttachmentUrl('a1').promise;
    expect(peekAttachmentUrl('a1')).not.toBeNull();
    controller(async () => new Blob(['y']));
    expect(peekAttachmentUrl('a1')).toBeNull();
  });
});

describe('그림 칸은 받기 전후로 같은 높이다', () => {
  it('받는 동안에도 같은 고정 칸(h-56)이 서 있다', async () => {
    let resolve!: (b: Blob) => void;
    controller(() => new Promise<Blob>((r) => { resolve = r; }));
    render(<MessageItem message={withImage(image())} />);
    const before = screen.getByTestId('attachment-frame');
    expect(before.className).toContain('h-56');
    expect(screen.getByTestId('attachment-placeholder')).toBeTruthy();

    await act(async () => { resolve(new Blob(['x'])); });
    await screen.findByTestId('attachment-preview');
    const after = screen.getByTestId('attachment-frame');
    expect(after).toBe(before);
    expect(after.className).toBe(before.className);
    expect(screen.queryByTestId('attachment-placeholder')).toBeNull();
  });
});
