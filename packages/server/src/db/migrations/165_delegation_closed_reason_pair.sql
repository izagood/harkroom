-- 164 의 짝 검사 `(outcome = 'closed') = (closed_reason is not null)` 는 열린 의무(outcome null)에서 왼쪽이 null 이 되어
-- 검사 전체가 null(=통과)이 된다 — 열린 의무에 closed_reason 만 붙어도 막지 못했다. `is not distinct from` 으로 null 을
-- false 로 읽게 고친다. 지금 있는 행은 모두 이 검사를 이미 만족한다(164 뒤로 closed_reason 을 쓰는 코드가 없었다).
alter table team_delegation_item drop constraint team_delegation_item_closed_reason_pair;
alter table team_delegation_item add constraint team_delegation_item_closed_reason_pair
  check ((outcome is not distinct from 'closed') = (closed_reason is not null));
