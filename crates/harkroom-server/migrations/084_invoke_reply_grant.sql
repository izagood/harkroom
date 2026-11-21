-- **회신권**(084). 범위가 좁은 에이전트(owner 등)가 스레드 T 에서 다른 에이전트 Y 를 부르면,
-- Y 는 **그 스레드 안에서** 부른 쪽을 다시 깨울 수 있다 — 멘션이든 그 에이전트가 연 스레드의
-- 답글이든. 공개 에이전트가 owner 에이전트에게 일을 받고도 끝났다고 알릴 길이 없던 자리다
-- (검토 스레드 결정, jaebin 2026-10-01).
--
-- 경계(판정은 `services/invokeGate.ts`):
--   - 시작은 부른 쪽만 한다. Y 가 먼저 X 를 부르는 길은 여전히 없다 — 그것이 "아무나 → 공개 →
--     owner" 우회를 막는 자리다.
--   - 스레드·부른 쪽·불린 쪽 셋에 묶인다. 다른 스레드·다른 에이전트로 번지지 않는다.
--   - Y 의 결과 발화(진행·대기 줄 말고 전부 — `countsAsReply`) 한 번에 닫힌다. 기한(6h)은
--     결과를 끝내 안 낸 경우의 안전장치다.
--   - X 가 같은 스레드에서 Y 를 다시 부르면 다시 열린다(기한도 다시 잰다).
create table invoke_reply_grant (
  grantee_id     uuid not null references account(id) on delete cascade,
  granter_id     uuid not null references account(id) on delete cascade,
  thread_root_id uuid not null references message(id) on delete cascade,
  opened_at      timestamptz not null default now(),
  expires_at     timestamptz not null,
  closed_at      timestamptz,
  primary key (grantee_id, granter_id, thread_root_id),
  check (grantee_id <> granter_id)
);
