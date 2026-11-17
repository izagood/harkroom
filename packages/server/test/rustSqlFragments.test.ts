// Rust 앞단(`crates/harkroom-server`)이 `/inbox/today/*` 를 옮기며 쓰는 SQL 조각의 정본은 TS 다. Rust 는
// `crates/harkroom-server/golden/sql_fragments.json` 을 읽어 질의를 짓고, 이 시험이 그 파일이 TS 함수의 출력과 같은지 본다 —
// TS 의 가시성 술어(`channelVisibleSql`)를 고치고 골든을 안 고치면 여기서 빨개진다(Rust 만 옛 술어로 「내 것만」을 거르는 일을 막는다).
// 고칠 때: `UPDATE_RUST_SQL_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustSqlFragments.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { channelListVisibleSql, channelVisibleSql } from '../src/services/channels.js';
import { CHANNEL_DELETE_INFO_SQL, CHANNEL_POST_GATE_SQL, CHANNEL_MESSAGE_COUNT_SQL, CHANNEL_DOC_SQL, LIST_CHANNEL_MEMBERS_SQL, LIST_CHANNEL_PREFS_SQL, LIST_CHANNELS_SQL } from '../src/services/channels.js';
import { ALL_READ_STATES_SQL, READ_STATE_SQL } from '../src/services/readPositions.js';
import { LIST_CHANNEL_SECTIONS_SQL } from '../src/services/channelSections.js';
import { LIST_CHANNEL_AUTO_MENTIONS_SQL } from '../src/services/channelAutoMentions.js';
import { LIST_SCHEDULED_SQL } from '../src/services/scheduledMessages.js';
import { SELECT_PINS_SQL } from '../src/services/pins.js';
import { AGENT_INVOKER_SQL, CHANNEL_SCOPE_SQL, ELIGIBLE_DELEGATE_SQL, INVOKE_FACTS_SQL, TEAM_INVOKER_SQL } from '../src/services/invokeGate.js';
import { CLOSE_REPLY_GRANTS_SQL, HAS_REPLY_GRANT_SQL, OPEN_REPLY_GRANTS_SQL } from '../src/services/replyGrants.js';
import { MENTION_DEPTH_SCAN_SQL, OWN_THREAD_LINK_IDS_SQL, RECENT_BODIES_SQL, REPLY_LOCK_CLASS, STALL_SHADOW_SQL } from '../src/services/messages.js';
import { ASK_CLOSE_BY_REPLY_SQL } from '../src/services/messages.js';
import { CLOSE_REPLY_ITEM_V0_SQL, CLOSE_REPLY_ITEM_V2_SQL, CLOSE_REPLY_OPEN_SQL, DELEGATION_INSERT_SQL, DELEGATION_ITEM_INSERT_SQL, DELEGATION_TARGETS_SQL, LEAD_TEAM_SQL, ROUNDS_USED_MANY_SQL, DELEGATION_TOUCH_DEADLINE_SQL, DELEGATION_V2_UPDATE_PENDING_SQL } from '../src/services/delegations.js';
import { EDIT_FIND_SQL, EDIT_INBOX_ALREADY_SQL, EDIT_UPDATE_SQL, EDIT_VIA_EDIT_SQL } from '../src/services/messages.js';
import { ACCOUNTS_BY_HANDLES_SQL, ACCOUNTS_BY_IDS_SQL, FAN_OUT_AUDIENCE_SQL, INSERT_INBOX_MANY_SQL, REVEAL_HIDDEN_SQL, REVEAL_REASONS } from '../src/services/messages.js';
import { GROUP_BY_HANDLE_SQL, GROUP_MEMBERS_SQL } from '../src/services/handleGroups.js';
import { TEAM_BY_ID_SQL, TEAM_BY_NAME_SQL, TEAM_MEMBERS_SQL } from '../src/services/teams.js';
import { MENTION_POLICY_SQL } from '../src/services/mentionPolicy.js';
import { IMPLICIT_AGENT_CALLEES_SQL, IMPLICIT_LOCK_SQL, IMPLICIT_LOG_INSERT_SQL, IMPLICIT_PLAN_SQL, IMPLICIT_VERDICT_SQL } from '../src/services/implicitDelegation.js';
import { CAUSE_REASONS_SQL, PRINCIPAL_FOR_AGENT_POST_SQL, PRINCIPAL_INVOKES_SQL } from '../src/services/invokePrincipal.js';
import { MANDATE_FOR_AGENT_POST_SQL } from '../src/services/mandates.js';
import { CHAIN_BACKSTOP_OPEN_SQL, CHAIN_BACKSTOP_OWNER_SQL } from '../src/services/chainBackstop.js';
import { EFFECTIVE_MODEL_SQL } from '../src/services/reportedModel.js';
import { CAUSE_DEPTH_SQL, VERIFIED_CAUSE_LINK_SQL } from '../src/services/messages.js';
import { ENQUEUE_ASK_PUSH_SQL, ENQUEUE_INBOX_PUSH_MANY_SQL, INBOX_PUSH_REASON_LIST, PUSH_AGENT_REPLY_DELAY_SEC } from '../src/services/push/pushJobs.js';
import { HAS_OLDER_SQL, INBOX_FOLDED_WAKES_SQL, INBOX_HANDED_SQL, INBOX_STARTED_IN_SQL, INBOX_TEAM_ROSTER_SQL, LIST_INBOX_SQL, LIST_MESSAGES_SQL, MESSAGE_BY_ID_SQL, READ_LIST_ROW_SQL, SEARCH_MESSAGES_SQL } from '../src/services/messages.js';
import { POST_CHANNEL_KIND_SQL, POST_DM_PEERS_SQL, POST_IDEMPOTENCY_FIND_SQL, POST_IDEMPOTENCY_INSERT_SQL, POST_INSERT_SQL, POST_ROOT_AUTHOR_SQL, POST_THREAD_ROOT_OF_SQL, SEQ_LOCK_CLASS, SEQ_LOCK_SQL } from '../src/services/messages.js';
import { ATTACH_FIND_SQL, ATTACH_UPDATE_SQL } from '../src/services/attachments.js';
import { CHAT_APPROVAL_GUARD_WORDS } from '../src/services/chatApproval.js';
import { MANDATE_REPLY_CONTINUE_SQL, MANDATE_KEYLESS_OWN_SQL, MANDATE_KEYLESS_ROOT_SQL, MANDATE_KEYLESS_TOUCH_SQL, MANDATE_KEYLESS_INSERT_SQL, MANDATE_KEYLESS_FIND_SQL, MANDATE_KEYLESS_ROOT_SET_SQL, MANDATE_DELEGATED_AGENTS_SQL, MANDATE_OWN_AGENT_SQL, MANDATE_ROOT_INSERT_SQL, MESSAGE_SET_MANDATE_SQL } from '../src/services/mandates.js';
import { DECIDER_CHANNEL_SQL, DECIDER_LIST_SQL, DECIDER_ROW_SQL, DECIDER_SEEN_SQL } from '../src/services/deciders.js';
import { URL_CANDIDATE_SOURCE } from '@harkroom/shared';
import { ASK_BUNDLE_ITEM_SQL, GATE_AWAITING_SQL } from '../src/services/messages.js';
import { BUNDLE_PUSH_SQL } from '../src/services/push/pushJobs.js';
import { ACCEPT_ROOT_SQL, BUNDLE_ITEMS_UPDATE_SQL, DECISION_CARD_SQL, IRREVERSIBLE_WORDS, READ_BUNDLE_SQL } from '../src/services/askBundles.js';
import { CHILD_FACTS_AUDIENCE_SQL, PLAN_PROGRESS_PLANS_SQL } from '../src/services/threadPlan.js';
import { displayBodySql } from '../src/services/systemBody.js';
import { BG_AGENT_ON_SQL, BG_DAILY_LOCK_SQL, BG_ENQUEUE_SQL, BG_EXISTS_SQL, BG_PAUSED_SQL, CLEANUP_CANDIDATES_SQL, DISTILL_CANDIDATES_SQL, ORGANIZE_CANDIDATES_SQL } from '../src/services/bgJobs.js';
import { LIST_DELEGATIONS_GIVEN_SQL, LIST_DELEGATIONS_MINE_SQL } from '../src/services/apiDelegation.js';
import { COMMAND_GRANTS_SQL, LIST_TOOL_RULES_SQL, MANDATE_AGENT_CHANNEL_SQL, MANDATE_TURN_LEASE_SQL, MATCH_COMMAND_GRANT_SQL, TOOL_ALLOWS_SQL, TOOL_REACH_SQL } from '../src/services/permissionRequests.js';
import { READ_LEASE_SQL } from '../src/services/mergeGrants.js';
import { VALID_MANDATE_OWNER_SQL } from '../src/services/mandates.js';
import { ADD_LINE_AGENTS_SQL, ADD_LINE_INSERT_SQL, ADD_LINE_MANDATE_SQL, MANDATE_LINES_STORED_SQL } from '../src/services/mandateLines.js';
import { CARD_THREAD_DELEGATOR_SQL, CARD_THREAD_INSERT_SQL, CARD_THREAD_ROOT_SQL, CARD_THREAD_ROOT_STAMP_SQL, CARD_THREAD_TOUCH_SQL, LINE_FROM_REQUEST_OWNER_SQL, NEW_MANDATE_CARD_SQL, NEW_MANDATE_REQUEST_SQL } from '../src/services/permissionRequests.js';
import { LEASE_INBOX_MAX_AGE_MS, LEASE_MAX_MS, LEASE_MAX_REISSUES, LEASE_REISSUE_STALE_MS, LEASE_RENEW_MS, LEASE_TTL_MS, TURN_LEASE_CAUSE_SQL, TURN_LEASE_CLAIM_MOVED_SQL, TURN_LEASE_END_PRIOR_SQL, TURN_LEASE_END_SQL, TURN_LEASE_INSERT_SQL, TURN_LEASE_PRIOR_SQL, TURN_LEASE_RENEW_SQL, TURN_LEASE_USED_SQL } from '../src/services/secretAccess.js';
import { CANCEL_WAKES_FOR_TURN_SQL, FOLD_WAKES_FOR_DELEGATION_SQL, FOLD_WAKES_ON_REPORT_SQL, PREEMPT_CANCEL_SQL, PREEMPT_DUE_SQL, PREEMPT_FIRE_INBOX_SQL, PREEMPT_FIRE_SQL, STAMP_WAKE_CLOSED_SQL } from '../src/services/agentWakes.js';
import { CANCEL_AS_DELEGATE_SQL, CANCEL_AS_LEAD_SQL, CANCEL_DELEGATE_ITEM_SQL, CANCEL_LEAD_ITEMS_SQL, CANCEL_LEAD_MARK_SQL, CANCEL_LEAD_META_SQL, SETTLED_INBOX_SQL, SETTLED_MARK_SQL, SETTLED_META_SQL, SETTLED_STILL_SQL } from '../src/services/delegations.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/sql_fragments.json', import.meta.url));

it('Rust 가 쓰는 SQL 조각이 TS 정본과 같다', () => {
  const want = {
    channel_visible_c_p1uuid: channelVisibleSql('c', '$1::uuid'),
    // bg 생산(`loops/bg_produce.rs`, S5.3 C5c-3b) — 일감 넣기와 증류 후보, 문장 전체.
    bg_paused: BG_PAUSED_SQL,
    bg_agent_on: BG_AGENT_ON_SQL,
    bg_daily_lock: BG_DAILY_LOCK_SQL,
    bg_enqueue: BG_ENQUEUE_SQL,
    bg_exists: BG_EXISTS_SQL,
    bg_distill_candidates: DISTILL_CANDIDATES_SQL,
    bg_cleanup_candidates: CLEANUP_CANDIDATES_SQL,
    bg_organize_candidates: ORGANIZE_CANDIDATES_SQL,
    // MCP `grant.list`(`core/mcp/reads4.rs`, S5.3 C4b) — 위임 둘·명령 허용 하나, 완성 문장째.
    list_delegations_mine: LIST_DELEGATIONS_MINE_SQL,
    list_delegations_given: LIST_DELEGATIONS_GIVEN_SQL,
    list_tool_rules: LIST_TOOL_RULES_SQL,
    // grant 읽기 줄(`core/grant_reads.rs`, S5.3 C3b) — tool-allows·command-grants 의 문장 전체(match 는 쓰기라 TS).
    grant_tool_allows: TOOL_ALLOWS_SQL,
    grant_tool_reach: TOOL_REACH_SQL,
    grant_mandate_turn_lease: MANDATE_TURN_LEASE_SQL,
    grant_mandate_agent_channel: MANDATE_AGENT_CHANNEL_SQL,
    grant_valid_mandate_owner: VALID_MANDATE_OWNER_SQL,
    grant_mandate_lines_stored: MANDATE_LINES_STORED_SQL,
    // S5.3 C1 — 있는 위임장에 줄 쓰기(`core/mandate_line_write.rs`).
    mandate_line_from_request_owner: LINE_FROM_REQUEST_OWNER_SQL,
    mandate_line_add_mandate: ADD_LINE_MANDATE_SQL,
    mandate_line_add_agents: ADD_LINE_AGENTS_SQL,
    mandate_line_add_insert: ADD_LINE_INSERT_SQL,
    // S5.3 C2 — approve_new_mandate: 카드 스레드에 위임장 세우기(`core/mandate_card_thread.rs`).
    card_thread_root: CARD_THREAD_ROOT_SQL,
    card_thread_delegator: CARD_THREAD_DELEGATOR_SQL,
    card_thread_touch: CARD_THREAD_TOUCH_SQL,
    card_thread_insert: CARD_THREAD_INSERT_SQL,
    card_thread_root_stamp: CARD_THREAD_ROOT_STAMP_SQL,
    new_mandate_request: NEW_MANDATE_REQUEST_SQL,
    new_mandate_card: NEW_MANDATE_CARD_SQL,
    grant_command_grants: COMMAND_GRANTS_SQL,
    // 명령 grant 쓰기(`core/command_match.rs`, S5.3 C3b B1) — 임대 읽기와 grant 하나를 쓰는 UPDATE.
    grant_read_lease: READ_LEASE_SQL,
    grant_match_command: MATCH_COMMAND_GRANT_SQL,
    // 턴 임대(`core/turn_lease.rs`, S5.3 C6b) — 문장 전체와 시간 상수(ms·횟수는 문자열로).
    turn_lease_cause: TURN_LEASE_CAUSE_SQL,
    turn_lease_used: TURN_LEASE_USED_SQL,
    turn_lease_prior: TURN_LEASE_PRIOR_SQL,
    turn_lease_claim_moved: TURN_LEASE_CLAIM_MOVED_SQL,
    turn_lease_end_prior: TURN_LEASE_END_PRIOR_SQL,
    turn_lease_insert: TURN_LEASE_INSERT_SQL,
    turn_lease_end: TURN_LEASE_END_SQL,
    turn_lease_renew: TURN_LEASE_RENEW_SQL,
    turn_lease_consts: [LEASE_TTL_MS, LEASE_MAX_MS, LEASE_RENEW_MS, LEASE_INBOX_MAX_AGE_MS, LEASE_REISSUE_STALE_MS, LEASE_MAX_REISSUES].join(','),
    display_body_m: displayBodySql('m'),
    // 작업 항목(`workItems.ts::actorSeesItemSql`) — 주인이 아닌 쪽이 볼 수 있는 스레드인지, 별칭 ac·두째 인자.
    channel_visible_ac_p2uuid: channelVisibleSql('ac', '$2::uuid'),
    // 받는 사람 계산(`core/audience.rs`, S5.3 C1a) — 목록 이벤트 수신자(`channelListAudience`·`channelListLostAudience`)의 술어.
    channel_list_visible_c_aid_aadmin: channelListVisibleSql('c', 'a.id', 'a.is_admin'),
    // 링크 한 개 읽기(`core/msg_read.rs`, S5.3 C1b-1a) — `GET /messages/:id` 의 문장 전체(COLS 포함).
    message_by_id: MESSAGE_BY_ID_SQL,
    // 글 고치기(`core/msg_edit.rs`, S5.3 C3a-3c).
    edit_find: EDIT_FIND_SQL,
    edit_update: EDIT_UPDATE_SQL,
    edit_inbox_already: EDIT_INBOX_ALREADY_SQL,
    edit_via_edit: EDIT_VIA_EDIT_SQL,
    // 누구를 부르나·호출함 쓰기(`core/mention_calls.rs`·`mention_fanout.rs`, S5.3 C3a-3b). 목록·수는 JSON 글자로 싣는다.
    mc_accounts_by_handles: ACCOUNTS_BY_HANDLES_SQL,
    mc_accounts_by_ids: ACCOUNTS_BY_IDS_SQL,
    mc_group_by_handle: GROUP_BY_HANDLE_SQL,
    mc_group_members: GROUP_MEMBERS_SQL,
    mc_team_by_id: TEAM_BY_ID_SQL,
    mc_team_by_name: TEAM_BY_NAME_SQL,
    mc_team_members: TEAM_MEMBERS_SQL,
    mc_mention_policy: MENTION_POLICY_SQL,
    mc_principal_invokes: PRINCIPAL_INVOKES_SQL,
    mc_insert_inbox_many: INSERT_INBOX_MANY_SQL,
    mc_reveal_hidden: REVEAL_HIDDEN_SQL,
    mc_fan_out_audience: FAN_OUT_AUDIENCE_SQL,
    mc_enqueue_inbox_push_many: ENQUEUE_INBOX_PUSH_MANY_SQL,
    mc_reveal_reasons: JSON.stringify([...REVEAL_REASONS]),
    mc_inbox_push_reasons: JSON.stringify([...INBOX_PUSH_REASON_LIST]),
    mc_push_agent_reply_delay_sec: String(PUSH_AGENT_REPLY_DELAY_SEC),
    // 호출 게이트(`core/invoke_gate.rs`, S5.3 C3a-3b) — 누가 누구를 부를 수 있나.
    invoke_facts: INVOKE_FACTS_SQL,
    invoke_agent_invoker: AGENT_INVOKER_SQL,
    invoke_eligible_delegate: ELIGIBLE_DELEGATE_SQL,
    invoke_team_invoker: TEAM_INVOKER_SQL,
    invoke_channel_scope: CHANNEL_SCOPE_SQL,
    invoke_has_reply_grant: HAS_REPLY_GRANT_SQL,
    // 지우기·채널로 올리기·거두기(`core/msg_delete.rs`, S5.3 C3a-2) — 목록 한 행 다시 읽기와 쓰기 게이트.
    read_list_row: READ_LIST_ROW_SQL,
    channel_post_gate: CHANNEL_POST_GATE_SQL,
    // 채널 읽기(`core/channels.rs`, S5.3 C1e-1) — 각 GET 의 문장 전체.
    list_channels: LIST_CHANNELS_SQL,
    all_read_states: ALL_READ_STATES_SQL,
    read_state: READ_STATE_SQL,
    list_channel_members: LIST_CHANNEL_MEMBERS_SQL,
    list_channel_prefs: LIST_CHANNEL_PREFS_SQL,
    list_channel_sections: LIST_CHANNEL_SECTIONS_SQL,
    list_channel_auto_mentions: LIST_CHANNEL_AUTO_MENTIONS_SQL,
    channel_doc: CHANNEL_DOC_SQL,
    list_scheduled: LIST_SCHEDULED_SQL,
    select_pins: SELECT_PINS_SQL,
    channel_delete_info: CHANNEL_DELETE_INFO_SQL,
    channel_message_count: CHANNEL_MESSAGE_COUNT_SQL,
    // 채널·스레드 목록(`core/msg_list.rs`, S5.3 C1b-1b) — `listMessageRows` 의 갈래 9개와 `hasMore` 문장 3개, 완성 문장째.
    ...Object.fromEntries(Object.entries(LIST_MESSAGES_SQL).map(([k, v]) => [`list_messages_${k}`, v])),
    ...Object.fromEntries(Object.entries(HAS_OLDER_SQL).map(([k, v]) => [`has_older_${k}`, v])),
    // 계획판 진행률(`attachPlanProgress`·`childFacts`) — 목록 머리에 붙이는 두 문장.
    plan_progress_plans: PLAN_PROGRESS_PLANS_SQL,
    plan_progress_children: CHILD_FACTS_AUDIENCE_SQL,
    // 검색(`core/mcp/search.rs`, S5.3 C4a-6b) — MCP `message.search` 의 정렬 두 갈래, 완성 문장째.
    ...Object.fromEntries(Object.entries(SEARCH_MESSAGES_SQL).map(([k, v]) => [`search_messages_${k}`, v])),
    // 사람 최상위 글 올리기(`core/msg_post.rs`, S5.3 C1c-1) — seq 락·재시도 키·insert·첨부 잇기, 그리고 TS 로 넘길 글을 가르는 두 체
    // (링크 미리보기 URL 후보 정규식, 글 승인 넓은 체 낱말).
    post_seq_lock: SEQ_LOCK_SQL,
    post_seq_lock_class: String(SEQ_LOCK_CLASS),
    post_idempotency_find: POST_IDEMPOTENCY_FIND_SQL,
    post_insert: POST_INSERT_SQL,
    post_thread_root_of: POST_THREAD_ROOT_OF_SQL,
    post_root_author: POST_ROOT_AUTHOR_SQL,
    post_idempotency_insert: POST_IDEMPOTENCY_INSERT_SQL,
    post_channel_kind: POST_CHANNEL_KIND_SQL,
    post_dm_peers: POST_DM_PEERS_SQL,
    attach_find: ATTACH_FIND_SQL,
    attach_update: ATTACH_UPDATE_SQL,
    url_candidate_source: URL_CANDIDATE_SOURCE,
    chat_approval_guard_words: JSON.stringify([...CHAT_APPROVAL_GUARD_WORDS]),
    // 사람 새 머리의 부름과 위임(`core/msg_post.rs`, S5.3 C1c-2a) — `stampHumanMandate` 새 머리 갈래와 `mayDecideFor`.
    mandate_own_agent: MANDATE_OWN_AGENT_SQL,
    mandate_root_insert: MANDATE_ROOT_INSERT_SQL,
    mandate_delegated_agents: MANDATE_DELEGATED_AGENTS_SQL,
    message_set_mandate: MESSAGE_SET_MANDATE_SQL,
    mandate_reply_continue: MANDATE_REPLY_CONTINUE_SQL,
    mandate_keyless_own: MANDATE_KEYLESS_OWN_SQL,
    mandate_keyless_root: MANDATE_KEYLESS_ROOT_SQL,
    mandate_keyless_touch: MANDATE_KEYLESS_TOUCH_SQL,
    mandate_keyless_insert: MANDATE_KEYLESS_INSERT_SQL,
    mandate_keyless_find: MANDATE_KEYLESS_FIND_SQL,
    mandate_keyless_root_set: MANDATE_KEYLESS_ROOT_SET_SQL,
    // 사람 답글의 깨움 선점(`core/wake_preempt.rs`, S5.3 C1c-3b) — `preemptWakesForThread` 와 `stampWakeClosed`.
    preempt_due: PREEMPT_DUE_SQL,
    preempt_cancel: PREEMPT_CANCEL_SQL,
    preempt_fire_inbox: PREEMPT_FIRE_INBOX_SQL,
    preempt_fire: PREEMPT_FIRE_SQL,
    stamp_wake_closed: STAMP_WAKE_CLOSED_SQL,
    // 턴 중단 뒤 정리(`core/turn_settle.rs`, S5.3 C6c-3) — `settleCanceledTurn` 의 위임 의무·예약 닫기.
    cancel_as_delegate: CANCEL_AS_DELEGATE_SQL,
    cancel_delegate_item: CANCEL_DELEGATE_ITEM_SQL,
    cancel_as_lead: CANCEL_AS_LEAD_SQL,
    cancel_lead_items: CANCEL_LEAD_ITEMS_SQL,
    cancel_lead_meta: CANCEL_LEAD_META_SQL,
    cancel_lead_mark: CANCEL_LEAD_MARK_SQL,
    settled_still: SETTLED_STILL_SQL,
    settled_meta: SETTLED_META_SQL,
    settled_mark: SETTLED_MARK_SQL,
    settled_inbox: SETTLED_INBOX_SQL,
    fold_wakes_for_delegation: FOLD_WAKES_FOR_DELEGATION_SQL,
    fold_wakes_on_report: FOLD_WAKES_ON_REPORT_SQL,
    cancel_wakes_for_turn: CANCEL_WAKES_FOR_TURN_SQL,
    // 사람 답글로 카드 닫기(`core/ask_reply_close.rs`, S5.3 C1c-3c) — `closeAsksByReply`.
    ask_close_by_reply: ASK_CLOSE_BY_REPLY_SQL,
    // 사람 답글의 위임 활동(`core/msg_post.rs`, S5.3 C1c-3d) — `touchDelegationDeadline`·v1 대기 중 update.
    delegation_touch_deadline: DELEGATION_TOUCH_DEADLINE_SQL,
    reply_grant_open: OPEN_REPLY_GRANTS_SQL,
    reply_grant_close: CLOSE_REPLY_GRANTS_SQL,
    reply_grant_lock_class: String(REPLY_LOCK_CLASS),
    mention_depth_scan: MENTION_DEPTH_SCAN_SQL,
    // 정체 홉(`core/chain_stall.rs`, S5.3 C1c-4b) — 최근 본문·같은 대화 링크·그림자 대상.
    stall_recent_bodies: RECENT_BODIES_SQL,
    stall_own_thread_links: OWN_THREAD_LINK_IDS_SQL,
    stall_shadow: STALL_SHADOW_SQL,
    // 원인 입력(`core/cause_link.rs`, S5.3 C1c-4c) — MCP 글의 원인 깊이·사슬 고리·principal·위임·모델 어긋남.
    cause_depth: CAUSE_DEPTH_SQL,
    cause_verified_link: VERIFIED_CAUSE_LINK_SQL,
    cause_principal: PRINCIPAL_FOR_AGENT_POST_SQL,
    cause_reasons: CAUSE_REASONS_SQL,
    cause_mandate: MANDATE_FOR_AGENT_POST_SQL,
    effective_model: EFFECTIVE_MODEL_SQL,
    // 암묵 위임(`core/implicit_delegation.rs`, S5.3 C1c-4d) — 줄 세우기·계획판·판정·기록·위임 행.
    implicit_agent_callees: IMPLICIT_AGENT_CALLEES_SQL,
    implicit_lock: IMPLICIT_LOCK_SQL,
    implicit_plan: IMPLICIT_PLAN_SQL,
    implicit_verdict: IMPLICIT_VERDICT_SQL,
    implicit_log_insert: IMPLICIT_LOG_INSERT_SQL,
    delegation_insert: DELEGATION_INSERT_SQL,
    delegation_item_insert: DELEGATION_ITEM_INSERT_SQL,
    // S5.3 C1c-4d-2 백스톱 카드(`core/chain_backstop.rs`) — 소유자·열린 카드·ask 푸시, 완성 문장째.
    chain_backstop_owner: CHAIN_BACKSTOP_OWNER_SQL,
    chain_backstop_open: CHAIN_BACKSTOP_OPEN_SQL,
    enqueue_ask_push: ENQUEUE_ASK_PUSH_SQL,
    delegation_v2_update_pending: DELEGATION_V2_UPDATE_PENDING_SQL,
    close_reply_open: CLOSE_REPLY_OPEN_SQL,
    close_reply_item_v0: CLOSE_REPLY_ITEM_V0_SQL,
    close_reply_item_v2: CLOSE_REPLY_ITEM_V2_SQL,
    decider_row: DECIDER_ROW_SQL,
    decider_seen: DECIDER_SEEN_SQL,
    decider_list: DECIDER_LIST_SQL,
    decider_channel: DECIDER_CHANNEL_SQL,
    // 묶음 카드 REST(`core/ask_bundle.rs`, S5.3 C3b-2a) — 묶음 읽기·결정 카드 표지·추천대로의 원본 읽기, 되돌릴 수 없는 낱말(정규식 원문·깃발).
    bundle_read: READ_BUNDLE_SQL,
    bundle_decision_card: DECISION_CARD_SQL,
    bundle_accept_root: ACCEPT_ROOT_SQL,
    bundle_irreversible_source: IRREVERSIBLE_WORDS.source,
    bundle_irreversible_flags: IRREVERSIBLE_WORDS.flags,
    // 있던 묶음에 줄 더하기(`core/ask_bundle_add.rs`, S5.3 C3b-2b-2).
    bundle_item_root: ASK_BUNDLE_ITEM_SQL,
    bundle_items_update: BUNDLE_ITEMS_UPDATE_SQL,
    gate_awaiting: GATE_AWAITING_SQL,
    bundle_push: BUNDLE_PUSH_SQL,
    // 받은함 목록(`core/inbox_list.rs`, S5.3 C6a-3a) — `GET /inbox` 갈래 다섯과 팀 명단, 완성 문장째.
    ...Object.fromEntries(Object.entries(LIST_INBOX_SQL).map(([k, v]) => [`list_inbox_${k}`, v])),
    inbox_team_roster: INBOX_TEAM_ROSTER_SQL,
    // 받은함 덧붙임(C6a-3b) — 넘겨받은 일·접힌 깨움·시작한 곳.
    inbox_handed: INBOX_HANDED_SQL,
    inbox_folded_wakes: INBOX_FOLDED_WAKES_SQL,
    inbox_started_in: INBOX_STARTED_IN_SQL,
    // MCP delegate 게이트(`core/mcp/delegate_gate.rs`, S5.3 C3b-2c-4a) — 팀장 명단·대상·라운드.
    delegate_lead_team: LEAD_TEAM_SQL,
    delegate_targets: DELEGATION_TARGETS_SQL,
    delegate_rounds_used: ROUNDS_USED_MANY_SQL,
  };
  const text = `${JSON.stringify(want, null, 2)}\n`;
  if (process.env.UPDATE_RUST_SQL_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});

// S5.3 C5c-3b-2 — bg 생산 문턱은 Rust 가 상수로 따로 든다(`loops/bg_produce.rs`). TS 값과 하나라도 다르면 두 쪽 판정이 갈린다.
it('bg 생산 문턱 상수가 TS 와 같다', async () => {
  const { readFileSync } = await import('node:fs');
  const shared = await import('@harkroom/shared');
  const bg = await import('../src/services/bgJobs.js');
  const rs = readFileSync(fileURLToPath(new URL('../../../crates/harkroom-server/src/loops/bg_produce.rs', import.meta.url)), 'utf8');
  const num = (name: string): number => {
    const m = new RegExp(`pub const ${name}: \\w+ = ([^;]+);`).exec(rs);
    expect(m, name).not.toBeNull();
    // `7 * 24 * 60 * 60`·`14.0 * 24.0 …` 같은 곱만 쓴다.
    return m![1]!.split('*').map((x) => Number(x.trim())).reduce((a, b) => a * b, 1);
  };
  expect(num('MEMORY_CORE_WARN_CHARS')).toBe(shared.MEMORY_CORE_WARN_CHARS);
  expect(num('MEMORY_ITEMS_WARN_COUNT')).toBe(shared.MEMORY_ITEMS_WARN_COUNT);
  expect(num('MAX_JOURNAL_MEMORIES_PER_ACCOUNT')).toBe(shared.MAX_JOURNAL_MEMORIES_PER_ACCOUNT);
  expect(num('JOURNAL_EXPIRING_WINDOW')).toBe(shared.JOURNAL_EXPIRING_WINDOW);
  expect(num('CLEANUP_WEEKLY_MIN_ITEMS')).toBe(bg.CLEANUP_WEEKLY_MIN_ITEMS);
  expect(num('CLEANUP_WEEKLY_SECS') * 1000).toBe(bg.CLEANUP_WEEKLY_MS);
  expect(num('ORGANIZE_MIN_CHANGES')).toBe(bg.ORGANIZE_MIN_CHANGES);
  expect(num('ORGANIZE_MAX_GAP_SECS') * 1000).toBe(bg.ORGANIZE_MAX_GAP_MS);
  expect(num('BG_PAUSE_AFTER_FAILURES')).toBe(bg.BG_PAUSE_AFTER_FAILURES);
  expect(num('BG_WINDOW_END_KST')).toBe(bg.BG_WINDOW_KST[1]);
  expect(num('DISTILL_MAX_THREADS')).toBe(bg.DISTILL_MAX_THREADS);
  expect(num('PRODUCE_INTERVAL_SECS') * 1000).toBe(bg.DISTILL_PRODUCE_INTERVAL_MS);
});
