-- 위임 끝(3판) — 7일 활동 없는 위임을 idle 로 끝내는 스윕이 끝나지 않은 위임만 마지막 활동 순으로 훑는다.
-- 새 인덱스뿐이라 옛 파드에 무해하다(expand).
create index if not exists mandate_live_activity_idx on mandate (last_activity_at) where ended_at is null;
