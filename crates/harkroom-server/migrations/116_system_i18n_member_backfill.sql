-- 시스템 줄 번역 표지 — 옛 멤버 들고남 줄 백필(i18n P5 ①, jaebin 결정 D4: 옛 줄은 그대로 두되 멤버 줄만 채운다).
--
-- 새 서버는 시스템 줄에 `meta.i18n = { key, args }` 를 함께 싣고, 새 앱은 그것을 앱 언어로 그린다(`shared/src/systemI18n.ts`).
-- 옛 줄에는 표지가 없어 본문(한국어)으로 그려진다. 그중 **멤버 들고남**만 채운다 — 가장 흔한 시스템 줄이고,
-- 대상이 이미 `meta.accountId` 로 있고, 본문이 정확히 세 꼴뿐이라 다른 글을 잘못 덮을 여지가 없다.
--
-- 지키는 것(security C6):
-- - 대상: `kind = 'system'` · `meta.accountId` 가 문자열 · `body` 가 아래 세 꼴과 **정확히 같은** 줄만.
--   (스레드 모델 지정 줄도 `meta.accountId` 를 갖지만 본문이 달라 걸리지 않는다.)
-- - `body` 는 손대지 않는다. `meta` 에 `i18n` 만 더한다.
-- - 멱등: 이미 `i18n` 이 있는 줄은 건너뛴다 — 다시 돌려도 결과가 같다.
-- - 세 본문은 `channelRoutes.ts::memberSystemMessage` 와 글자 하나까지 같아야 한다(`{account}` = SYSTEM_ACCOUNT_PLACEHOLDER).
update message m
   set meta = m.meta || jsonb_build_object(
         'i18n', jsonb_build_object(
           'key', v.key,
           'args', jsonb_build_object('accountId', m.meta->>'accountId')))
  from (values
          ('{account}님이 채널에 추가되었습니다.', 'system.member.added'),
          ('{account}님이 채널에서 나갔습니다.', 'system.member.left'),
          ('{account}님이 채널에서 제거되었습니다.', 'system.member.removed')
       ) as v(body, key)
 where m.kind = 'system'
   and m.body = v.body
   and jsonb_typeof(m.meta->'accountId') = 'string'
   and not (m.meta ? 'i18n');
