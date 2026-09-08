import { ApiError } from './api';

/**
 * 프로필 사진 고르기에 쓰는 `accept` 목록. **서버 판정과 같은 집합이어야 한다**
 * (`server/src/services/avatars.ts`).
 *
 * 두 화면(내 프로필·에이전트)이 같은 문자열을 각자 적고 있었고, 그래서 한쪽만 고치면
 * 조용히 어긋난다. 어긋남의 방향 중 나쁜 쪽은 **여기가 서버보다 좁을 때**다: 서버가 받아 줄
 * 파일이 파일 창에서 회색으로 죽고, 고를 수 없는 파일은 오류 메시지도 낼 수 없다 —
 * 사람에게는 버튼을 눌렀는데 아무 일도 일어나지 않은 것으로 보인다.
 */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml';

/** 같은 사실을 사람 말로 적은 것. 화면이 버튼 옆에 그대로 보여 준다. */
export const AVATAR_FORMATS = 'PNG · JPEG · GIF · WEBP · AVIF · SVG';

/**
 * 사진을 걸지 못한 이유를 사람 말로 바꾼다.
 *
 * **원인별로 다른 문장을 낸다.** 이전에는 무엇이 실패했든 "이미지 파일만 쓸 수 있습니다"
 * 하나였다 — 서버가 죽었거나 네트워크가 끊겼을 때도 사용자에게는 자기 파일 탓으로 보이고,
 * 파일을 바꿔 가며 몇 번을 다시 시도하게 만든다.
 */
export function avatarErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // 서버가 바이트를 보고 거절했다. 확장자를 믿지 않으므로 `.png` 라는 이름만으로는 통과하지 못한다.
    if (err.code === 'not_an_image') return `${AVATAR_FORMATS} 파일만 쓸 수 있습니다. 파일 이름이 아니라 내용으로 판정합니다.`;
    if (err.code === 'too_large') return '파일이 너무 큽니다. 더 작은 이미지를 골라 주세요.';
    if (err.code === 'not_found') return '업로드한 파일을 찾지 못했습니다. 다시 시도해 주세요.';
    return `사진을 바꾸지 못했습니다 (${err.code}).`;
  }
  return '사진을 바꾸지 못했습니다. 서버에 연결하지 못했을 수 있습니다.';
}
