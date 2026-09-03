-- 에이전트가 제안한 스킬을 저장하는 테이블(#140). **워크스페이스 자산** — 에이전트별 속성이 아니다.
-- 한 에이전트가 배운 것을 다른 에이전트도 쓴다. 테이블은 계정을 참조하지 않는다.
--
-- slug: 스킬을 식별하는 고유 키. `[a-z0-9-]{2,40}` 형식.
-- approved_by: null 이면 미승인 상태. 에이전트가 제안만 하고 사람은 승인한다.
-- approved_at: 승인 시점. 비활성화·삭제 시에는 unchanged.
-- disabled_at: 비활성화 시점. 삭제 요청이 아닌 비활성화만 사용.
create table workspace_skill (
  slug text primary key,
  body text not null,
  proposed_by uuid not null references account(id),
  proposed_at timestamptz not null default now(),
  approved_by uuid references account(id),
  approved_at timestamptz,
  disabled_at timestamptz
);

-- approved_at 가 null 인 스킬(미승인) 조회
create index workspace_skill_pending_idx on workspace_skill (proposed_at desc) where approved_at is null;

-- 승인된 스킬 조회 (approved_at 로 정렬)
create index workspace_skill_approved_idx on workspace_skill (approved_at desc) where approved_at is not null and disabled_at is null;