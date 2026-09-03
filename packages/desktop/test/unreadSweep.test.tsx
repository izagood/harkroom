import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { ChannelPrefRow } from '@murmur/shared';
import type { SweepItem } from '../src/state/sweep';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { Sweep, SweepShell } from '../src/components/Sweep';
import { acc, chan, fakeApi, fakeWsFactory, msg } from './helpers/fakeApi';

/**
 * #227 회귀선. 미읽음 데이터는 채널마다 있었지만 그것을 가로질러 하나씩 정리해 나갈 표면이
 * 없었다. 여기 묶어 둔 것은 그 표면이 지켜야 하는 약속들이다 — 특히 '그냥 다음'이 읽음 상태를
 * 건드리지 않는다는 것과, 조회 실패를 "다 봤다"로 삼키지 않는다는 것.
 */

const pref = (channelId: string, muted: boolean): ChannelPrefRow =>
  ({
    accountId: 'u1', channelId,
    mutedAt: muted ? '2026-09-03T00:00:00.000Z' : null,
    starredAt: null,
    // 훑기가 보는 것은 `notifyLevel` 이다(#224). `mutedAt` 은 기록일 뿐이다.
    notifyLevel: muted ? 'none' : 'all',
    section: null,
    sortOrder: null,
  });

const OLD = '2026-09-01T00:00:00.000Z';
const NEW = '2026-09-02T00:00:00.000Z';

/** c1(#general)은 오래된 미읽음 1개, c2(#dev)는 그보다 새 미읽음 1개. */
function twoChannelApi(over: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    reads: vi.fn(async () => [
      { channelId: 'c1', lastReadSeq: 0, unread: 1 },
      { channelId: 'c2', lastReadSeq: 2, unread: 1 },
    ]),
    messages: vi.fn(async (channelId: string) => channelId === 'c1'
      ? { messages: [msg('m1', 'c1', 1, '오래된 말', 'u2', { createdAt: OLD })], hasMore: false }
      : { messages: [msg('m2', 'c2', 3, '새 말', 'u2', { createdAt: NEW })], hasMore: false }),
    ...over,
  });
}

function mount(api: ReturnType<typeof fakeApi>, prefs: ChannelPrefRow[] = []) {
  setController(new Controller(api, fakeWsFactory().makeWs));
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'peer') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    channelPrefs: Object.fromEntries(prefs.map((p) => [p.channelId, p])),
  });
  render(<Sweep open onClose={() => {}} />);
}

beforeEach(() => {
  useAppStore.getState().reset();
  setController(null);
});
afterEach(() => { cleanup(); setController(null); });

describe('미읽음 훑기', () => {
  it('미읽음이 있는 채널을 오래된 것부터 보여 준다', async () => {
    mount(twoChannelApi());
    // 첫 항목은 오래된 쪽이다. 즐겨찾기·멘션 가중치가 끼어들면 이 단언이 깨진다.
    await screen.findByText('#general');
    expect(screen.queryByText('#dev')).toBeNull();
    expect(screen.getByText('1 / 2')).toBeTruthy();

    fireEvent.click(screen.getByText('그냥 다음'));
    await screen.findByText('#dev');
  });

  it('"읽음 처리하고 다음"이 읽음 위치를 전진시키고 다음으로 간다', async () => {
    const api = twoChannelApi();
    mount(api);
    await screen.findByText('#general');

    fireEvent.click(screen.getByText('읽음 처리하고 다음'));

    // 페이지의 최대 seq 까지 전진한다 — 그래야 채널이 실제로 정리된다.
    expect(api.markChannelRead).toHaveBeenCalledWith('c1', 1);
    await waitFor(() => expect(useAppStore.getState().reads['c1']).toEqual({ lastReadSeq: 1, unread: 0 }));
    await screen.findByText('#dev');
  });

  it('"그냥 다음"은 읽음 상태를 건드리지 않는다', async () => {
    const api = twoChannelApi();
    mount(api);
    await screen.findByText('#general');
    expect(useAppStore.getState().reads['c1']).toEqual({ lastReadSeq: 0, unread: 1 });

    fireEvent.click(screen.getByText('그냥 다음'));

    // 지나간 것은 읽은 것이 아니다. 여기서 ack 를 보내면 `markChannelRead` 의 단조 전진
    // 때문에 #154 의 미읽음 표시로만 되돌릴 수 있게 된다 — 사람이 모르는 사이에 치르는 대가다.
    expect(api.markChannelRead).not.toHaveBeenCalled();
    expect(useAppStore.getState().reads['c1']).toEqual({ lastReadSeq: 0, unread: 1 });
    // 클릭 직후 동기 조회는 CI 에서 흔들린다 — 다음 채널로의 전환은 상태 갱신을 거쳐
    // 다시 그려지므로, 형제 테스트처럼 findByText 로 기다린다.
    await screen.findByText('#dev');
  });

  it('음소거된 채널은 훑기 목록에 없다', async () => {
    const api = twoChannelApi();
    mount(api, [pref('c2', true)]);
    await screen.findByText('#general');

    // 음소거된 c2 는 아예 목록에 없다 — 하나뿐이므로 진행 표시도 1 / 1 이고,
    // 넘기면 #dev 가 아니라 완료 문구가 나온다.
    expect(screen.getByText('1 / 1')).toBeTruthy();
    expect(api.messages).not.toHaveBeenCalledWith('c2', expect.anything());

    fireEvent.click(screen.getByText('그냥 다음'));
    // 같은 이유로 여기도 기다린다 — 회수 중 이 단언이 실제로 한 번 흔들렸다.
    await screen.findByText('다 봤다');
    expect(screen.queryByText('#dev')).toBeNull();
  });

  it('훑을 것이 없으면 "다 봤다"를 보여 준다', async () => {
    mount(fakeApi({
      reads: vi.fn(async () => [{ channelId: 'c1', lastReadSeq: 5, unread: 0 }]),
    }));
    expect(await screen.findByText('다 봤다')).toBeTruthy();
  });

  /**
   * 목록을 다시 불러오면 처음부터 본다. `SweepShell` 이 이 되돌리기를 **effect 가 아니라
   * 렌더 중에** 하는 이유는 그쪽 주석에 있다 — effect 로 두면 클릭으로 올라간 인덱스를
   * 뒤늦게 도착한 effect 가 0 으로 되돌려, 눌렀는데 첫 항목에 머문다(CI 에서 위 두 건이
   * 그렇게 빨개졌다). 되돌리기 **자체가** 사라지지 않게 여기서 못 박는다: 인덱스를 그대로
   * 두면 짧아진 목록의 끝을 가리켜 볼 것이 남았는데도 "다 봤다"가 뜬다.
   *
   * `Sweep` 이 아니라 `SweepShell` 을 직접 띄우는 이유: 같은 컴포넌트를 **살려 둔 채로**
   * `items` 의 식별자만 갈아야 되돌리기가 일어나는 자리에 닿는다. 다시 mount 하면
   * `useState(0)` 이 알아서 0 이라 무엇도 지키지 않는다.
   */
  it('같은 화면에 새 목록이 오면 인덱스가 처음으로 되돌아간다', async () => {
    const items = (bodies: string[]): SweepItem[] => bodies.map((body, i) => ({
      channelId: `c${i + 1}`, label: `#${body}`, newestSeq: 1, oldestAt: OLD,
      messages: [msg(`m${i + 1}`, `c${i + 1}`, 1, body, 'u2', { createdAt: OLD })],
    }));
    useAppStore.getState().set({ accounts: { u2: acc('u2', 'peer') } });

    const first = items(['alpha', 'beta']);
    const { rerender } = render(
      <SweepShell items={first} loading={false} error={null}
        onRetry={() => {}} onClose={() => {}} onMarkRead={async () => {}} />,
    );

    fireEvent.click(screen.getByText('그냥 다음'));
    expect(screen.getByText('#beta')).toBeTruthy();
    expect(screen.getByText('2 / 2')).toBeTruthy();

    // 새 목록(다른 배열 식별자)이 오면 처음으로 돌아간다.
    rerender(
      <SweepShell items={items(['alpha', 'beta'])} loading={false} error={null}
        onRetry={() => {}} onClose={() => {}} onMarkRead={async () => {}} />,
    );

    expect(screen.getByText('#alpha')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
  });

  it('조회 실패는 "다 봤다"가 아니라 오류로 보인다', async () => {
    mount(fakeApi({
      reads: vi.fn(async () => { throw new Error('네트워크가 끊겼다'); }),
    }));

    // 실패를 빈 목록으로 삼키면 화면이 "다 읽었다"고 거짓말한다(docs/design.md §4).
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('네트워크가 끊겼다');
    expect(screen.queryByText('다 봤다')).toBeNull();
  });
});
