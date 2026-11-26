-- 스레드 집계를 미리 세어 둔다(채널 본문 피드가 줄마다 답글을 다시 세던 비용, 2026-11-26).
--
-- 본문 피드·스레드 목록은 뿌리 줄마다 그 스레드의 답글 수·활동 수·마지막 답글 시각·참여자를 붙인다. 지금까지는
-- 줄마다 `message` 를 `thread_root_id` 로 다시 훑었다(`golden/sql_fragments.json` 의 `thread_stats` LATERAL).
-- 답글이 수천 개인 스레드가 많은 채널에서는 그 훑기가 피드 한 페이지 시간의 대부분이었다.
--
-- 규칙은 예전 LATERAL 과 **글자 그대로 같다**(대조 시험 `tests/thread_stat.rs`):
--   - 바탕: `thread_root_id = 뿌리` 이고 `deleted_at is null` 인 줄(뿌리 자신은 세지 않는다).
--   - reply_count: 그 가운데 kind 가 progress·wake 가 아닌 줄. activity_count: 전부.
--   - last_reply_at: reply_count 줄의 가장 늦은 created_at.
--   - 참여자: author_id 가 있고 kind 가 system 이 아닌 줄의 작성자, 작성자마다 가장 늦은 created_at(늦은 순으로 늘어놓는다).
--
-- 갱신은 **같은 트랜잭션 안의 트리거**다. 글 쓰기(`post_in_tx`)·지우기(soft delete)·채널 지우기 어디로 와도,
-- 시험이 표에 바로 넣어도 같은 규칙을 지난다. 넣기는 더하기만, 지우기(드물다)는 그 뿌리 하나를 다시 센다.
-- 채널 지우기는 뿌리가 지워질 때 `on delete cascade` 로 따라 지워진다. kind·thread_root_id·created_at·author_id 를
-- 바꾸는 갱신은 서버에 없다(바뀌면 그 뿌리를 다시 센다 — 아래 트리거가 그 칸들도 본다).
--
-- 역할: 트리거 함수와 읽기 함수는 SECURITY DEFINER 다(search_path 고정). 쓰기·읽기 역할에 새 표 GRANT 를 주지 않아도
-- 글 쓰기가 막히지 않고 피드가 읽힌다. 표 자체에는 아무 역할에도 권한을 더 주지 않는다.

create table thread_stat (
  root_id uuid primary key references message(id) on delete cascade,
  reply_count integer not null default 0,
  activity_count integer not null default 0,
  last_reply_at timestamptz null
);

create table thread_participant (
  root_id uuid not null references message(id) on delete cascade,
  author_id uuid not null,
  last_at timestamptz not null,
  primary key (root_id, author_id)
);

-- 한 뿌리를 처음부터 다시 센다(지우기·드문 갱신·백필).
--
-- 잠금 순서: 넣기 트리거와 같이 **thread_stat 줄 → thread_participant** 순서로 잡는다. 반대로 잡으면 같은 뿌리에서
-- 답글 넣기와 지우기가 겹칠 때 교착(deadlock)이 난다. 또 세기는 thread_stat 줄을 잠근 **뒤에** 한다 — 잠금을 기다리는 동안
-- 커밋된 답글을 READ COMMITTED 의 다음 문장 스냅숏이 보므로, 넣기 tx 보다 앞선 스냅숏으로 세어 덮어쓰지 않는다.
create function thread_stat_recount(p_root uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into thread_stat (root_id) values (p_root) on conflict (root_id) do nothing;
  perform 1 from thread_stat where root_id = p_root for update;
  delete from thread_participant where root_id = p_root;
  update thread_stat s
     set reply_count = c.reply_count,
         activity_count = c.activity_count,
         last_reply_at = c.last_reply_at
    from (select count(*) filter (where kind not in ('progress', 'wake'))::int as reply_count,
                 count(*)::int as activity_count,
                 max(created_at) filter (where kind not in ('progress', 'wake')) as last_reply_at
            from message where thread_root_id = p_root and deleted_at is null) c
   where s.root_id = p_root;
  insert into thread_participant (root_id, author_id, last_at)
  select p_root, author_id, max(created_at)
    from message
   where thread_root_id = p_root and deleted_at is null and author_id is not null and kind <> 'system'
   group by author_id;
end $$;
revoke execute on function thread_stat_recount(uuid) from public;

create function thread_stat_on_message() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.thread_root_id is null or new.deleted_at is not null then
      return null;
    end if;
    insert into thread_stat (root_id, reply_count, activity_count, last_reply_at)
    values (
      new.thread_root_id,
      case when new.kind not in ('progress', 'wake') then 1 else 0 end,
      1,
      case when new.kind not in ('progress', 'wake') then new.created_at end
    )
    on conflict (root_id) do update
      set reply_count = thread_stat.reply_count + excluded.reply_count,
          activity_count = thread_stat.activity_count + 1,
          last_reply_at = greatest(thread_stat.last_reply_at, excluded.last_reply_at);
    if new.author_id is not null and new.kind <> 'system' then
      insert into thread_participant (root_id, author_id, last_at)
      values (new.thread_root_id, new.author_id, new.created_at)
      on conflict (root_id, author_id) do update
        set last_at = greatest(thread_participant.last_at, excluded.last_at);
    end if;
    return null;
  end if;
  -- UPDATE: 세는 데 쓰는 칸이 바뀌었으면 옛 뿌리·새 뿌리를 다시 센다.
  if old.thread_root_id is not null then
    perform thread_stat_recount(old.thread_root_id);
  end if;
  if new.thread_root_id is not null and new.thread_root_id is distinct from old.thread_root_id then
    perform thread_stat_recount(new.thread_root_id);
  end if;
  return null;
end $$;
revoke execute on function thread_stat_on_message() from public;

create trigger thread_stat_insert after insert on message
  for each row execute function thread_stat_on_message();

create trigger thread_stat_update after update of deleted_at, kind, thread_root_id, created_at, author_id on message
  for each row
  when (old.deleted_at is distinct from new.deleted_at
     or old.kind is distinct from new.kind
     or old.thread_root_id is distinct from new.thread_root_id
     or old.created_at is distinct from new.created_at
     or old.author_id is distinct from new.author_id)
  execute function thread_stat_on_message();

-- 읽기: 뿌리 하나의 집계. 집계 줄이 없으면(답글이 없던 뿌리) 0·null·빈 배열 — 예전 LATERAL 의 빈 집계와 같다.
-- 읽는 역할에 표 GRANT 가 없어도 되도록 SECURITY DEFINER 다.
create function thread_stat_of(p_root uuid, out reply_count int, out activity_count int, out last_reply_at text, out participant_ids uuid[])
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(s.reply_count, 0)::int,
         coalesce(s.activity_count, 0)::int,
         s.last_reply_at::text,
         coalesce((select pg_catalog.array_agg(p.author_id order by p.last_at desc)
                     from thread_participant p where p.root_id = p_root), '{}'::uuid[])
    from (select 1) one
    left join thread_stat s on s.root_id = p_root
$$;

-- 백필: 답글이 있는 뿌리마다 한 번.
insert into thread_stat (root_id, reply_count, activity_count, last_reply_at)
select thread_root_id,
       count(*) filter (where kind not in ('progress', 'wake'))::int,
       count(*)::int,
       max(created_at) filter (where kind not in ('progress', 'wake'))
  from message
 where thread_root_id is not null and deleted_at is null
 group by thread_root_id;

insert into thread_participant (root_id, author_id, last_at)
select thread_root_id, author_id, max(created_at)
  from message
 where thread_root_id is not null and deleted_at is null and author_id is not null and kind <> 'system'
 group by thread_root_id, author_id;
