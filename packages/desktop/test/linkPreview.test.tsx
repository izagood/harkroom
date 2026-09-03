import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, Controller, type Controller as ControllerType } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg, fakeApi, fakeWsFactory } from './helpers/fakeApi';

// 링크 미리보기 카드의 데스크탑 쪽(#215, 요구 8).
//
// **`MessageItem` 을 통째로 띄운다.** `LinkPreview` 에 props 를 손으로 넘기는 테스트는
// 배선이 끊겨도 초록이다 — 실제로 확인해야 하는 것은 "본문에 URL 이 있으면 카드가 붙는가"
// 이고, 그 배선은 `MessageBody` 안에 있다.

const card = (over: Partial<{ title: string | null; description: string | null; siteName: string | null; imageUrl: string | null; status: string }> = {}) => ({
  url: 'https://example.com/a',
  title: 'Example Title',
  description: 'Example description',
  siteName: 'Example',
  imageUrl: 'https://cdn.example.com/pic.png',
  status: 'ok',
  fetchedAt: new Date().toISOString(),
  ...over,
});

const show = (body = '봐봐 https://example.com/a') =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

function stubApi(getLinkPreview: (url: string) => Promise<unknown>) {
  const fn = vi.fn(getLinkPreview);
  setController({ api: { getLinkPreview: fn }, openMessage: vi.fn() } as unknown as ControllerType);
  return fn;
}

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'someone') },
  });
});
afterEach(() => { cleanup(); setController(null); });

describe('ok 카드', () => {
  it('사이트명·제목·설명 텍스트가 보인다', async () => {
    stubApi(async () => card());
    show();
    await screen.findByTestId('link-preview');
    expect(screen.getByText('Example Title')).toBeTruthy();
    expect(screen.getByText('Example description')).toBeTruthy();
    expect(screen.getByText('Example')).toBeTruthy();
  });

  // **결정 1.** 이미지를 그리면 그 링크를 본 사람마다 자기 기기로 외부 서버를 친다 —
  // "서버가 가져온다"가 무너진다. `imageUrl` 을 응답에 **넣어 두고** 확인하는 이유가 이것이다:
  // 값이 없어서 안 그려지는 것이 아니라, 있어도 안 그린다는 것을 봐야 한다.
  it('imageUrl 이 와도 <img> 를 그리지 않는다', async () => {
    stubApi(async () => card());
    const { container } = show();
    await screen.findByTestId('link-preview');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('cdn.example.com/pic.png');
    // 배경 이미지로 우회하는 길도 막는다.
    expect(container.innerHTML).not.toContain('background-image');
  });

  // 컴포넌트 소스에 `<img` 가 아예 없어야 한다 — 위 테스트는 이 응답에서만 안 그리는
  // 구현(조건부 렌더)도 통과시킨다.
  it('컴포넌트 소스에 img 태그가 없다', () => {
    // 주석은 뺀다 — 파일 머리의 설명이 왜 그리지 않는지를 `<img>` 라고 적고 있다.
    const src = readFileSync(join(process.cwd(), 'src/components/LinkPreview.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).not.toMatch(/<img\b/);
    expect(src).not.toMatch(/backgroundImage/);
    expect(src).not.toMatch(/imageUrl/); // 값을 아예 읽지 않는다
  });
});

describe('그리지 않는 경우', () => {
  it.each(['failed', 'blocked'])('%s 는 아무것도 그리지 않는다 — 빈 카드도 없다', async (status) => {
    stubApi(async () => card({ status }));
    const { container } = show();
    await waitFor(() => expect(screen.getByTestId('message-body')).toBeTruthy());
    expect(screen.queryByTestId('link-preview')).toBeNull();
    // 원 링크는 그대로 남는다 — 카드가 없다고 본문이 달라지지는 않는다.
    expect(screen.getByTestId('body-link')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="link-preview"]')).toHaveLength(0);
  });

  it('아직 카드가 없으면(404) 아무것도 그리지 않는다 — 뼈대도 없다', async () => {
    const api = stubApi(async () => { throw Object.assign(new Error('not found'), { status: 404 }); });
    show();
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByTestId('link-preview')).toBeNull();
  });

  it('ok 이지만 담긴 글자가 없으면 그리지 않는다', async () => {
    stubApi(async () => card({ title: null, description: null, siteName: null }));
    const api2 = screen; // 이름만 쓰지 않기 위한 참조
    show();
    await waitFor(() => expect(api2.getByTestId('message-body')).toBeTruthy());
    expect(screen.queryByTestId('link-preview')).toBeNull();
  });

  it('URL 이 없는 본문은 카드를 아예 요청하지 않는다', async () => {
    const api = stubApi(async () => card());
    show('링크 없는 그냥 글');
    await waitFor(() => expect(screen.getByTestId('message-body')).toBeTruthy());
    expect(api).not.toHaveBeenCalled();
  });
});

describe('조회 키', () => {
  // 서버는 정규화한 URL 을 키로 저장한다. 여기서 후행 마침표를 떼지 않으면 카드는 영원히
  // 404 다 — 초판이 그랬다.
  it('문장 끝의 마침표를 뗀 정규화 URL 로 조회한다', async () => {
    const api = stubApi(async () => card());
    show('자세히는 https://example.com/a.');
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api.mock.calls[0]![0]).toBe('https://example.com/a');
  });

  it('한 본문의 URL 은 최대 3개만 요청한다', async () => {
    const api = stubApi(async () => card({ status: 'failed' }));
    show('https://a.io https://b.io https://c.io https://d.io');
    await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  });
});

// 가져오기는 비동기다 — 메시지가 먼저 뜨고 카드가 뒤에 온다. 이 신호를 처리하지 않으면
// 카드는 앱을 다시 켤 때까지 보이지 않는다(초판이 그랬다).
describe('link_preview.ready 이벤트', () => {
  it('컨트롤러가 이벤트를 받으면 스토어에 신호가 남는다', async () => {
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(fakeApi(), makeWs);
    await c.start();

    callbacks.current!.onEvent({ type: 'link_preview.ready', url: 'https://example.com/a', audience: 'all' });

    expect(useAppStore.getState().linkPreviewReadyAt['https://example.com/a']).toBeGreaterThan(0);
  });

  it('신호가 오면 카드를 다시 읽고, 그때 나타난다', async () => {
    let ready = false;
    const api = stubApi(async () => {
      if (!ready) throw Object.assign(new Error('not found'), { status: 404 });
      return card();
    });
    show();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('link-preview')).toBeNull();

    ready = true;
    useAppStore.getState().set({ linkPreviewReadyAt: { 'https://example.com/a': Date.now() } });

    await screen.findByTestId('link-preview');
    expect(screen.getByText('Example Title')).toBeTruthy();
  });
});
