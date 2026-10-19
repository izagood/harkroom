-- 메모리 재설계 A안 S0 — 3절 지표의 기준선 쿼리(설계 harkroom://message/fa2b0042-ce2a-48bb-ac12-c49f442cd571).
--
-- 읽기 전용이다. 운영 DB 에 psql 로 그대로 돌린다: `psql "$DATABASE_URL" -f packages/server/scripts/memory-metrics.sql`.
-- 결과(실데이터)는 공개 저장소에 두지 않는다 — 비공개 harkroom-internal 에 남긴다.
-- 각 문장은 `-- name: <이름>` 줄로 시작한다(test/memoryMetrics.test.ts 가 이 이름으로 하나씩 돌려 본다).
--
-- 「상태 기록」 판정(stateLike): 스레드 진행 상태를 담은 기억 — 이름이 delegation-*·review-* 이거나,
-- 요약에 PR 번호(#123)와 진행 낱말(CI·머지·대기·초록·검토·rebase·head)이 같이 있는 것. journal 은 따로 센다.
-- `CI` 는 대문자 낱말 그대로만 센다(policy·decision 의 ci 에 걸리지 않게 — security n1). 앞뒤가 영문자가 아니면 된다(「CI초록」도 걸린다).
-- 판정은 services/memory.ts::looksLikeThreadState 와 같아야 한다.
-- 보관된 것(archived_at)과 쓰기 검사에 걸린 것(flagged_at)은 recall·목록에 안 실리므로 뺀다.

-- name: memory_by_agent
-- 에이전트별 mem/* 수 · kind 별 수 · procedure 비율 · 상태 기록 수와 비율(지식 = topic+procedure 기준).
with m as (
  select a.handle, a.id as account_id, am.slug, am.kind, am.description,
    (am.slug ~ '^mem/(.*/)?(delegation|review)-'
      or (coalesce(am.description, '') ~ '#[0-9]+'
          and (coalesce(am.description, '') ~ '(^|[^A-Za-z])CI([^A-Za-z]|$)'
               or coalesce(am.description, '') ~* '(머지|대기|초록|검토|rebase|head)'))) as state_like
  from agent_memory am
  join account a on a.id = am.account_id and a.kind = 'agent'
  where am.slug <> 'core' and am.archived_at is null and am.flagged_at is null
)
select handle, account_id,
  count(*) as mem_total,
  count(*) filter (where kind = 'topic') as topic,
  count(*) filter (where kind = 'procedure') as procedure,
  count(*) filter (where kind = 'journal') as journal,
  round(100.0 * count(*) filter (where kind = 'procedure') / nullif(count(*) filter (where kind <> 'journal'), 0), 1) as procedure_pct,
  count(*) filter (where state_like and kind <> 'journal') as state_like,
  round(100.0 * count(*) filter (where state_like and kind <> 'journal') / nullif(count(*) filter (where kind <> 'journal'), 0), 1) as state_like_pct
from m
group by handle, account_id
order by mem_total desc;

-- name: core_size_by_agent
-- core 길이(매 턴 시스템 프롬프트에 통째로 실린다)와 목록에 실리는 index 의 대략 크기(이름+요약, journal 제외).
-- 실제 주입 크기는 러너가 덧붙이는 머리줄이 더해진다 — 정확한 값은 러너 로그로 잰다.
select a.handle, a.id as account_id,
  coalesce(max(char_length(am.value)) filter (where am.slug = 'core'), 0) as core_chars,
  coalesce(sum(char_length(am.slug) + char_length(coalesce(am.description, '')) + 8)
    filter (where am.slug <> 'core' and am.kind <> 'journal'), 0) as index_chars_est
from account a
left join agent_memory am on am.account_id = a.id and am.archived_at is null and am.flagged_at is null
where a.kind = 'agent'
group by a.handle, a.id
order by index_chars_est desc;

-- name: recall_use_by_agent
-- recall 로 쓰인 것 중 상태 기록의 몫(recall_count 합 기준). S0 N4 이후 recall_count 는 「실제로 실은 것」만 센다 —
-- 이 PR 이 배포되기 전 값은 search 시점 계수가 섞여 있다(비교는 배포 뒤 구간끼리).
select a.handle, a.id as account_id,
  sum(am.recall_count) as recalls,
  sum(am.recall_count) filter (where am.slug ~ '^mem/(.*/)?(delegation|review)-'
    or (coalesce(am.description, '') ~ '#[0-9]+'
        and (coalesce(am.description, '') ~ '(^|[^A-Za-z])CI([^A-Za-z]|$)'
             or coalesce(am.description, '') ~* '(머지|대기|초록|검토|rebase|head)'))) as state_like_recalls
from agent_memory am
join account a on a.id = am.account_id and a.kind = 'agent'
where am.slug <> 'core'
group by a.handle, a.id
having sum(am.recall_count) > 0
order by recalls desc;

-- name: distill_batch_size
-- 증류 묶음 크기(설계 2절 A③): 에이전트별·날짜별로 「done 이 된 뒤 24h 넘게 그대로인」 스레드 수.
-- thread_status 는 지금 값만 남는다(이력 없음) — 그래서 「그날 done 이 되어 지금까지 24h 넘게 done 인」 스레드를 센다.
-- 그 뒤 다시 움직인 스레드는 빠지므로 실제 묶음보다 약간 작게 나온다(하한). 최근 14일.
select a.handle, a.id as account_id,
  (ts.updated_at at time zone 'Asia/Seoul')::date as day_kst,
  count(*) as threads
from thread_status ts
join account a on a.id = ts.account_id and a.kind = 'agent'
where ts.status = 'done'
  and ts.updated_at < now() - interval '24 hours'
  and ts.updated_at >= now() - interval '15 days'
group by a.handle, a.id, day_kst
order by a.handle, day_kst;

-- name: distill_batch_summary
-- 위의 에이전트별 요약 — 하루 묶음의 평균·최대(증류 턴 하나의 입력 크기 상한을 정하는 재료).
select handle, account_id,
  count(*) as days,
  round(avg(threads), 1) as avg_threads_per_day,
  max(threads) as max_threads_per_day
from (
  select a.handle, a.id as account_id, (ts.updated_at at time zone 'Asia/Seoul')::date as day_kst, count(*) as threads
  from thread_status ts
  join account a on a.id = ts.account_id and a.kind = 'agent'
  where ts.status = 'done'
    and ts.updated_at < now() - interval '24 hours'
    and ts.updated_at >= now() - interval '15 days'
  group by a.handle, a.id, day_kst
) d
group by handle, account_id
order by avg_threads_per_day desc;
