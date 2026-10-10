import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * **OS 알림을 누르면 설정이 닫힌다**(2026-10-02, designer 후속). 사람은 그 메시지를 보려고 누른
 * 것이다. 설정이 열린 채 커뮤니티만 바뀌면 메시지는 안 보이고, 설정은 말없이 다른 커뮤니티의
 * 값이 된다 — 그 상태에서 저장한 에이전트 사진이 남의 서버로 갔다.
 *
 * App 을 `ready` 까지 띄우려면 세션·서버 전체를 흉내 내야 해서, 배선 한 줄을 소스에서 잰다.
 */
const src = readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');

describe('App — 알림 클릭', () => {
  it('알림 클릭 콜백이 설정을 닫은 뒤 그 대화를 연다', () => {
    const m = /useNotificationOpen\(\(target\) => \{([\s\S]*?)\}\);/.exec(src);
    expect(m, 'useNotificationOpen 콜백을 찾지 못했다').toBeTruthy();
    const body = m![1]!;
    const close = body.indexOf('setSettings(null)');
    const open = body.indexOf('openNotificationTarget(target)');
    expect(close).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(close);
  });
});
