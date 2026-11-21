-- 지운 에이전트의 handle 을 묘비 이름으로 바꾼다(백필). 061 은 지운 에이전트가 옛 handle 을 그대로
-- 쥐게 했고, 그래서 같은 이름으로 새 에이전트를 만들면 `account_handle_key` 위반으로 막혔다.
-- 사람 삭제(#1228)는 이미 `deleted-<id 앞 8자>` 로 바꾸고 있다 — 에이전트 삭제도 같은 규칙으로
-- 맞추고(`deletedHandle.ts`), 이미 지운 행은 여기서 한 번 옮긴다.
--
-- 고르는 규칙은 `freeDeletedHandle` 과 같다: 8자 꼬리 → 겹치면 24자 → 그래도 겹치면 무작위.
-- 겹침은 계정·팀·집합을 대소문자 없이 본다(한 이름 공간). 이미 `deleted-` 로 시작하는 행은 건드리지 않는다.
-- 이름만 바뀌는 것이라 옛 파드에 무해하다 — 본문은 `<@id>` 로 저장돼 있고, 지운 계정은 어느 조회에서도 걸러진다.
do $$
declare
  acc record;
  hex text;
  candidate text;
begin
  for acc in
    select id from account
     where deleted_at is not null and lower(handle) not like 'deleted-%'
     order by id
  loop
    hex := replace(acc.id::text, '-', '');
    candidate := null;
    foreach candidate in array array['deleted-' || left(hex, 8), 'deleted-' || left(hex, 24)] loop
      exit when not exists (select 1 from account where lower(handle) = lower(candidate) and id <> acc.id)
            and not exists (select 1 from agent_team where lower(name) = lower(candidate))
            and not exists (select 1 from handle_group where lower(handle) = lower(candidate));
      candidate := null;
    end loop;
    if candidate is null then
      candidate := 'deleted-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
    end if;
    update account set handle = candidate where id = acc.id;
  end loop;
end $$;
