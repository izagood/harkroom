import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ApiClient', () => {
  it('sends bearer token and parses success body', async () => {
    const fn = stubFetch(200, { channels: [{ id: 'c1', name: 'dev', topic: '', kind: 'standard', repo: null }] });
    const api = new ApiClient('http://x:3400', 'tok-1');
    const channels = await api.channels();
    expect(channels[0]!.name).toBe('dev');
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x:3400/channels');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('throws ApiError with server error contract', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'nope' } });
    const api = new ApiClient('http://x:3400', 'tok');
    await expect(api.channels()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(api.channels()).rejects.toBeInstanceOf(ApiError);
  });

  it('builds message query and idempotency header', async () => {
    const fn = stubFetch(201, { id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: 'a', body: 'hi', kind: 'user', meta: {}, createdAt: 'now' });
    const api = new ApiClient('http://x:3400', 'tok');
    await api.postMessage('c1', 'hi', undefined, 'idem-1');
    const [, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('idem-1');

    await api.messages('c1', { since: 5 });
    const [url2] = fn.mock.calls[1]! as unknown as [string];
    expect(url2).toBe('http://x:3400/channels/c1/messages?since=5');
  });

  /**
   * #311 — `GET /skills` 의 **응답 모양**을 지킨다.
   *
   * 화면 테스트는 `listSkills` 를 목으로 바꾸므로 이 배선을 하나도 지키지 않는다. 실제로
   * 여기서 결함이 하나 나왔다: 라우트는 배열을 그대로 주는데 클라이언트가 `.skills` 를
   * 꺼내 `undefined` 를 받았고, 스킬 화면이 통째로 죽어 있었다(목 위의 테스트는 전부 초록).
   */
  it('reads GET /skills as a bare array — not wrapped in { skills }', async () => {
    const row = {
      slug: 'note', body: 'b', proposedBy: 'a1', proposedAt: 'now',
      approvedBy: null, approvedAt: null, disabledAt: null,
    };
    const fn = stubFetch(200, [row]);
    const api = new ApiClient('http://x:3400', 'tok');

    const skills = await api.listSkills();
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe('http://x:3400/skills');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.slug).toBe('note');
  });

  /**
   * #325 — `state` 를 넘기면 실제로 질의 문자열이 붙는가.
   *
   * 서버는 이제 모르는 질의 키를 400 으로 거절한다(별칭을 두지 않기로 했으므로). 그래서
   * 이 배선이 틀리면 화면이 조용히 잘못된 목록을 받는 것이 아니라 **통째로 실패한다**.
   * 위 테스트가 "인자가 없으면 질의가 붙지 않는다"를 잡고, 이 테스트가 그 반대를 잡는다.
   */
  it('appends ?state= when a state is given (#325)', async () => {
    const fn = stubFetch(200, []);
    const api = new ApiClient('http://x:3400', 'tok');

    await api.listSkills('pending');
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe('http://x:3400/skills?state=pending');
  });

  it('escapes the slug in skill routes — a slug is never spliced raw into the path', async () => {
    const fn = stubFetch(200, {});
    const api = new ApiClient('http://x:3400', 'tok');

    await api.approveSkill('a/b');
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe('http://x:3400/skills/a%2Fb/approve');

    await api.disableSkill('a/b');
    const [url, init] = fn.mock.calls[1]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x:3400/skills/a%2Fb');
    expect(init.method).toBe('DELETE');
  });

  /**
   * #221 — 스코프가 실제로 **선을 타는지** 본다. 팔레트 테스트는 `api.search` 를 목으로
   * 바꾸므로 URL 조립을 하나도 지키지 않는다. 여기가 그 배선을 지키는 유일한 자리다.
   */
  it('puts the channel scope on the search query string', async () => {
    const fn = stubFetch(200, { messages: [] });
    const api = new ApiClient('http://x:3400', 'tok');

    await api.search('needle');
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle');

    await api.search('needle', { channelId: 'c1' });
    expect((fn.mock.calls[1]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle&channelId=c1');

    // null 은 "스코프 없음"이지 빈 스코프가 아니다 — 빈 channelId 가 붙으면 서버가 400 이다.
    await api.search('needle', { channelId: null });
    expect((fn.mock.calls[2]! as unknown as [string])[0]).toBe('http://x:3400/search?q=needle');

    // 스레드 스코프는 채널을 **함께** 보낸다 — 서버의 403 판정이 채널 단위다.
    await api.search('needle', { channelId: 'c1', threadRootId: 't1', offset: 50 });
    expect((fn.mock.calls[3]! as unknown as [string])[0])
      .toBe('http://x:3400/search?q=needle&channelId=c1&threadRootId=t1&offset=50');
  });
  /**
   * 업로드는 이 파일에서 **혼자 `fetch` 를 쓰지 않는다**(진행률 때문에 XHR 이다). 배선을
   * 지키는 자리가 여기밖에 없다 — 화면 테스트는 컨트롤러를 목으로 바꿔 이 층을 안 지난다.
   */
  it('reports upload progress and resolves with the attachment row', async () => {
    const sent: { method?: string; url?: string; headers: Record<string, string> } = { headers: {} };
    let instance: FakeXhr;
    class FakeXhr {
      upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      status = 0;
      responseText = '';
      open(method: string, url: string) { sent.method = method; sent.url = url; }
      setRequestHeader(k: string, v: string) { sent.headers[k] = v; }
      send() { instance = this as unknown as FakeXhr; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const api = new ApiClient('http://x:3400', 'tok-1');
    const seen: number[] = [];
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    const p = api.upload(file, (f) => seen.push(f));

    instance!.upload.onprogress!({ lengthComputable: true, loaded: 50, total: 200 });
    // total 을 모르면 비율을 만들지 않는다 — 가짜 비율을 그리면 막대가 거짓말을 한다.
    instance!.upload.onprogress!({ lengthComputable: false, loaded: 60, total: 0 });
    instance!.status = 200;
    instance!.responseText = JSON.stringify({ id: 'att-1', filename: 'a.png' });
    instance!.onload!();

    await expect(p).resolves.toMatchObject({ id: 'att-1' });
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('http://x:3400/uploads');
    expect(sent.headers.authorization).toBe('Bearer tok-1');
    // 마지막 1 은 `onload` 가 못박는다 — 99% 에서 멈춘 막대는 실패처럼 보인다.
    expect(seen).toEqual([0.25, 1]);
  });

  it('turns an upload rejection into ApiError with the server code', async () => {
    let instance: { status: number; responseText: string; onload?: () => void; upload: Record<string, unknown>; open(): void; setRequestHeader(): void; send(): void };
    class FakeXhr {
      upload: Record<string, unknown> = {};
      onload?: () => void;
      status = 0;
      responseText = '';
      open() {}
      setRequestHeader() {}
      send() { instance = this as never; }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const api = new ApiClient('http://x:3400', 'tok');
    const p = api.upload(new File(['x'], 'x.png'));
    instance!.status = 400;
    instance!.responseText = JSON.stringify({ error: { code: 'not_an_image', message: 'nope' } });
    instance!.onload!();

    await expect(p).rejects.toMatchObject({ status: 400, code: 'not_an_image' });
  });
});
