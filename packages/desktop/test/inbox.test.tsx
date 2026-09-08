import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AskMeta, InboxEntry } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Inbox } from '../src/components/Inbox';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan, msg } from './helpers/fakeApi';

const entry = (
  id: number, reason: InboxEntry['reason'], channelId: string, readAt: string | null = null,
  extra: Partial<InboxEntry> = {},
): InboxEntry => ({ id, messageId: `m${id}`, reason, readAt, channelId, authorId: 'u1', body: '', meta: {}, createdAt: '2024-01-01T00:00:00.000Z', threadRootId: null, ...extra });

/**
 * 나에게 온 선택 하나(`AskMeta`). 줄이 **무슨 말인가**는 `reason` 이 아니라 여기서 나온다 —
 * `reason` 셋은 어떻게 왔는가만 말하고, 그래서 전에는 네 줄이 글자까지 똑같았다(#488 C2).
 */
const askMeta = (optionCount: number, to: AskMeta['ask']['to'] = { kind: 'human' }) => ({
  kind: 'ask',
  ask: {
    options: Array.from({ length: optionCount }, (_, i) => ({ id: `o${i}`, label: `선택 ${i}` })),
    to,
  },
} as unknown as Record<string, unknown>);

/**
 * 이 화면은 스토어의 `unread` 가 아니라 `api.inbox()` 를 직접 부른다 — 그 배열은 `?unread=1`
 * 로만 채워져 안 읽은 것밖에 없고, 그것만 보면 '안 읽음만' 필터가 항상 참이 된다.
 */
const fakeController = (
  inbox: () => Promise<InboxEntry[]> = async () => [],
) => {
  const c = {
    api: { inbox: vi.fn(inbox) },
    openMessage: vi.fn(async () => undefined),
    openChannel: vi.fn(async () => undefined),
    // 줄에서 바로 답하는 경로(#488 C2). 스레드를 열지 않고 이것만 불려야 한다.
    answerAsk: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(`#619`·사이드바 PR 이
// 세운 방식과 같다). 영어가 원본이라 기본값이 영어이므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ channels: [chan('c1', 'general'), chan('c2', 'random')] });
});

afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 이 파일은 인박스의 **내용**(줄 · 필터 칩 · 정렬 · 선택 버튼)을 잰다. **껍데기는 재지
 * 않는다** — 인박스가 모달이 아니라 자리인 것(#488 C2)은 `inboxPane.test.tsx` 가 `Workspace`
 * 를 통째로 띄워 지킨다. 여기서 단독으로 렌더해서는 "옆에 선 것을 덮지 않는가"를 증명할 수
 * 없다: 모달이 막는 것은 자기 자신이 아니라 옆에 선 것이다.
 */
const open = () => render(<Inbox open onClose={vi.fn()} />);

describe('Inbox (#185)', () => {
  // 1. 목록 자체가 없던 것이 이 이슈의 핵심이다. 셋 중 하나라도 빠지면 그 종류로 나를 부른
  //    것은 여전히 어디에도 안 보인다.
  //
  //    #488 C2 가 여기에 한 가지를 더 걸었다: 나오는 것만으로는 부족하고 **줄끼리 갈려야**
  //    한다. 문서의 진단이 *"네 줄이 글자 하나까지 똑같다"* 였고, 말표가 겹치면 목록은
  //    다시 그 상태로 돌아간다 — 그래서 서로 다르다는 것까지 여기서 잰다.
  it('멘션·스레드 답글·DM 항목이 모두 목록에 나오고, 줄마다 말표가 다르다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1'), entry(2, 'thread_reply', 'c1'), entry(3, 'dm', 'c2'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();
    expect(screen.getByTestId('inbox-entry-3')).toBeTruthy();

    const labels = [1, 2, 3].map((id) => screen.getByTestId(`inbox-reason-${id}`).textContent);
    // 글자를 하나씩 박지 않는다 — 말표의 어휘는 `lib/inboxRow` 가 정하고 그 파일의
    // 테스트가 지킨다. 화면이 져야 할 책임은 **그 값을 줄마다 제대로 실어 나르는 것**이다.
    expect(new Set(labels).size).toBe(3);
    expect(labels.every((l) => l && l.length > 0)).toBe(true);
  });

  // 2. 좁히는 행위. 종류 `select` 는 사라졌지만(#488 B3) **좁힌다는 사실 자체는 칩으로
  //    남았다** — 축이 `reason` 에서 '나를 막는가'로 바뀌었을 뿐이다. 원래 이 테스트가
  //    지키던 것(좁히면 안 맞는 것이 빠진다)을 그대로 칩에서 잰다.
  it('칩으로 좁히면 안 맞는 줄이 빠진다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    fakeController(async () => [
      // 나에게 온 미답 선택 — 나를 막는 것(rank 0).
      entry(1, 'mention', 'c1', null, { meta: askMeta(2) }),
      // 평범한 멘션 — 읽을 것(rank 1).
      entry(2, 'mention', 'c1'),
      // 스레드 답글 — 배경(rank 2). 어느 칩에도 안 걸리고 '전부'에서만 보인다.
      entry(3, 'thread_reply', 'c2'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('inbox-filter-blocking'));
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-entry-2')).toBeNull();
    expect(screen.queryByTestId('inbox-entry-3')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-filter-reading'));
    expect(screen.queryByTestId('inbox-entry-1')).toBeNull();
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();
    expect(screen.queryByTestId('inbox-entry-3')).toBeNull();

    // '전부'는 필터가 꺼진 상태다 — 배경까지 돌아온다.
    fireEvent.click(screen.getByTestId('inbox-filter-all'));
    for (const id of [1, 2, 3]) expect(screen.getByTestId(`inbox-entry-${id}`)).toBeTruthy();
  });

  // 고른 칩이 **눌린 것으로 보여야** 한다. 좁혀 놓고 그것이 안 보이면 걸러져 사라진 항목이
  //  없는 항목으로 읽힌다 — `select` 에서는 고른 값이 저절로 보였지만 칩은 아니다.
  it('고른 칩이 눌린 것으로 보인다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1')]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    expect(screen.getByTestId('inbox-filter-all').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('inbox-filter-blocking'));
    expect(screen.getByTestId('inbox-filter-blocking').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('inbox-filter-all').getAttribute('aria-pressed')).toBe('false');
  });

  // 3. '안 읽음만' 필터는 #488 B3 에서 사라졌다가 **돌아왔다.** 없앤 근거는 축이 다르다는
  //    것이었는데(정렬은 '나를 막는가', 이것은 내 읽음 상태), 실제로 쓰다 보니 그 대가가
  //    너무 컸다 — '전부' 에 이미 본 수백 줄이 새 줄과 같은 모양으로 섞여 나와서 무엇이
  //    새로 온 것인지 화면이 말하지 못했다(2026-09-08 사용자 보고).
  //
  //    축이 다르다는 사실 자체는 그대로다. 그래서 칩을 되살리면서 `matchesFilter` 주석에
  //    "이 칩만 다른 축"이라고 적어 둔다 — 숨기는 것보다 적어 두는 편이 정직하다.
  //
  //    표시도 그대로 남는다: 좁히지 않고 보는 사람에게는 줄 자체가 둘을 갈라 말해야 한다.
  it('안 읽음 표시가 안 읽은 줄에만 붙는다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1', null),
      entry(2, 'mention', 'c1', '2026-09-03T00:00:00.000Z'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();

    expect(screen.getByTestId('inbox-unread-1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-unread-2')).toBeNull();
  });

  it("'안 읽은 것' 칩으로 좁히면 이미 본 줄이 빠진다", async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1', null),
      entry(2, 'mention', 'c1', '2026-09-03T00:00:00.000Z'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('inbox-filter-unread'));
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();
    expect(screen.queryByTestId('inbox-entry-2')).toBeNull();

    // 칩의 숫자도 같은 셈을 쓴다 — 목록과 숫자가 갈리면 어느 쪽이 사실인지 알 수 없다.
    expect(screen.getByTestId('inbox-filter-unread').textContent).toContain('1');

    fireEvent.click(screen.getByTestId('inbox-filter-all'));
    expect(screen.getByTestId('inbox-entry-2')).toBeTruthy();
  });

  /**
   * 좁히지 **않고** 보는 사람에게도 새 줄이 보여야 한다 — 사람이 실제로 겪은 것은
   * '전부' 화면이었다. 줄 끝의 '· 안 읽음' 글자는 눈이 한 줄씩 끝까지 가야 보이므로,
   * 훑어 내려가며 찾을 수 있는 표시(왼쪽 선)와 물러난 본문을 함께 잰다.
   */
  it("'전부' 에서도 새 줄과 이미 본 줄이 눈으로 갈린다", async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1', null),
      entry(2, 'mention', 'c1', '2026-09-03T00:00:00.000Z'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const fresh = screen.getByTestId('inbox-entry-1');
    const seen = screen.getByTestId('inbox-entry-2');
    expect(fresh.getAttribute('data-unread')).toBe('true');
    expect(seen.getAttribute('data-unread')).toBe('false');
    // 새 줄에만 색이 든 선이 선다. 읽은 줄도 같은 두께의 투명한 선을 둬 글자가 안 밀린다.
    expect(fresh.className).toContain('border-accent');
    expect(seen.className).toContain('border-transparent');
  });

  // 4. 채널 필터 `select` 도 사라졌다(#488 B3). UI 가 없으면 그것을 누르던 테스트는 잴
  //    것이 없어 무효다 — 상태(`channelFilter`)는 나중에 되살릴 수 있게 코드에 남아 있지만
  //    화면에서 닿을 길이 없는 것을 화면 테스트가 재는 척할 수는 없다.
  //
  //    채널이 사라진 것이 아니라 **줄로 들어갔다.** 문서가 줄에 요구한 넷 중 '언제·어디'가
  //    그것이다 — 좁혀서 알아내던 것을 이제 줄이 직접 말한다. 그것을 대신 잰다.
  it('줄이 자기 채널을 말한다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1'), entry(2, 'mention', 'c2')]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    expect(screen.getByTestId('inbox-entry-1').textContent).toContain('#general');
    expect(screen.getByTestId('inbox-entry-1').textContent).not.toContain('#random');
    expect(screen.getByTestId('inbox-entry-2').textContent).toContain('#random');
  });

  // 5. 초안. 공백만 남은 초안은 쓰다 만 답글이 아니라 흔적이다 — 그것을 항목으로 내면
  //    목록이 처리할 것이 있다고 거짓말한다.
  it('내용이 있는 초안은 항목으로 뜨고, 빈 초안은 뜨지 않는다', async () => {
    fakeController();
    useAppStore.getState().set({ drafts: { c1: '쓰다 만 답글', c2: '   ' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy());
    expect(screen.getByTestId('inbox-draft-c1').textContent).toContain('쓰다 만 답글');
    expect(screen.queryByTestId('inbox-draft-c2')).toBeNull();
  });

  // 6. 하나는 남이 나를 부른 것이고 하나는 내가 쓰다 만 것이다. 한 목록에 섞이면 목록이
  //    무엇을 말하는지 알 수 없다 — 구획이 갈려 있고 초안에 글자 표가 붙어야 한다.
  it('초안 항목이 inbox 항목과 구분돼 보인다', async () => {
    fakeController(async () => [entry(1, 'mention', 'c1')]);
    useAppStore.getState().set({ drafts: { c1: '쓰다 만 답글' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const called = screen.getByRole('region', { name: '나를 부른 것' });
    const draftBox = screen.getByRole('region', { name: '쓰다 만 초안' });
    expect(within(called).getByTestId('inbox-entry-1')).toBeTruthy();
    expect(within(called).queryByTestId('inbox-draft-c1')).toBeNull();
    expect(within(draftBox).getByTestId('inbox-draft-c1')).toBeTruthy();
    expect(within(draftBox).queryByTestId('inbox-entry-1')).toBeNull();
    // 구획이 갈린 것만으로는 부족하다 — 행 자체가 무엇인지 말해야 한다.
    expect(screen.getByTestId('inbox-draft-badge-c1').textContent).toBe('초안');
  });

  // 7. 실패를 빈 목록으로 삼키면 "아무도 나를 부르지 않았다" 는 거짓말이 된다.
  it('조회 실패가 "없다"가 아니라 오류로 보인다', async () => {
    fakeController(async () => { throw new Error('boom'); });
    open();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('boom');
    expect(screen.queryByText('나를 부른 것이 없다')).toBeNull();
  });

  it('부른 것이 없으면 "없다"를 보여 준다', async () => {
    fakeController(async () => []);
    open();
    await waitFor(() => expect(screen.getByText('나를 부른 것이 없다')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // 이동 경로는 #178·#228 이 이미 만든 것을 쓴다. 새로 만들면 실패 처리가 갈라진다.
  it('항목을 누르면 그 메시지로 간다', async () => {
    const c = fakeController(async () => [entry(7, 'mention', 'c1')]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-7')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inbox-entry-7'));
    expect(c.openMessage).toHaveBeenCalledWith('m7');
  });

  // 스레드 초안의 scopeKey 에 든 rootId 는 메시지 id 다 — openMessage 가 채널까지 연다.
  it('스레드 초안을 누르면 그 스레드 루트로 간다', async () => {
    const c = fakeController();
    useAppStore.getState().set({ drafts: { 'thread:root-1': '답글 쓰다 말았다' } });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-thread:root-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inbox-draft-thread:root-1'));
    expect(c.openMessage).toHaveBeenCalledWith('root-1');
  });

  // 아무도 열 수 없는 화면은 없는 화면과 같다. #226 의 디렉터리와 **같은 방식으로** 연다 —
  // 사이드바 항목이 뷰를 연다. 화면마다 여는 방식이 다르면 다음 화면이 어느 쪽을 따를지 모른다.
  it('사이드바에서 인박스로 갈 수 있다', () => {
    fakeController();
    useAppStore.getState().set({ me: acc('u1', 'alice') });
    const onOpenInbox = vi.fn();
    render(
      <Sidebar panel="home"
        onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()}
        onOpenInbox={onOpenInbox} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false}
        onToggleCollapse={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Inbox'));
    expect(onOpenInbox).toHaveBeenCalled();
  });

  // 칩으로 좁히면 초안은 빠진다 — 초안은 남이 나를 부른 것이 아니라 내가 쓰다 만 것이라
  // '나를 막는 것'도 '읽을 것'도 아니다. 좁혔는데 초안이 남아 있으면 그 목록은 자기가
  // 무엇인지 답하지 못한다. (채널 필터 부분은 그 UI 와 함께 사라졌다 — 위 4번 참고.)
  it('칩으로 좁히면 초안 구획이 빈다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    fakeController(async () => [entry(1, 'mention', 'c1', null, { meta: askMeta(2) })]);
    useAppStore.getState().set({
      drafts: { c1: 'c1 초안', c2: 'c2 초안' },
      messages: { c1: [msg('root-1', 'c1', 1, '루트')] },
    });
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy());
    expect(screen.getByTestId('inbox-draft-c2')).toBeTruthy();

    fireEvent.click(screen.getByTestId('inbox-filter-blocking'));
    expect(screen.queryByTestId('inbox-draft-c1')).toBeNull();
    expect(screen.queryByTestId('inbox-draft-c2')).toBeNull();
    // 좁힌 것이 초안만 지운 것이 아니라는 확인 — 걸리는 줄은 남아 있어야 한다.
    expect(screen.getByTestId('inbox-entry-1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('inbox-filter-reading'));
    expect(screen.queryByTestId('inbox-draft-c1')).toBeNull();

    fireEvent.click(screen.getByTestId('inbox-filter-all'));
    expect(screen.getByTestId('inbox-draft-c1')).toBeTruthy();
  });
});

/**
 * 여기부터는 #488 C2 가 화면에 새로 요구한 것들이다.
 *
 * `lib/inboxRow` 의 테스트가 **무엇이 무슨 말인가**를 지킨다. 이 구획이 지키는 것은 그
 * 판정이 **실제로 화면에 닿는가**다 — 판정이 옳아도 줄이 그것을 안 그리면 문서가 고치려던
 * "네 줄이 똑같다"는 그대로 남는다. 둘은 다른 실패라서 다른 자리에서 잰다.
 */
describe('Inbox 줄이 무엇을 말하는가 (#488 C2)', () => {
  /**
   * **줄은 네 가지를 말한다** — 누가(얼굴) · 무슨 말(말표) · 무엇을(본문 한 줄) ·
   * 언제·어디. 문서: *"지금 줄에는 이 중 어느 것도 없다."* 넷 중 하나라도 빠지면 줄은
   * 다시 알림 한 줄로 돌아간다.
   */
  /**
   * **본문 자리에 uuid 가 오면 "무엇을" 이 없는 것과 같다.** 2026-09-08 실측: 서버가 싣는
   * 본문은 정본 형식(`<@id>`)이고, 이 줄은 `MessageBody` 를 지나지 않아 그 치환을 못 받아
   * 142줄 전부가 `<@2c8c1910-da9c-…>` 로 보였다 — 나를 부른 것이 무슨 말인지 알 수 없다.
   *
   * 그래서 문자열 함수만 단언하지 않고 **줄을 실제로 렌더한다**: `bodyWithHandles` 를
   * 단독으로 재면 인박스가 그것을 부르지 않아도 초록이고, 그때 화면은 다시 uuid 다.
   */
  it('본문의 <@id> 가 지금의 handle 로 보인다 (uuid 가 아니다)', async () => {
    // 토큰 문법은 uuid 만 받는다(`MENTION_TOKEN_PATTERN`) — fixture 의 `u1` 같은 짧은
    // id 로는 이 결함이 재현되지 않는다. 서버가 싣는 것과 같은 모양을 쓴다.
    const BOB = '2c8c1910-da9c-47bc-a483-ce41a1217d85';
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice'), [BOB]: acc(BOB, 'bob') } });
    fakeController(async () => [
      entry(1, 'mention', 'c1', null, { body: `<@${BOB}> 배포 로그 봐 줄 수 있나` }),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const row = screen.getByTestId('inbox-entry-1');
    expect(row.textContent).toContain('@bob 배포 로그 봐 줄 수 있나');
    expect(row.textContent).not.toContain(`<@${BOB}>`);
  });

  it('줄이 얼굴·말표·본문·언제어디를 함께 말한다', async () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'alice') } });
    fakeController(async () => [
      entry(1, 'mention', 'c1', null, {
        body: '배포 로그를 봐 줄 수 있나',
        createdAt: '2024-03-04T05:06:07.000Z',
        threadRootId: 'root-1',
      }),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const row = screen.getByTestId('inbox-entry-1');
    // 누가 — 얼굴이 이름을 대신한다. 사진이 있으면 사진, 없으면 머리글자다. 어느 쪽이든
    // `Identity` 는 handle 을 `sr-only` 로 함께 낸다 — 사진의 유무는 이 테스트가 잴 것이
    // 아니고, 잰다면 첨부 로딩까지 끌고 들어와 무엇이 깨졌는지 흐려진다.
    expect(within(row).getByText('alice')).toBeTruthy();
    // 무슨 말.
    expect(screen.getByTestId('inbox-reason-1').textContent).toBeTruthy();
    // 무엇을 — 본문 한 줄.
    expect(row.textContent).toContain('배포 로그를 봐 줄 수 있나');
    // 언제·어디. 시각의 표기는 로케일이 정하므로 연도만 본다 — 무엇을 재는지 흐리지 않고
    // "시각이 있다"만 잰다.
    expect(row.textContent).toContain('#general');
    expect(row.textContent).toContain('스레드');
    expect(row.textContent).toContain('2024');
  });

  /**
   * **선택은 줄에서 끝난다.** 문서: *"스레드를 열어야만 답할 수 있으면 인박스는 알림
   * 목록일 뿐이고, 컨셉이 말한 '막는 말을 푸는 자리'가 되지 못한다."*
   *
   * 그래서 `answerAsk` 가 불리는 것만으로는 부족하다 — **스레드가 열리지 않는 것**까지가
   * 이 요구다. 답하려다 화면이 넘어가면 자리는 다시 알림 목록이 된다.
   */
  it('선택지가 둘이면 줄에서 바로 답하고, 스레드는 열리지 않는다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    const c = fakeController(async () => [
      entry(1, 'mention', 'c1', null, { meta: askMeta(2) }),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-answer-1-o1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('inbox-answer-1-o1'));
    await waitFor(() => expect(c.answerAsk).toHaveBeenCalledWith('m1', 'o1', 'c1'));
    expect(c.openMessage).not.toHaveBeenCalled();
  });

  /**
   * 셋 이상은 줄에서 안 고른다 — 줄이 버튼 밭이 되면 목록이 목록이 아니게 된다. 문서가
   * 허락한 것은 *"선택지가 둘뿐이면"* 이다. 줄은 그래도 자기가 선택이라고 말해야 하므로
   * 말표는 남고, 고르는 것만 스레드로 미룬다.
   */
  it('선택지가 셋이면 줄에 버튼이 없다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    fakeController(async () => [entry(1, 'mention', 'c1', null, { meta: askMeta(3) })]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    for (const o of ['o0', 'o1', 'o2']) {
      expect(screen.queryByTestId(`inbox-answer-1-${o}`)).toBeNull();
    }
    // 버튼이 없다고 줄까지 조용해지면 안 된다 — 여전히 나를 막는 선택이다.
    expect(screen.getByTestId('inbox-entry-1').getAttribute('data-rank')).toBe('0');
  });

  /**
   * **정렬은 막는 순이다.** 문서: *"시간순이 아니라 나를 막는 것 → 읽을 것 → 배경."*
   *
   * 그래서 fixture 는 시간을 **일부러 거꾸로** 둔다: 막는 것이 가장 오래됐고 배경이 가장
   * 새것이다. 시간이 첫 축이면 순서가 정확히 뒤집히므로, 이 배치라야 두 규칙이 갈린다.
   */
  it('막는 것이 시간상 더 오래됐어도 위에 온다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    fakeController(async () => [
      // 가장 새것이지만 배경이다.
      entry(3, 'thread_reply', 'c1', null, { createdAt: '2024-03-03T00:00:00.000Z' }),
      // 중간이고 읽을 것이다.
      entry(2, 'mention', 'c1', null, { createdAt: '2024-02-02T00:00:00.000Z' }),
      // 가장 오래됐지만 나를 막는다.
      entry(1, 'mention', 'c1', null, {
        createdAt: '2024-01-01T00:00:00.000Z', meta: askMeta(2),
      }),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const order = [...screen.getByRole('region', { name: '나를 부른 것' })
      .querySelectorAll('[data-rank]')]
      .map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['inbox-entry-1', 'inbox-entry-2', 'inbox-entry-3']);
  });

  /**
   * 같은 rank 안에서는 **최근이 위**다. 위 테스트가 rank 를 지키고 이것이 그 안의 시간을
   * 지킨다 — 함께 있어야 "rank 만 보고 시간은 아무렇게나"가 통과하지 않는다.
   */
  it('같은 rank 안에서는 최근이 위다', async () => {
    fakeController(async () => [
      entry(1, 'mention', 'c1', null, { createdAt: '2024-01-01T00:00:00.000Z' }),
      entry(2, 'mention', 'c1', null, { createdAt: '2024-05-05T00:00:00.000Z' }),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    const order = [...screen.getByRole('region', { name: '나를 부른 것' })
      .querySelectorAll('[data-rank]')]
      .map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['inbox-entry-2', 'inbox-entry-1']);
  });

  /**
   * 칩이 개수를 말한다(문서의 *"나를 막는 것 2 · 읽을 것 2"*). 개수가 없으면 좁히기 전에는
   * 무엇이 나를 기다리는지 알 수 없어 칩을 하나씩 눌러 봐야 한다.
   *
   * 개수는 **좁히기 전 전체**를 세야 한다 — 지금 보이는 것을 세면 '막는 것'으로 좁힌 순간
   * '읽을 것'이 0 이 되어 칩이 자기를 눌러야 할 이유를 스스로 지운다.
   */
  it('칩이 개수를 말하고, 좁혀도 그 수가 변하지 않는다', async () => {
    useAppStore.getState().set({ me: acc('u-me', 'me') });
    fakeController(async () => [
      entry(1, 'mention', 'c1', null, { meta: askMeta(2) }),
      entry(2, 'mention', 'c1', null, { meta: askMeta(2) }),
      entry(3, 'mention', 'c1'),
      entry(4, 'thread_reply', 'c1'),
    ]);
    open();
    await waitFor(() => expect(screen.getByTestId('inbox-entry-1')).toBeTruthy());

    expect(screen.getByTestId('inbox-filter-blocking').textContent).toContain('2');
    expect(screen.getByTestId('inbox-filter-reading').textContent).toContain('1');

    fireEvent.click(screen.getByTestId('inbox-filter-blocking'));
    expect(screen.getByTestId('inbox-filter-blocking').textContent).toContain('2');
    expect(screen.getByTestId('inbox-filter-reading').textContent).toContain('1');
  });
});
