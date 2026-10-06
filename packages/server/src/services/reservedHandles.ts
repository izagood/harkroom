/**
 * 계정을 지우면 handle 이 `deleted-…` 로 바뀐다(`accountDeletion.ts`). 이 접두는 **서버만 쓴다** —
 * 사람이 미리 `deleted-<남의 id 앞 8자>` 를 차지하면 그 사람의 삭제가 unique 위반으로 막히고,
 * 지운 사람인 척하는 이름도 된다. 계정·팀·집합이 한 네임스페이스라 셋 다 이 검사를 지난다.
 */
export const DELETED_HANDLE_PREFIX = 'deleted-';

export function isReservedHandle(handle: string): boolean {
  return handle.toLowerCase().startsWith(DELETED_HANDLE_PREFIX);
}

/** zod `.refine` 에 그대로 넘기는 짝. */
export const notReservedHandle = [
  (h: string) => !isReservedHandle(h),
  { message: `handles starting with "${DELETED_HANDLE_PREFIX}" are reserved` },
] as const;
