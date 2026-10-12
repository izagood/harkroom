import type { InboxBatch } from './harkroom.js';

/**
 * 빈 폴 뒤에 볼 **종료 요청 시각**(#129)을 정한다(2026-10-12 inbox 호출 설계 A).
 *
 * 전에는 빈 폴마다 `GET /agent/config` 를 한 번 더 불렀다 — 조용한 러너도 종료 요청을 보게 하려고. 에이전트마다
 * 25초에 REST 왕복 하나다. 새 서버는 빈 폴 응답에 `stopRequestedAt` 을 **늘** 싣고(요청이 없으면 `null`), 수령
 * 기록도 그쪽에서 남긴다. 그래서 키가 **있으면** 그 값을 쓰고 왕복하지 않는다.
 *
 * 키가 **없으면**(옛 서버) 전처럼 정의를 읽는다 — `null` 과 「키 없음」을 가르는 것이 이 함수의 전부다. 둘을
 * 섞으면 옛 서버에 붙은 러너가 종료 요청을 영영 못 본다.
 */
export async function idleStopRequestedAt(
  batch: Pick<InboxBatch, 'stopRequestedAt'>,
  readDefinition: () => Promise<{ stopRequestedAt?: string | null }>,
): Promise<string | null> {
  if ('stopRequestedAt' in batch && batch.stopRequestedAt !== undefined) return batch.stopRequestedAt;
  return (await readDefinition()).stopRequestedAt ?? null;
}
