-- 스킬 사용 기록(2026-10-01, Hermes 자기 개선 검토 D3 — jaebin "추천대로").
--
-- 승인된 스킬은 **모든 에이전트의 모든 턴**에 깔린다(러너 `syncSkills`). 하나 늘 때마다
-- 그 비용이 붙는데, 무엇이 실제로 쓰이는지 근거가 없어 끌 것을 고를 수 없었다. 메모리에는
-- 069 의 read_count·last_read_at 이 있는데 스킬에만 없었다.
--
-- 행 하나 = 한 에이전트가 한 턴에 그 스킬을 불렀다는 사실. 러너가 턴 끝에 하네스 기록(claude
-- jsonl 의 `Skill` 도구 호출)에서 모아 보낸다. 셀 수 없는 하네스(codex·opencode)는 보내지
-- 않는다 — 행이 없다는 것은 "안 썼다"가 아니라 "이 기록으로는 모른다"일 수 있다.
--
-- **이 기록으로 아무것도 자동으로 끄지 않는다**(D3). 안 쓰는 스킬은 목록에 후보로만 뜨고,
-- 끄는 것은 사람이다. 080 은 같은 때 열린 다른 PR(쓰기 검사) 몫이다 — 이름순 적용이고 서로
-- 독립이라 어느 쪽이 먼저 들어가도 된다.
create table workspace_skill_usage (
  id bigserial primary key,
  slug text not null references workspace_skill(slug) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  used_at timestamptz not null default now()
);

create index workspace_skill_usage_slug_idx on workspace_skill_usage (slug, used_at desc);
