-- 선택에 답이 오면 그 물음을 낸 에이전트를 깨운다(2026-09-09).
--
-- **왜 필요한가.** `message.ask` 의 설명은 *"갈림길에서 선택지를 내놓는다(고르면 즉시
-- 진행)"* 인데, 그 "즉시 진행"을 만드는 코드가 없었다. 사람이 카드에서 버튼을 누르면
-- `recordAskAnswer` 가 메시지 meta 에 `answeredWith` 를 적고 끝난다 — 물어본 에이전트는
-- 그 사실을 영영 모른다.
--
-- 게다가 `message.ask` 는 **발화**라서, 그 턴은 답을 올린 뒤 회수 대상이 된다
-- (agent/src/mentionTurn.ts 의 `reconsiderEnd`). 사람이 고민하는 사이 물어본 턴은 이미
-- 죽어 있다. 실측(2026-09-09 03:41): 답을 기록한 뒤 15분 동안 그 스레드에 아무 일도
-- 없었다.
--
-- **왜 'wake' 를 재사용하지 않는가.** 040 이 'wake' 를 따로 만든 이유가 여기서도 그대로
-- 성립한다: 러너는 사유마다 프롬프트를 다르게 조립해야 한다. 깨움에는 새 사람 발화가
-- 없지만, **선택에는 있다** — 사람이 고른 옵션이다. 그것을 'wake' 로 뭉치면 러너가
-- "부른 사람이 없다"로 읽어 그 선택을 프롬프트에 싣지 못한다.
alter table inbox drop constraint inbox_reason_check;
alter table inbox add constraint inbox_reason_check
  check (reason in ('mention', 'thread_reply', 'dm', 'wake', 'ask_answered'));
