/**
 * 사람 계정 비밀번호의 길이 규칙 — **한 곳**이다. 서버(`authRoutes.ts` 의 가입·변경·재설정, `scripts/reset-password.ts`)와
 * 데스크톱 화면이 이 둘을 읽는다. 따로 적으면 화면과 서버가 갈려, 서버의 400 이 화면에서 엉뚱한 말로 읽힌다(#1410).
 *
 * 화면은 칸에 `maxLength` 를 걸지 않는다 — 붙여 넣은 값이 **말없이** 잘린다. 넘으면 문구로 알리고 제출을 막는다.
 * 모바일(Dart)은 이 파일을 못 읽어 같은 값을 따로 둔다(`apps/mobile`).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
