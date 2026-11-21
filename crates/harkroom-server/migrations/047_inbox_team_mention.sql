-- 팀 멘션이 **팀장 하나**를 깨운다(046 의 다음 걸음).
--
-- 지금까지 `@팀` 은 이름 펼치기였다: 명단을 펼쳐 팀원마다 inbox 항목을 넣었고, 그러면
-- 턴이 팀원 수만큼 따로 떴다. 같은 요청을 넷이 각자 처음부터 풀고 넷이 각자 사람에게
-- 답했다. 046 이 팀장을 담을 자리를 만들었고, 이 마이그레이션은 **그 값을 읽는 부름**에
-- 필요한 두 가지를 더한다.
--
-- ## ① 새 사유 `team_mention`
--
-- 평범한 `mention` 으로 뭉치면 러너가 "이건 팀 부름이다"를 알 길이 없다. 그것을 알아야
-- 하는 이유는 프롬프트가 달라지기 때문이다 — 팀장에게는 **명단**을 실어 줘야 하고,
-- 명단 없이는 누구에게 무엇을 넘길지 판단할 근거가 없어 결국 혼자 다 한다.
--
-- 040(`wake`)·043(`ask_answered`)·045(`ask_closed`)이 각각 사유를 가른 이유가 그대로
-- 성립한다: **러너가 프롬프트를 다르게 조립해야 하면 사유를 가른다.** 그 셋과 다른 점은
-- 여기엔 사람의 새 발화가 **있다**는 것이다(팀을 부른 그 말) — 그래서 `wake` 계열처럼
-- 델타를 대신하는 줄이 아니라, 델타에 **덧붙는 맥락**이다.
--
-- ## ② `team_id`
--
-- 어느 팀으로 불렸는지를 싣는다. 본문에서 되짚을 수도 있지만(`@handle` 을 다시 스캔해
-- 팀 이름을 찾는다) 그것은 **추측**이다: 한 발화가 팀 둘을 부를 수 있고, 팀 이름과 같은
-- 집합·계정이 나중에 만들어질 수 있어(`services/messages.ts` 의 해석 순서 주석) 같은
-- 문자열이 서로 다른 대상을 가리킬 수 있다. 서버는 그 해석을 이미 했으므로 결과를
-- 적어 두는 것이 맞다 — 읽는 쪽이 같은 판정을 두 번 하지 않는다.
--
-- `on delete set null` 인 이유: 부름이 대기 중인데 팀이 지워질 수 있다. 그때 **부름
-- 자체는 사라지지 않는다** — 사람이 한 요청은 여전히 답을 받아야 한다. 사유는
-- `team_mention` 으로 남고 명단만 비므로, 러너는 팀 블록 없이 평범한 부름처럼 처리한다
-- (그 관용은 러너 쪽에 적혀 있다). cascade 로 inbox 항목을 지우면 그 요청이 조용히
-- 사라지고, 사람은 자기 말에 답이 없는 이유를 어디에서도 알 수 없다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered', 'ask_closed', 'team_mention'));

alter table inbox add column team_id uuid references agent_team(id) on delete set null;

-- 팀 부름은 드물다(팀을 부르는 발화 하나마다 한 행). 그래서 부분 인덱스로 둔다 —
-- `listInbox` 가 명단을 함께 실으려고 이 열이 채워진 행만 골라 팀을 읽는다.
create index inbox_team_id_idx on inbox (team_id) where team_id is not null;
