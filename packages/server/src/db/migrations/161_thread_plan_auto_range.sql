-- 자동 진행의 범위는 켤 때 고정한다(단계 id → 그때 제목의 해시). 깨울 때 이 안에서만 고른다.
alter table thread_plan add column auto_range jsonb not null default '{}'::jsonb;
