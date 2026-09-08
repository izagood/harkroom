/**
 * `#460` 회귀선 — **키체인 승인을 기다리는 동안 화면이 무슨 일인지 말한다.**
 *
 * ## 무엇이 문제였나 — 36분간 아무 말도 없었다 (실측 2026-09-05)
 *
 * 키체인 승인 대화상자가 뜬 채로 앱이 대기했고, 그동안 화면은 이 한 줄이었다:
 *
 * ```
 * Connecting…
 * ```
 *
 * **두 가지가 틀렸다.** 서버에 접속하고 있지 않았고(아직 세션도 못 읽었다), 사람이 할 일
 * (시스템 대화상자를 찾아 승인)을 말하지 않았다. 사람은 36분을 기다렸고, 옆에서 누가
 * *"대화상자가 떠 있습니다"* 라고 알려 준 뒤에야 풀렸다.
 *
 * `#450` 이 고친 것은 **앱이 멎는 것**(메인 스레드 블로킹)이고 이 이슈는 **말하지 않는
 * 것**이다. 둘은 다른 문제이고 둘 다 필요하다 — `#450` 이 없었으면 사람이 대화상자를
 * 누를 수조차 없었고, 이것이 없으면 누를 대화상자가 있는 줄을 모른다.
 *
 * ## 이 파일이 재는 두 축
 *
 * 1. **말한다** — 키체인을 실제로 두드렸고 대기가 길어지면 사유와 **할 일**이 화면에 온다
 * 2. **대조군: 사라진다** — 대기가 끝나면(또는 애초에 키체인이 아니면) 그 문구가 없다
 *
 * 대조군이 없으면 "언제나 승인을 기다린다고 말하는" 화면으로도 통과한다. 그것은 정상
 * 기동마다 없는 대화상자를 찾게 만들고, 곧 사람이 이 문구를 통째로 무시하게 만든다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  BootNotice,
  keychainWaitTitle,
  keychainWaitHint,
  KEYCHAIN_NOTICE_DELAY_MS,
} from '../src/components/BootNotice';
import { sessionStore } from '../src/lib/session';
import { usePrefsStore } from '../src/state/prefsStore';
import { translator } from '../src/i18n';

/**
 * **언어를 한국어로 고정한다.** 이 파일이 재는 것은 언어가 아니라 그 언어로 표현된
 * 규율이다 — 사유만이 아니라 **할 일**까지 말하는가(`대화상자` 를 잰다). 문구가 사전을
 * 지나게 된 뒤(i18n 이전)에도 그 규율은 그대로여야 하므로, 문구를 지우는 대신 언어를
 * 못 박는다. `gallery.test.tsx`·`skillsSettings.test.tsx` 가 세운 그 선례다.
 */
const t = translator('ko');
const TITLE = keychainWaitTitle(t);
const HINT = keychainWaitHint(t);

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  usePrefsStore.getState().setLocale('system');
});

describe('부팅 문구 — 무엇을 기다리는지 말한다 (#460)', () => {
  /**
   * **되돌려 RED**: `BootNotice` 의 `{speaking && …}` 블록을 지우면(= 앞 판본의
   * `<div>Connecting…</div>` 한 줄) 이 단언 셋이 전부 빨개진다. 실제로 되돌려 실행해
   * 확인했다.
   */
  it('키체인 대기가 길어지면 사유와 할 일을 말한다', () => {
    vi.useFakeTimers();
    render(<BootNotice wait="keychain" />);

    // 유예 안에서는 아직 아무 말도 안 한다(아래 대조군이 그 자리를 잰다).
    act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS + 1); });

    expect(screen.getByText(TITLE)).toBeTruthy();
    // **사유만으로는 부족하다.** "기다리는 중"만 말하면 사람은 기다리면 되는 줄 알고,
    // 그것이 36분이 된 경로다. 어디를 봐야 하는지가 이 이슈의 답이다.
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(HINT).toContain('대화상자');
    // 화면 밖 사람에게도 닿아야 한다 — 이 이슈의 본질이 "말하지 않는다"이다.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  /**
   * **대조군 ① — 유예 안에서는 말하지 않는다.**
   *
   * 승인이 캐시돼 있으면 키체인 읽기는 눈 깜빡할 사이에 끝난다. 그때도 문구를 세우면
   * 정상 기동마다 "승인을 기다린다"가 번쩍이고, 그것은 사실이 아니다.
   *
   * **되돌려 RED**: 유예(`setTimeout`)를 없애고 곧바로 말하게 하면 빨개진다.
   */
  it('대조군 — 대기가 짧으면 아무 사유도 말하지 않는다', () => {
    vi.useFakeTimers();
    render(<BootNotice wait="keychain" />);

    act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS - 1); });

    expect(screen.queryByText(TITLE)).toBeNull();
    // 아는 것은 그대로 말한다 — 화면이 비지는 않는다.
    expect(screen.getByText('Connecting…')).toBeTruthy();
  });

  /**
   * **대조군 ② — 대기가 끝나면 사라진다.**
   *
   * 이것이 없으면 "한 번 뜨면 계속 남아 있는" 문구로도 통과한다. 그러면 사람은 승인을
   * 누른 뒤에도 없는 대화상자를 계속 찾는다 — 이 이슈보다 나쁜 상태다.
   */
  it('대조군 — 대기가 끝나면 문구가 사라진다', () => {
    vi.useFakeTimers();
    const { rerender } = render(<BootNotice wait="keychain" />);
    act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS + 1); });
    expect(screen.getByText(TITLE)).toBeTruthy();

    // 키체인이 답했다 — `App` 이 `sessionStore.load()` 뒤에 `'unknown'` 으로 되돌린다.
    rerender(<BootNotice wait="unknown" />);
    act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS * 10); });

    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  /**
   * **대조군 ③ — 사유를 모르면 지어내지 않는다.**
   *
   * 키체인을 아예 안 두드린 경우다(브라우저 개발·폴백 경로). 그때 부팅이 느린 것은
   * 다른 사정이고, 여기서 키체인을 골라 적는 것이 정확히 `#368` 이 막는 짓이다.
   *
   * **되돌려 RED**: 화면 쪽에서 "부팅이 오래 걸리면 키체인이겠지"로 추측하게 만들면
   * (= `wait` 을 안 보고 타이머만 보게 하면) 빨개진다.
   */
  it('대조군 — 키체인이 아니면 아무리 오래 걸려도 키체인 이야기를 안 한다', () => {
    vi.useFakeTimers();
    render(<BootNotice wait="unknown" />);

    act(() => { vi.advanceTimersByTime(KEYCHAIN_NOTICE_DELAY_MS * 100); });

    expect(screen.queryByText(TITLE)).toBeNull();
    expect(screen.getByText('Connecting…')).toBeTruthy();
  });
});

describe('신호의 근거 — sessionStore 가 실제로 두드릴 때만 알린다 (#460)', () => {
  /**
   * 화면이 말하는 근거는 **관측**이어야 한다(`#431`: "판단하지 않는다. 관측을 노출한다").
   * 이 회귀선이 그 근거가 실제로 `secret_get` 호출과 묶여 있는지 잰다.
   *
   * **되돌려 RED**: `session.ts` 의 `onKeychainWait?.()` 한 줄을 지우면 빨개진다.
   */
  it('키체인 경로에서는 두드리기 직전에 알린다', async () => {
    const calls: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn(async (cmd: string) => {
        calls.push(cmd);
        return null;
      }),
    });

    const onWait = vi.fn(() => {
      // **부르기 직전이다** — 이 시점에 아직 `secret_get` 이 안 나갔어야 사람이 그
      // 왕복이 시작되는 것을 보게 된다.
      expect(calls).toEqual([]);
    });
    await sessionStore.load(onWait);

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(calls).toContain('secret_get');
  });

  /**
   * **대조군 — 폴백 경로에서는 알리지 않는다.**
   *
   * Tauri 가 없으면 `localStorage` 를 읽고 키체인은 아예 안 두드린다. 그때 이 신호가
   * 오면 화면은 없는 대화상자를 찾으라고 말하게 된다.
   */
  it('대조군 — Tauri 가 없으면 키체인 신호가 오지 않는다', async () => {
    const onWait = vi.fn();
    await sessionStore.load(onWait);
    expect(onWait).not.toHaveBeenCalled();
  });
});
