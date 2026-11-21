-- 중단이 의무를 닫는다 — **`취소` 라는 결말**(에이전트 팀 3-3b).
--
-- ## 무엇이 아팠나
--
-- 050 이 위임을 만들 때 의무를 닫는 길은 셋이었다: 답(`done`) · 실패(`failed`) ·
-- 기한(`timeout`). 그런데 사람이 그 팀원의 턴을 **중단하면**(#686 의
-- `POST /agent-sessions/:id/cancel`) 아무 것도 닫히지 않는다. 그 턴은 발화 없이 끝나므로
-- `countsAsReply` 도, 실패도 없다.
--
-- 그래서 의무는 열린 채 남고 **기한이 지나야** 닫힌다. 그 결말은 `timeout` 이고, 팀장은
-- 10분 뒤에 *"무응답 — 살아 있는지 알 수 없다"* 를 받아 **사람이 일부러 멈춘 일을 다시
-- 하려 든다**(직접 하거나 다른 팀원에게 돌린다). 사람의 중단이 10분 뒤에 되돌려지는 셈이다.
--
-- ## 왜 `timeout` 으로 뭉치지 않는가
--
-- 팀장이 다음에 할 일이 다르다. `timeout` 은 *"그 팀원이 살아 있는지조차 모른다"* 이므로
-- 다시 넘기거나 직접 하는 것이 맞다. `canceled` 는 **사람이 그것을 원하지 않았다**는 뜻이다 —
-- 다시 시작하면 사람의 결정을 무르는 것이다. 결말을 뭉치면 프롬프트가 그 둘에 같은 말을
-- 하게 되고, 그 말은 한쪽에서 반드시 틀린다(050 이 결말을 셋으로 가른 것과 같은 근거).
alter table team_delegation_item drop constraint team_delegation_item_outcome_check;
alter table team_delegation_item add constraint team_delegation_item_outcome_check
  check (outcome in ('done', 'failed', 'timeout', 'canceled'));
