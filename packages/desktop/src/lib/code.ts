/**
 * 본문에서 **코드만** 떼어낸다(#216).
 *
 * 구현은 `@murmur/shared` 에 있다 — 서버의 알림 판정과 **같은 함수**여야 코드 안의
 * `@handle` 에서 화면과 알림이 갈라지지 않는다(#298). 여기는 데스크탑 쪽 import 경로를
 * 유지하기 위한 재수출일 뿐이고, **복사본이 아니다.** 이 파일에 판정을 다시 적으면
 * #298 이 없앤 두 벌이 그대로 돌아온다.
 */
export { splitCode, stripCodeSpans, type CodeSegment } from '@murmur/shared';
