#!/usr/bin/env bash
# Rust 서버의 DB 시험(`tests/<이름>.rs`, `HARKROOM_TEST_DATABASE_URL` 이 있을 때만 도는 것)을 **TS 없이** 돈다.
#
# 예전에는 `packages/server/test/rustFrontDb.test.ts` 가 testcontainers 로 Postgres 를 띄우고 TS 마이그레이션으로 틀(template) DB 를
# 만든 뒤 시험마다 새 DB 와 좁은 쓰기 역할을 넘겼다. TS 백엔드를 지우면서 그 일을 이 스크립트가 맡는다:
#   1. 틀 DB 에 Rust 마이그레이션 실행기(`HARKROOM_RUST_MIGRATE=only`)를 돌린다.
#   2. 시험마다 틀에서 새 DB 를 만들고, 쓰기 풀을 쓰는 시험에는 그 루프의 `*_PRIVILEGES` 만 가진 역할을 만들어 넘긴다
#      (운영 GRANT 표가 모자라면 여기서 빨개진다 — 아래 표는 옛 TS 시험의 표를 그대로 옮겼다).
#   3. DB 가 없어 건너뛴 것을 통과로 읽지 않는다 — 건너뛴 표지가 있거나 통과 수가 0 이면 실패다.
#
# 쓰는 env: `PGADMIN_URL`(슈퍼유저 접속, 데이터베이스 이름은 `postgres`) · `SERVER_BIN`(harkroom-server-rs 바이너리) ·
# `CARGO_ARGS`(선택, `cargo test` 에 더 넘길 것). 인자로 시험 이름을 주면 그것만 돈다.
set -euo pipefail

: "${PGADMIN_URL:?PGADMIN_URL 이 없다}"
: "${SERVER_BIN:?SERVER_BIN 이 없다}"
here="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE=harkroom_tpl

url_for() { # url_for <db> [user]
  python3 - "$PGADMIN_URL" "$1" "${2:-}" <<'PY'
import sys, urllib.parse as u
base, db, user = sys.argv[1], sys.argv[2], sys.argv[3]
p = u.urlsplit(base)
netloc = p.netloc
if user:
    host = netloc.split('@', 1)[1]
    netloc = f'{user}:{user}@{host}'
print(u.urlunsplit((p.scheme, netloc, '/' + db, p.query, p.fragment)))
PY
}
admin() { psql "$PGADMIN_URL" -v ON_ERROR_STOP=1 -qAt -c "$1"; }

OPERATOR_GRANTS=(
  'insert, update on operator'
  'insert, delete on operator_upgrade'
  'usage on sequence operator_upgrade_id_seq'
  'insert, update on operator_gh_report'
  'select, insert, update, delete on agent_assignment'
  'select, insert, update on agent_config'
  'update on secret_grant'
  'insert on audit_log'
  'select, insert, update, delete on relay_hub'
  'select, insert, update, delete on agent_session_live'
  'select, insert, update on agent_presence'
  'select, insert, update, delete on operator_capability'
  'update (notified_at) on team_delegation'
  'update (outcome, closed_at) on team_delegation_item'
  'update (canceled_at, canceled_by_message_id) on agent_wake'
  'update (meta) on message'
  'insert on inbox'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
WAKE_GRANTS=(
  'update (fired_at) on agent_wake'
  'insert on inbox'
  'update (meta) on message'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
RETENTION_GRANTS=('delete on idempotency_key' 'delete on session')
OUTBOX_PRUNE_GRANTS=('delete on event_outbox')
MEASURE_GRANTS=('insert on measure_event')
DEVICE_ALLOW_GRANTS=('select, insert, delete on agent_operator_allow')
CLAIM_SEED_GRANTS=('select (token_hash), insert (token_hash) on claim_token')
PUSH_GRANTS=(
  'insert, update, delete on push_job'
  'delete on push_device'
  'update (last_ok_at, last_error) on push_device'
  'insert, delete on push_thread_sound'
  'update (sounded_at) on push_thread_sound'
)
MANDATE_IDLE_GRANTS=(
  'update (ended_at, end_reason) on mandate'
  'update (revoked_at) on mandate_line'
  'update (meta) on message'
  'insert on audit_log'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
BG_GRANTS=('update (status, error, finished_at) on bg_job')
BG_PRODUCE_GRANTS=('insert (account_id, kind, day, input) on bg_job')
TURN_LEASE_GRANTS=(
  'insert on secret_turn_lease'
  'update (ended_at, expires_at, last_renewed_at) on secret_turn_lease'
  'insert on audit_log'
  'insert on mandate'
  'update (last_activity_at) on mandate'
)
PERMISSION_EXPIRE_GRANTS=(
  'update (status, decided_at) on permission_request'
  'update (meta) on message'
  'insert on inbox'
  'insert on audit_log'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
DELEGATION_DEADLINE_GRANTS=(
  'update (deadline_at, notified_at) on team_delegation'
  'update (outcome, closed_at, closed_reason, stalled_notified_at, update_pending_message_id, update_pending_at, update_count) on team_delegation_item'
  'update (canceled_at, canceled_by_message_id) on agent_wake'
  'update (meta) on message'
  'insert, delete on inbox'
  'update (reason) on inbox'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
HOOK_DEBOUNCE_GRANTS=(
  'update (enabled, next_at, paused_reason, updated_at) on automation'
  'insert (automation_id, event_key, trigger_kind, payload, not_before, initiated_by, cause_message_id, chain_depth) on automation_run'
  'update (payload) on automation_run'
)
THREAD_STATUS_GRANTS=(
  'insert, delete on message_reaction'
  'insert, update, delete on thread_status'
  'insert on event_outbox'
  'usage on sequence event_outbox_id_seq'
)
WORK_GRANTS=(
  'insert, update on work'
  'insert on work_event'
  'usage on sequence work_event_id_seq'
)

# 시험 → 쓰기 역할 표(없으면 쓰기 풀 없이 돈다).
grants_for() {
  case "$1" in
    operator|relay_live|turn_settle|turn_cancel) echo OPERATOR_GRANTS ;;
    wake) echo WAKE_GRANTS ;;
    retention) echo RETENTION_GRANTS ;;
    mandate_idle) echo MANDATE_IDLE_GRANTS ;;
    permission_expire) echo PERMISSION_EXPIRE_GRANTS ;;
    bg) echo BG_GRANTS ;;
    bg_produce) echo BG_PRODUCE_GRANTS ;;
    outbox_prune) echo OUTBOX_PRUNE_GRANTS ;;
    measure) echo MEASURE_GRANTS ;;
    device_allow) echo DEVICE_ALLOW_GRANTS ;;
    push_loop) echo PUSH_GRANTS ;;
    turn_lease) echo TURN_LEASE_GRANTS ;;
    delegation_deadline) echo DELEGATION_DEADLINE_GRANTS ;;
    claim_seed) echo CLAIM_SEED_GRANTS ;;
    hook_debounce) echo HOOK_DEBOUNCE_GRANTS ;;
    thread_status) echo THREAD_STATUS_GRANTS ;;
    work) echo WORK_GRANTS ;;
    *) echo '' ;;
  esac
}

TESTS=(auth perm operator loops wake outbox_listener retention mandate_idle permission_expire bg bg_produce outbox_prune push_loop
  turn_lease inbox_list decide_core_db relay_live turn_settle turn_cancel health scheduled stale migrate delegation_deadline
  automation_grant claim_seed automation_sweep hook_debounce thread_status thread_plan db_retry deny_accounts invoke_gate deny_channels deny_reset work measure device_allow)
if [ "$#" -gt 0 ]; then TESTS=("$@"); fi

# 1. 틀 DB — Rust 마이그레이션 실행기로 한 번만 만든다.
admin "drop database if exists $TEMPLATE"
admin "create database $TEMPLATE"
tpl_url="$(url_for "$TEMPLATE")"
HARKROOM_RUST_MIGRATE=only DATABASE_MIGRATE_URL="$tpl_url" DATABASE_URL="$tpl_url" "$SERVER_BIN"

fail=()
for name in "${TESTS[@]}"; do
  db="t_${name}"
  admin "drop database if exists $db"
  admin "create database $db template $TEMPLATE"
  env_args=(HARKROOM_TEST_DATABASE_URL="$(url_for "$db")")
  table="$(grants_for "$name")"
  if [ -n "$table" ]; then
    role="rw_${name}"
    admin "drop role if exists $role"
    admin "create role $role login password '$role' nosuperuser nocreatedb nocreaterole nobypassrls connection limit 8"
    admin "grant pg_read_all_data to $role"
    arr="${table}[@]"
    for g in "${!arr}"; do psql "$(url_for "$db")" -v ON_ERROR_STOP=1 -qAt -c "grant $g to $role"; done
    env_args+=(HARKROOM_TEST_WRITE_DATABASE_URL="$(url_for "$db" "$role")")
  fi
  echo "::group::tests/${name}.rs"
  set +e
  out="$(env "${env_args[@]}" cargo test --manifest-path "$here/Cargo.toml" --locked ${CARGO_ARGS:-} --test "$name" -- --nocapture 2>&1)"
  code=$?
  set -e
  echo "$out"
  echo "::endgroup::"
  if [ "$code" -ne 0 ]; then fail+=("$name(exit $code)"); continue; fi
  # DB 가 없어 건너뛴 것을 통과로 읽지 않는다.
  if grep -q 'skip: HARKROOM_TEST_DATABASE_URL unset' <<<"$out"; then fail+=("$name(skipped)"); continue; fi
  if ! grep -Eq 'test result: ok\. [1-9][0-9]* passed' <<<"$out"; then fail+=("$name(0 passed)"); continue; fi
done

if [ "${#fail[@]}" -gt 0 ]; then
  echo "::error::Rust DB 시험 실패: ${fail[*]}"
  exit 1
fi
echo "Rust DB 시험 ${#TESTS[@]}개 통과"
