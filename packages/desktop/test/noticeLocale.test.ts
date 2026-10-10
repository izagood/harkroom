import { afterEach, describe, expect, it } from 'vitest';
import { nowT } from '../src/i18n/useT';
import { usePrefsStore } from '../src/state/prefsStore';
import { useCommunityRegistry } from '../src/state/communities';

/**
 * 상태층·lib 이 띄우는 알림도 **앱 언어**로 선다(i18n P3-h). 전에는 `pushNotice('Could not pin…')` 처럼
 * 영어로 박혀, 한국어로 고른 사람의 화면 위 띠만 영어였다. `nowT()` 는 부를 때마다 지금 언어를 읽는다.
 */
describe('nowT — React 밖의 번역기', () => {
  afterEach(() => usePrefsStore.getState().setLocale('system'));

  it('고른 언어를 따르고, 언어를 바꾸면 다음 알림부터 바뀐다', () => {
    usePrefsStore.getState().setLocale('ko');
    expect(nowT()('notice.pinFailed')).toBe('그 메시지를 고정하지 못했다. 연결을 확인하고 다시 해 봐라.');
    usePrefsStore.getState().setLocale('en');
    expect(nowT()('notice.pinFailed')).toBe('Could not pin that message. Check your connection and try again.');
  });

  it('마지막 커뮤니티를 빼려 할 때 던지는 말(설정 화면에 그대로 뜬다)도 고른 언어다', () => {
    usePrefsStore.getState().setLocale('ko');
    const only = useCommunityRegistry.getState().entries;
    expect(only.length).toBe(1);
    expect(() => useCommunityRegistry.getState().remove(only[0]!.id)).toThrow('마지막 커뮤니티는 뺄 수 없다.');
  });
});
