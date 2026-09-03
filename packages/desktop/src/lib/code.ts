/**
 * 본문에서 **코드만** 떼어낸다(#216).
 *
 * 이 함수는 `@murmur/shared` 에서 제공한다 — 서버와 같은 함수를 써야 판정이 한 벌이다(#298).
 * 여기는 호환을 위해 같은 코드를 다시 export 한다.
 */
export { splitCode, type CodeSegment } from '@murmur/shared';