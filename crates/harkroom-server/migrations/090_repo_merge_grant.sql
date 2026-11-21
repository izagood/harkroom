-- 에이전트 머지 권한(`repo.merge`) — 설계 스레드 3deac356(채널 a42006a1), security F1~F4.
--
-- 표는 055 의 `account_grant` 를 그대로 쓴다. scope 는 `repo:<owner>/<name>` 하나뿐이고, 전역('')
-- 은 **이 capability 에 한해 아무것도 열지 않는다**(F1 — `hasGrant` 의 "전역이 대상을 덮는다" 규칙을
-- 이 capability 는 타지 않는다. 판정은 `canMergeRepo` 가 정확 일치로만 한다).
--
-- `allow_agent_cause`(F4): 그 턴을 띄운 메시지가 **사람** 글일 때만 머지가 통과한다. 다른 에이전트가
-- "#N 머지해"라고 멘션해 띄운 턴에서도 통과시키려면 이 플래그를 켠 grant 여야 한다. 기본은 꺼짐 —
-- 좁힌 위협 모델("실수 머지")에서 가장 흔한 실수가 바로 에이전트끼리의 지시 전달이다.
alter table account_grant
  add column allow_agent_cause boolean not null default false;
