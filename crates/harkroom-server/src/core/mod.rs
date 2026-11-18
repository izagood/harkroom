//! S5.3 코어(C0 뼈대) — TS 서버가 프로세스 메모리로 쥐던 것을 Rust 로 옮기는 자리. 스위치 `HARKROOM_CORE`(`ts` 기본 · `rust`)가
//! `rust` 일 때만 마운트한다 — 기본값으로는 앞단 동작이 지금과 같다(운영 Ingress 는 `/ws` 를 아직 TS 로 보낸다, C6 에서 바꾼다).
//!
//! C0 가 담는 것: POST `/ws-ticket` · GET `/ws`(TS `ws/wsPlugin.ts`·`tickets.ts`·`heartbeat.ts`·`appHeartbeat.ts`·`socketLifetime.ts`·
//! `credentials.ts`·`typing.ts`) · 이벤트 공급(outbox LISTEN → 프로세스 안 팬아웃, TS `eventBus.ts` 와 같은 순서·모양 검사).
//! 에이전트 presence 는 TS `presence.ts` 가 폴마다 묶어 쓰는 `agent_presence`(C6c-1)를 읽어 스냅샷에 합친다.
pub mod account_grant_revoke;
pub mod account_grants_read;
pub mod account_handle;
pub mod account_keys_activity;
pub mod account_login_ids;
pub mod account_reset_code_issue;
pub mod account_reset_code_revoke;
pub mod account_role;
pub mod account_self;
pub mod agent_config_read;
pub mod agent_grants_read;
pub mod agent_memory_audit_read;
pub mod agent_memory_read;
pub mod agent_memory_write;
pub mod agent_model_options;
pub mod agent_secret_create;
pub mod agent_secret_reveal;
pub mod agent_wakes_read;
pub mod ask;
pub mod ask_bundle;
pub mod ask_bundle_add;
pub mod ask_bundle_resolve;
pub mod ask_reply_close;
pub mod ask_sync;
pub mod attachment_download;
pub mod attachment_store;
pub mod attachment_upload;
pub mod audience;
pub mod auth_light;
pub mod auth_login;
pub mod auth_password;
pub mod auth_signup;
pub mod automation_approve;
pub mod automation_create;
pub mod automation_delete;
pub mod automation_run_now;
pub mod automation_time;
pub mod automations_read;
pub mod automations_write;
pub mod avatar_read;
pub mod avatar_write;
pub mod cause_link;
pub mod chain_backstop;
pub mod chain_stall;
pub mod channel_auto_mention_doc;
pub mod channel_create_update;
pub mod channel_delete;
pub mod channel_files;
pub mod channel_members;
pub mod channel_pins_sched;
pub mod channel_pref_write;
pub mod channel_read_write;
pub mod channel_team_add;
pub mod channels;
pub mod command_match;
pub mod connectors_upsert;
pub mod connectors_write;
pub mod content_scan;
pub mod decide_approve;
pub mod decide_check;
pub mod decide_core;
pub mod decide_routes;
pub mod delegate_write;
pub mod dm_open;
pub mod events;
pub mod grant_reads;
pub mod implicit_delegation;
pub mod inbox_board;
pub mod inbox_list;
pub mod inbox_read;
pub mod inbox_rest;
pub mod inbox_thread;
pub mod inbox_threads;
pub mod invites_write;
pub mod invoke_gate;
pub mod join_page;
pub mod mandate_card_thread;
pub mod mandate_end;
pub mod mandate_line_write;
pub mod mandate_lines_read;
pub mod mandate_stamp;
pub mod mcp;
pub mod mem_search;
pub mod mention_calls;
pub mod mention_fanout;
pub mod mention_parse;
pub mod merge_approval_peek;
pub mod merge_closed;
pub mod merge_denial_grant;
pub mod misc_reads;
pub mod msg_delete;
pub mod msg_edit;
pub mod msg_list;
pub mod msg_post;
pub mod msg_react;
pub mod msg_read;
pub mod operator;
pub mod operator_assign;
pub mod operator_capability;
pub mod operator_frames;
pub mod operator_guard;
pub mod operator_hub;
pub mod operator_merge_lines;
pub mod operator_rest;
pub mod operator_restart;
pub mod operator_stop;
pub mod password_reset_use;
pub mod perm_card;
pub mod pickable_models;
pub mod plan_graph;
pub mod pr_watch_due;
pub mod relay;
pub mod relay_attention;
pub mod relay_link;
pub mod relay_live;
pub mod relay_routes;
pub mod saved;
pub mod search_rest;
pub mod secret_grant_give;
pub mod secret_reveal;
pub mod secret_writes;
pub mod secrets_read;
pub mod sections_write;
pub mod settings_rest;
pub mod step_up_end;
pub mod step_up_open;
pub mod thread_model_clear;
pub mod thread_models_read;
pub mod thread_plan_auto_off;
pub mod thread_plan_manager;
pub mod thread_plan_read;
pub mod tickets;
pub mod turn_lease;
pub mod turn_lease_routes;
pub mod turn_settle;
pub mod typing;
pub mod wake_preempt;
pub mod ws;

/// `HARKROOM_CORE` — 모르는 값이면 기동을 멈춘다(조용히 켜지거나 꺼지지 않게).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreMode {
    Ts,
    Rust,
}

pub fn parse_mode(raw: Option<&str>) -> Result<CoreMode, String> {
    match raw.map(str::trim).unwrap_or("") {
        "" | "ts" => Ok(CoreMode::Ts),
        "rust" => Ok(CoreMode::Rust),
        v => Err(format!(
            "HARKROOM_CORE={v:?} is not understood — use ts or rust"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse() {
        assert_eq!(parse_mode(None), Ok(CoreMode::Ts));
        assert_eq!(parse_mode(Some(" ts ")), Ok(CoreMode::Ts));
        assert_eq!(parse_mode(Some("rust")), Ok(CoreMode::Rust));
        assert!(parse_mode(Some("Rust")).is_err());
        assert!(parse_mode(Some("on")).is_err());
    }
}
