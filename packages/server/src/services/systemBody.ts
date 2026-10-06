import { SYSTEM_ACCOUNT_PLACEHOLDER, UNKNOWN_ACCOUNT_LABEL } from '@harkroom/shared';

/** SQL 문자열 리터럴. 아래 두 상수는 코드에 박힌 값이지만, 따옴표가 들어오는 날에도 안 깨지게 감싼다. */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 서버가 **본문을 밖으로 내보낼 때** 쓰는 본문 식 — 시스템 메시지의 자리표시자를 지금의 handle 로
 * 채운다. 화면의 `displayBody`(desktop `lib/mention.ts`·mobile `mention/render.dart`)와 같은 규칙이다.
 *
 * 시스템 메시지(채널 입·퇴장·스레드 모델 지정)는 본문에 이름 대신 `SYSTEM_ACCOUNT_PLACEHOLDER` 를 두고
 * 대상을 `meta.accountId` 로 싣는다(#329). 메시지 행은 화면이 채우지만, **`kind` 를 싣지 않는 출구**
 * — 인박스 줄(`InboxEntry`)·푸시 미리보기 — 는 화면이 채울 수 없어 `{account}님이 …` 가 그대로
 * 나갔다(TestFlight 실측, 2026-10-02). 그래서 그 출구에서는 서버가 채운다. 저장된 본문은 그대로다 —
 * 이름을 바꾸면 지난 줄도 새 이름으로 나가야 한다.
 *
 * `@` 는 붙이지 않는다(시스템 줄은 부름이 아니다, `fillSystemAccount`). 사용자가 쓴 일반 글의
 * `{account}` 는 손대지 않는다 — `kind = 'system'` 은 서버 코드만 만든다.
 */
export function displayBodySql(m: string): string {
  return `case when ${m}.kind = 'system' and jsonb_typeof(${m}.meta->'accountId') = 'string'
            then replace(${m}.body, ${lit(SYSTEM_ACCOUNT_PLACEHOLDER)},
                         coalesce((select sa.handle from account sa where sa.id::text = ${m}.meta->>'accountId'),
                                  ${lit(UNKNOWN_ACCOUNT_LABEL)}))
            else ${m}.body end`;
}
