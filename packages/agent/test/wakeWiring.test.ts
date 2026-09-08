import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMentionScheduler } from '../src/mentionScheduler.js';
import { TurnRegistry } from '../src/turnRegistry.js';
import { MentionQueue } from '../src/mentionQueue.js';
import type { MentionTarget } from '../src/mentionTurn.js';

/**
 * 깨움 배선의 회귀선(마이그레이션 040).
 *
 * `mentionTurn` 의 단위 테스트는 "깨어난 턴이 오면 무엇을 하는가"를 지킨다. 러너가 실제로
 * inbox 항목의 `reason === 'wake'` 를 그 인자로 **바꿔 넘기는지**는 다른 사실이다.
 *
 * **2026-09-08: 이 검사가 소스 정규식에서 실동작으로 승격됐다.** 그 배선이 `main.ts`(import
 * 불가)에서 `mentionScheduler.ts`(import 가능)로 옮겨갔기 때문이다 — 이제 스케줄러를 진짜로
 * 돌려 턴에 실린 인자를 본다. 소스를 읽는 검사는 "그 글자가 거기 있다"까지만 보증했다.
 *
 * 이 배선이 빠지면 러너는 깨움 항목을 **평범한 멘션으로** 처리한다. 그러면 델타에 남는
 * 것이 자기가 쓴 대기 줄뿐이라 프롬프트가 비고, 비면 하네스를 돌리지 않고 커서만 전진한다 —
 * 걸어 둔 기다림이 아무 흔적 없이 사라지고, 사람이 보는 스레드에는 "기다린다"는 줄만
 * 영원히 남는다. 초록으로 지나가는 실패라 소스로 못 박는다.
 */
const SRC = new URL('../src/', import.meta.url).pathname;
const readSrc = (name: string) => readFile(join(SRC, name), 'utf8');

describe('깨움 배선', () => {
  it("스케줄러가 reason === 'wake' 를 보고 턴에 사유를 싣는다", async () => {
    const targets: MentionTarget[] = [];
    const scheduler = createMentionScheduler({
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async (_d, target) => { targets.push(target); return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      hooks: {
        stopRequested: () => {},
      exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    await scheduler.admit({
      entries: [
        { id: 1, messageId: 'w1', reason: 'wake', readAt: null, channelId: 'ch-1' },
        { id: 2, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'ch-1' },
      ],
      messages: [
        { id: 'w1', seq: 1, channelId: 'ch-1', threadRootId: null, authorId: 'agent-1',
          body: '30분 뒤 CI 확인', kind: 'message', meta: null,
          createdAt: '2026-09-08T00:00:00Z', alsoInChannel: false },
        { id: 'm1', seq: 2, channelId: 'ch-1', threadRootId: null, authorId: 'human-1',
          body: '이거 봐줘', kind: 'message', meta: null,
          createdAt: '2026-09-08T00:00:00Z', alsoInChannel: false },
      ],
    } as never, { channelName: () => 'general', handles: {} });
    await scheduler.drain();

    // 사유는 그 대기 줄의 본문이다 — 서버가 wake 메시지의 body 에 사유를 넣었다(agentWakes.ts).
    expect(targets.find((t) => t.mentionId === 'w1')?.wake).toEqual({ reason: '30분 뒤 CI 확인' });
    // 평범한 멘션에는 실리지 않는다 — 실리면 사람의 부름이 깨움처럼 조립된다.
    expect(targets.find((t) => t.mentionId === 'm1')?.wake).toBeUndefined();
  });

  it('mentionTurn 이 그 사유를 프롬프트 조립에 넘긴다', async () => {
    const src = await readSrc('mentionTurn.ts');
    expect(src).toMatch(/wake:\s*target\.wake/);
  });
});
