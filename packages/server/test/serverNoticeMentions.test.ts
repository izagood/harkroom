import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { plainNoticeText } from '../src/services/noticeText.js';

/**
 * 서버 알림 줄의 멘션 원칙(services/noticeText.ts, 소유자 결정 2026-11-03 A안) — 호출 자리 표.
 *
 * 서버가 세우는 시스템·알림 줄(`kind: 'system'`·`serverNotice: true`)을 새로 쓰면 이 표에 이유와 함께 올려야 통과한다.
 * - `noMentions`: 남이 쓴 글이 섞인다 → `noMentions: true` 가 그 줄에 있어야 한다.
 * - `muted`: 일부러 한 사람을 부르는 줄 → 남이 쓴 조각만 `plainNoticeText` 로 감싼다.
 * - `serverOnly`: 본문이 서버 값(고정 문구·handle·정규식을 지난 id·sha)뿐이다.
 *
 * 한계: `kind: 'system'`·`serverNotice: true` 가 **같은 줄에 글자로** 있을 때만 찾는다 — 변수·helper 로 넘기면 놓친다.
 * 그런 꼴로 새 줄을 쓰면 이 표에 손으로 올린다.
 */
const TABLE: Record<string, { sites: number; noMentions: number; muted?: number; why: string }> = {
  'src/mcp/mcpPlugin.ts': { sites: 1, noMentions: 0, why: 'serverOnly — 러너 알림(runnerNotice): 고정 문구 + HANDLE_RE 를 지난 handle' },
  'src/routes/channelRoutes.ts': { sites: 1, noMentions: 0, why: 'serverOnly — 멤버 들고남 줄: handle 만' },
  'src/routes/threadAgentModelRoutes.ts': { sites: 1, noMentions: 1, why: 'noMentions(덧댄 한 겹) — model·effort, 앞 단 AXIS_PATTERN 이 @ 를 막는다' },
  'src/services/apiCalls.ts': { sites: 1, noMentions: 1, why: 'noMentions — 요청 경로·연결 이름' },
  'src/services/apiDelegation.ts': { sites: 1, noMentions: 0, muted: 1, why: 'muted — 루트를 일부러 부름, 연결 이름·경로만 무력화' },
  'src/services/blockedCards.ts': { sites: 1, noMentions: 1, why: 'noMentions(덧댄 한 겹) — 경로는 cardPath(백틱 거절)·코드 구간, 이름은 정규식' },
  'src/services/chainBackstop.ts': { sites: 1, noMentions: 0, why: 'serverOnly — 백스톱 수·handle(＠ 무력화)' },
  'src/services/chatApproval.ts': { sites: 1, noMentions: 1, why: 'noMentions(덧댄 한 겹) — 규칙 원문·채널 이름, 앞 단 plain()(@→＠)·코드 구간' },
  'src/services/mergeGrants.ts': { sites: 2, noMentions: 0, why: 'serverOnly — repo·번호·sha·handle, 래퍼 오류 문구는 meta 에만(N2)' },
  'src/services/permissionRequests.ts': { sites: 2, noMentions: 0, muted: 1, why: 'muted — 소유자를 일부러 부름, 대상(target)만 무력화(채널 줄과 DM 이 같은 본문)' },
  'src/services/secretCreate.ts': { sites: 1, noMentions: 0, muted: 1, why: 'muted — 소유자를 일부러 부름, 비밀 이름만 무력화' },
  'src/services/skills.ts': { sites: 1, noMentions: 0, why: 'serverOnly — 스킬 slug(정규식)·검사 사유 라벨' },
  'src/services/threadPlanAuto.ts': { sites: 1, noMentions: 1, why: 'noMentions — 자동 진행 켜짐·꺼짐 줄(고정 문구·id)' },
  'src/services/threadPlanWatcher.ts': { sites: 1, noMentions: 1, why: 'noMentions — 계획판(본문 고정, 두 겹)' },
};

const SITE = /kind: 'system'[,} ]|serverNotice: true/;
const root = path.resolve(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === 'db' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

function scan(): Record<string, { sites: number; noMentions: number; muted: number }> {
  const out: Record<string, { sites: number; noMentions: number; muted: number }> = {};
  for (const file of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l) && SITE.test(l) && !l.includes("kind: 'system'; meta"));
    if (!lines.length) continue;
    out[rel] = {
      sites: lines.length,
      noMentions: lines.filter((l) => l.includes('noMentions: true')).length,
      muted: (src.match(/plainNoticeText\(/g) ?? []).length,
    };
  }
  return out;
}

describe('서버 알림 줄 멘션 원칙 — 호출 자리 표', () => {
  it('서버 알림 줄을 쓰는 곳은 전부 표에 있고, 분류대로 막혀 있다', () => {
    const found = scan();
    expect(
      Object.keys(found).sort(),
      '서버 알림 줄 호출 자리가 바뀌었다 — test/serverNoticeMentions.test.ts 표에 이유와 함께 올리고 services/noticeText.ts 원칙대로 막아라',
    ).toEqual(Object.keys(TABLE).sort());
    for (const [file, want] of Object.entries(TABLE)) {
      expect(found[file]!.sites, `${file}: 호출 자리 수`).toBe(want.sites);
      expect(found[file]!.noMentions, `${file}: noMentions 수 (${want.why})`).toBe(want.noMentions);
      if (want.muted) expect(found[file]!.muted, `${file}: plainNoticeText (${want.why})`).toBeGreaterThanOrEqual(want.muted);
    }
  });

  it('plainNoticeText 는 @ 를 모두 무력화한다(멘션 토큰 꼴 포함)', () => {
    expect(plainNoticeText('@channel <@0000> <@team:x> a@b')).toBe('＠channel <＠0000> <＠team:x> a＠b');
  });
});
