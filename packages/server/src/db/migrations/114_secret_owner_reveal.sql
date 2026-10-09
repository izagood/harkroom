-- 비밀 보관소 — 소유자가 자기 비밀의 값을 다시 본다(Reveal). 설계: 스레드 464aff1c, jaebin D1=A.
--
-- 1) session.stepped_up_until — 비밀번호를 **다시** 확인한 세션만 이 시각까지 값을 받는다(`POST /auth/step-up`).
--    세션 토큰만 손에 넣어서는 값이 나오지 않게 하려는 것이다. 창은 세션마다 따로다 — 한 기기에서 확인한 것이
--    다른 기기의 세션을 열지 않는다.
-- 2) secret_access_log 의 사람 칸 — 지금까지 이 표는 에이전트가 받은 것만 적었다. 소유자가 보기·복사·내려받기를
--    하면 actor_account_id·action 과, 기기가 **스스로 밝힌** client 문자열·IP 를 적는다(검증된 기기 신원이 아니다).
alter table session add column stepped_up_until timestamptz null;

alter table secret_access_log
  add column actor_account_id uuid null,
  add column action text null check (action in ('view', 'copy', 'download')),
  add column client text null,
  add column ip text null;
