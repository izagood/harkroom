-- 위임장 ⑤b(소유자 결정 2026-11-02 「자동화당 하나」) — 자동화가 부른 에이전트 턴의 위임장.
-- 자동화 승인에는 글이 없어 뿌리(root_message_id)가 없다. 위임장은 **글 뿌리 또는 자동화 하나**에 묶인다(정확히 하나).
-- (자동화, 에이전트 소유자)마다 살아 있는 위임장은 하나다 — 주인은 늘 에이전트 소유자, 맡긴 사람(delegator)은 자동화 소유자(승인한 사람).
-- 수명은 7일 쉼이 아니라 자동화 상태(승인·켜짐·안 지움)에 묶인다(`validMandateOwner`). 줄의 7일 한도는 그대로다.
-- 자동화 행이 지워지는 길은 채널 삭제의 cascade 뿐이다(자동화 삭제는 soft — deleted_at). 그때는 위임장·줄도 같이 지워진다.
alter table mandate add column if not exists automation_id uuid null references automation(id) on delete cascade;
alter table mandate alter column root_message_id drop not null;
alter table mandate alter column thread_root_id drop not null;
alter table mandate add constraint mandate_root_or_automation
  check ((root_message_id is null) <> (automation_id is null) and (thread_root_id is null) = (root_message_id is null));
-- security n5(위임 키는 사람 세션만 만든다): 자동화의 마지막 만들기·승인·(본문·트리거·채널) 고침이 **사람 세션**이었던 시각.
-- 세션이 아닌 길(PAT 등)로 만들거나 고치면 null 이고, null 이면 그 자동화의 회차는 위임장을 받지 않는다(`automationMandateForCause`).
alter table automation add column if not exists mandate_session_at timestamptz null;
create unique index if not exists mandate_automation_owner_live
  on mandate (automation_id, owner_account_id) where automation_id is not null and ended_at is null;
