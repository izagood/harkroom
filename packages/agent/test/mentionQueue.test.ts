// #337 — 사람이 조종 중인 스레드의 멘션 대기열 장부.
//
// 실제 큐는 서버 inbox 다(스펙 §5-2 결정 6: markRead 도 attempts 도 없이 건너뛰면
// at-least-once 가 그대로 큐가 된다). 이 모듈이 드는 것은 큐가 아니라 **장부** 둘뿐이다:
// ① 어느 entry 를 이미 통지했는가(재폴링마다 같은 멘션에 "대기 중" 이 또 붙으면 안 된다)
// ② 대기 중인 멘션의 최소 seq(인터랙티브 종료 시 lastFedSeq 클램프 — §5-2 결정 7).
import { describe, expect, it } from 'vitest';
import { MentionQueue } from '../src/mentionQueue.js';

describe('#337 MentionQueue', () => {
  it('처음 유예된 entry 는 통지 대상이고, 같은 entry 의 재폴링은 아니다', () => {
    const q = new MentionQueue();
    const first = q.defer('c1/m1', 10, 42);
    expect(first).toEqual({ shouldNotify: true, pending: 1 });

    // inbox 는 at-least-once 라 같은 entry 가 다음 배치에 또 온다 — 통지가 또 붙으면
    // 조종이 길어질수록 스레드가 "대기 중" 도배가 된다.
    const again = q.defer('c1/m1', 10, 42);
    expect(again).toEqual({ shouldNotify: false, pending: 1 });
  });

  it('N 은 entry 집합의 크기다 — 두 번째 멘션은 대기 2건째다', () => {
    const q = new MentionQueue();
    q.defer('c1/m1', 10, 42);
    expect(q.defer('c1/m1', 11, 45)).toEqual({ shouldNotify: true, pending: 2 });
  });

  it('minSeq 는 대기 멘션의 최소 seq 다 — lastFedSeq 클램프의 재료(§5-2 결정 7)', () => {
    const q = new MentionQueue();
    expect(q.minSeq('c1/m1')).toBeNull();
    q.defer('c1/m1', 11, 45);
    q.defer('c1/m1', 10, 42);
    expect(q.minSeq('c1/m1')).toBe(42);
    // 스레드가 다르면 장부도 다르다.
    expect(q.minSeq('c1/other')).toBeNull();
  });

  it('인터랙티브가 끝나면 key 를 지운다 — 다음 조종 때 통지가 다시 1회부터 시작한다', () => {
    const q = new MentionQueue();
    q.defer('c1/m1', 10, 42);
    q.clear('c1/m1');
    expect(q.minSeq('c1/m1')).toBeNull();
    // 지운 뒤 같은 entry 가 다시 유예되면(새 인터랙티브) 새 통지다 — 새로 조종을 시작한
    // 사람이 있다는 것은 새 사실이고, 옛 통지는 옛 조종의 것이다.
    expect(q.defer('c1/m1', 10, 42)).toEqual({ shouldNotify: true, pending: 1 });
  });
});
