-- 선택을 **답하지 않기로 했으면** 물어본 에이전트를 깨운다(2026-09-09).
--
-- **왜 필요한가.** 물음이 닫히는 길이 고르기 하나뿐이었다(043 이 만든 `ask_answered` 는
-- 고른 경우다). 그 작업을 그만두기로 한 사람에게 남은 수단은 그 메시지를 **지우는 것**
-- 뿐이었고, 지우면 무엇을 물었는지까지 사라진다. 턴을 중단해도(`/agent-sessions/:id/cancel`)
-- `meta.ask` 는 그대로여서 대기 줄이 물어본 턴보다 오래 살았다 — 화면이 `dead-runner`
-- 교착을 감지만 하고 풀 수단이 없던 것이 이것이다(jaebin 보고).
--
-- **왜 'ask_answered' 를 재사용하지 않는가.** 043 이 'wake' 를 재사용하지 않은 이유가 여기서
-- 그대로 성립한다: 러너가 프롬프트를 다르게 조립해야 한다. 답에는 **고른 옵션**이 있어서
-- 러너가 그것을 싣지만(`askAnsweredNote`), 닫힘에는 고른 것이 없다. 뭉치면 러너가 "고른 것:
-- undefined" 를 지어내고, 그 턴이 할 일도 틀린다 — 고른 길로 가는 것이 아니라 **접는 것**이다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered', 'ask_closed'));
