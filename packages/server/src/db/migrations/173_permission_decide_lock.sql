-- S5.3 C3b-3b — 권한 카드 결정의 판정 근거 줄을 잠그는 함수(security A안).
--
-- `select … for share`·`for key share` 는 그 표의 UPDATE 권한(칸 하나 이상)을 요구한다. 쓰기 역할에 다섯 표의 UPDATE 칸을
-- 주지 않으려고, 잠금만 하는 SECURITY DEFINER 함수를 둔다. 함수는 아무 칸도 고치지 않고 아무 값도 돌려주지 않는다(void).
-- 줄 잠금은 함수가 끝나도 부른 쪽 tx 가 끝날 때까지 남는다.
--
-- 잠금 순서(하나로 고정 — Rust `core/decide_core.rs` 의 순서 시험이 이 본문을 대조한다):
--   channel for share → account(id 순) for share → agent_config for share
--   → agent_invoker for key share → channel_member for key share
-- 요청 줄(permission_request) for update 는 부른 쪽이 **이 뒤에** 잡는다.
--
-- 소유자는 이 마이그레이션을 돌린 역할이다. PUBLIC 의 EXECUTE 는 회수한다 — 쓰기 역할에 EXECUTE 를 주는 것은 운영 구성 몫이다.
-- 그 권한이 없으면 Rust 는 이 결정을 맡지 않고 TS 로 넘긴다(`has_function_privilege`).
create or replace function permission_decide_lock(p_agent uuid, p_actor uuid, p_channel uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_channel is not null then
    perform 1 from public.channel where id = p_channel for share;
  end if;
  perform 1 from public.account where id in (p_agent, p_actor) order by id for share;
  perform 1 from public.agent_config where account_id = p_agent for share;
  perform 1 from public.agent_invoker where agent_id = p_agent and account_id = p_actor for key share;
  if p_channel is not null then
    perform 1 from public.channel_member where channel_id = p_channel and account_id = p_actor for key share;
  end if;
end;
$$;

revoke all on function permission_decide_lock(uuid, uuid, uuid) from public;
