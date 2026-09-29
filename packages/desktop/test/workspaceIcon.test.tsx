import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CommunityRail } from '../src/components/CommunityRail';
import { resetCommunityRegistry, useCommunityRegistry } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import type { ApiClient } from '../src/lib/api';
import { createAppStore } from '../src/state/appStore';

/**
 * 워크스페이스 아이콘 — 커뮤니티 레일의 사진(2026-09-29). `jaebin.`·`jinbin.` 이 둘 다 "J" 로
 * 서던 문제다. 사진이 있으면 그것을, 없으면 **이니셜을 폴백**으로 그린다.
 */
afterEach(() => { cleanup(); resetCommunityRegistry(); });

function twoCommunities() {
  const reg = useCommunityRegistry.getState();
  const a = reg.claimActive({ baseUrl: 'https://jaebin.example.com', accountId: 'a1' });
  const b = reg.register({ baseUrl: 'https://jinbin.example.com', accountId: 'b1' });
  return { a, b };
}

describe('커뮤니티 레일 아이콘', () => {
  it('사진이 없으면 이니셜, 있으면 그 커뮤니티의 사진만 그린다', () => {
    const { a, b } = twoCommunities();
    b.store.getState().set({ workspaceIconUrl: 'blob:jinbin' });
    render(<CommunityRail />);

    expect(screen.getByTestId(`community-tile-${a.id}`).textContent).toBe('J');
    expect(screen.queryByTestId(`community-icon-${a.id}`)).toBeNull();
    const img = screen.getByTestId(`community-icon-${b.id}`) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:jinbin');
    // 이름은 버튼이 말한다 — img 가 같은 이름을 한 번 더 읽히지 않게 alt 는 비운다.
    expect(img.getAttribute('alt')).toBe('');
    expect(screen.getByTestId(`community-tile-${b.id}`).getAttribute('aria-label')).toContain('jinbin');
  });
});

describe('Controller 의 아이콘 조회', () => {
  const makeController = (fetchWorkspaceIcon: () => Promise<Blob | null>) => {
    const store = createAppStore();
    const api = { baseUrl: 'https://x', fetchWorkspaceIcon, setWorkspaceIcon: vi.fn(async () => ({ iconAttachmentId: null })), upload: vi.fn() } as unknown as ApiClient;
    const c = new Controller(api, (() => ({ close: () => {} })) as never, undefined, undefined, store);
    return { c, store, api };
  };

  it('받으면 objectURL 을 넣고, 404(null)면 지운다', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let next: Blob | null = new Blob(['x']);
    const { c, store } = makeController(async () => next);
    await (c as unknown as { refreshWorkspaceIcon(): Promise<void> }).refreshWorkspaceIcon();
    expect(store.getState().workspaceIconUrl).toBe('blob:1');

    next = null;
    await (c as unknown as { refreshWorkspaceIcon(): Promise<void> }).refreshWorkspaceIcon();
    expect(store.getState().workspaceIconUrl).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:1');
    create.mockRestore(); revoke.mockRestore();
  });

  it('못 읽으면 이전 사진을 지우지 않는다', async () => {
    const { c, store } = makeController(async () => { throw new Error('down'); });
    store.getState().set({ workspaceIconUrl: 'blob:old' });
    await expect((c as unknown as { refreshWorkspaceIcon(): Promise<void> }).refreshWorkspaceIcon()).rejects.toThrow();
    expect(store.getState().workspaceIconUrl).toBe('blob:old');
  });
});
