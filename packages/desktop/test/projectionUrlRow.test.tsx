/**
 * 투영 URL 을 앱에서 켜는 자리(설계 §6). `#537` 이 만든 상태 줄 바로 아래에 선다.
 *
 * 두 사실의 **출처가 다르다**: 상태 줄은 `/projection/status`(모든 로그인 사용자),
 * 이 줄은 `/settings/projection`(admin). 그래서 한 줄에 합치지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProjectionConfigView } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ProjectionUrl } from '../src/components/settings/ProjectionUrl';
import { acc } from './helpers/fakeApi';

const view = (over: Partial<ProjectionConfigView> = {}): ProjectionConfigView => ({
  url: 'http://env.example:4000', source: 'env',
  appUrl: null, envUrl: 'http://env.example:4000', ...over,
});

let projectionConfig: ReturnType<typeof vi.fn>;
let setProjectionConfig: ReturnType<typeof vi.fn>;
let refreshProjection: ReturnType<typeof vi.fn>;

const mount = (opts: { isAdmin?: boolean; config?: ProjectionConfigView | Error } = {}) => {
  useActiveStore.getState().set({ me: acc('u1', 'admin', 'human', opts.isAdmin ?? true) });
  const c = opts.config ?? view();
  projectionConfig = vi.fn(c instanceof Error ? async () => { throw c; } : async () => c);
  setProjectionConfig = vi.fn(async (url: string | null) => view({
    url: url ?? 'http://env.example:4000', source: url ? 'app' : 'env', appUrl: url,
  }));
  refreshProjection = vi.fn(async () => { /* 저장 직후 상태 줄을 따라오게 한다 */ });
  setController({
    projectionConfig, setProjectionConfig, refreshProjection,
  } as unknown as Controller);
  return render(<ProjectionUrl />);
};

// **언어를 `ko` 로 고정한다.** 이 파일의 축들이 한국어 문구를 직접 재는데, 그 문구가
// 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 출처 둘이 서로 다른 말을
// 하는가, 지우기 안내가 잃는 것을 말하는가. `gallery`·`agentGrid` 회귀선이 같은
// 이유로 고정한다.
beforeEach(() => {
  localStorage.clear();
  useActiveStore.getState().reset();
  usePrefsStore.getState().setLocale('ko');
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

describe('투영 URL 편집 줄', () => {
  /** 권한이 없는 것은 오류가 아니다. 403 을 붉게 그리면 잘못 없는 화면에 경고가 뜬다. */
  it('admin 이 아니면 아무것도 그리지 않고 조회도 하지 않는다', () => {
    const { container } = mount({ isAdmin: false });
    expect(container.firstChild).toBeNull();
    expect(projectionConfig).not.toHaveBeenCalled();
  });

  /** 정상과 고장이 같은 말이면 이 줄은 아무것도 알려 주지 않는다. */
  it('출처를 사정마다 다른 말로 적는다', async () => {
    mount({ config: view({ source: 'env' }) });
    expect((await screen.findByTestId('projection-source')).textContent).toContain('환경변수');

    cleanup();
    mount({ config: view({ source: 'app', appUrl: 'http://app.example:5000', url: 'http://app.example:5000' }) });
    expect((await screen.findByTestId('projection-source')).textContent).toContain('앱에서 설정');
  });

  it('못 읽으면 그렇게 말한다 — 빈 자리로 두지 않는다', async () => {
    mount({ config: new Error('boom') });
    expect((await screen.findByRole('alert')).textContent).toContain('불러오지 못했다');
  });

  /**
   * **세 상태 중 첫 번째**: `config === null`(아직 응답 전). 첫 응답 전과 못 읽었을 때가
   * 같은 빈 자리면 사용자는 그 둘을 구별할 수 없다 — 나머지 둘은 위에서 이미 잰다.
   */
  it('아직 응답 전에는 불러오는 중이라고 말한다', async () => {
    useActiveStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
    let resolve!: (v: ProjectionConfigView) => void;
    projectionConfig = vi.fn(() => new Promise<ProjectionConfigView>((r) => { resolve = r; }));
    setProjectionConfig = vi.fn(async (url: string | null) => view({
      url: url ?? 'http://env.example:4000', source: url ? 'app' : 'env', appUrl: url,
    }));
    refreshProjection = vi.fn(async () => { /* 이 시험은 저장을 하지 않는다 */ });
    setController({ projectionConfig, setProjectionConfig, refreshProjection } as unknown as Controller);
    render(<ProjectionUrl />);

    expect(screen.getByText('투영 설정을 불러오는 중…')).toBeTruthy();

    resolve(view());
    await waitFor(() => expect(screen.queryByText('투영 설정을 불러오는 중…')).toBeNull());
    expect(await screen.findByTestId('projection-source')).toBeTruthy();
  });

  it('저장하면 입력한 URL 로 부른다', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), {
      target: { value: 'http://app.example:5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(setProjectionConfig).toHaveBeenCalledWith('http://app.example:5000'));
  });

  /**
   * **저장 직후 상태를 다시 읽는다.** 60 초 주기에 맡기면 방금 켠 투영이 최대 1 분 동안
   * 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
   */
  it('저장 후 투영 상태를 다시 읽는다', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), { target: { value: 'http://app.example:5000' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(refreshProjection).toHaveBeenCalled());
  });

  /** 지우기는 빈 문자열이 아니라 null 이다 — 서버가 빈 문자열을 400 으로 거절한다. */
  it('지우기는 null 로 부른다', async () => {
    mount({ config: view({ source: 'app', appUrl: 'http://app.example:5000', url: 'http://app.example:5000' }) });

    fireEvent.click(await screen.findByRole('button', { name: '지우기' }));

    await waitFor(() => expect(setProjectionConfig).toHaveBeenCalledWith(null));
  });

  /** 앱 값이 없으면 지울 것이 없다. 누를 수 있게 두면 아무 일도 없는 버튼이 된다. */
  it('앱 값이 없으면 지우기를 그리지 않는다', async () => {
    mount({ config: view({ source: 'env', appUrl: null }) });
    await screen.findByTestId('projection-source');
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull();
  });

  it('저장이 실패하면 그렇게 말한다', async () => {
    mount();
    setProjectionConfig.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), { target: { value: 'http://x.example' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect((await screen.findByRole('alert')).textContent).toContain('저장하지 못했다');
  });
});
