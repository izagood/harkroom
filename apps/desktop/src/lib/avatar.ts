import { ApiError } from './api';
import type { MessageKey, Translate } from '../i18n';

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
/**
 * 서버가 준 코드 → 사전 키. **`if` 사슬이 아니라 표다**(`#658` 의 `writerDeniedText` 판례).
 *
 * 사슬은 **다섯 번째 코드를 조용히 마지막 가지로 흘린다** — 서버가 새 코드를 내기 시작해도
 * 아무도 모르고, 사람은 원인과 무관한 문장을 읽는다. 표는 그것을 `undefined` 로 드러내고,
 * 그 자리에서 **코드를 그대로 보여 주는** 문장(`avatar.error.other`)으로 떨어진다.
 *
 * 값이 **키**라 이 상수는 언어를 안 지닌다 — 모듈 최상단에 있어도 굳지 않는다
 * (`frozenLabels.test.ts` 가 그 모양을 막는다).
 */
const CODE_KEY: Record<string, MessageKey> = {
  // 서버가 바이트를 보고 거절했다. 확장자를 믿지 않으므로 `.png` 라는 이름만으로는 통과하지 못한다.
  not_an_image: 'avatar.error.notAnImage',
  too_large: 'avatar.error.tooLarge',
  // 이 문장이 따로 있어야 하는 이유: SVG 는 검사에 파일 전체를 읽어야 해서 상한이 다른
  // 형식보다 훨씬 낮다. 이유를 뭉개면 SVG 를 든 사람이 "SVG 만 쓸 수 있다"를 듣는다.
  svg_too_large: 'avatar.error.svgTooLarge',
  not_found: 'avatar.error.notFound',
};

/**
 * 번역기를 **필수 인자로 맨 뒤에** 받는다. 기본값을 주면 부르는 화면이 그것을 안 넘겨도
 * 컴파일이 통과하고 **그 화면만 한 언어로 굳는다** — `lastTurnAgo`·`inboxRow` 와 같은 규약.
 */
export function avatarErrorMessage(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    const key = CODE_KEY[err.code];
    if (key) return t(key, { formats: AVATAR_FORMATS });
    return t('avatar.error.other', { code: err.code });
  }
  return t('avatar.error.unreachable');
}
