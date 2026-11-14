// Rust 앞단(`crates/harkroom-server`)이 `/inbox/today/*` 를 옮기며 쓰는 SQL 조각의 정본은 TS 다. Rust 는
// `crates/harkroom-server/golden/sql_fragments.json` 을 읽어 질의를 짓고, 이 시험이 그 파일이 TS 함수의 출력과 같은지 본다 —
// TS 의 가시성 술어(`channelVisibleSql`)를 고치고 골든을 안 고치면 여기서 빨개진다(Rust 만 옛 술어로 「내 것만」을 거르는 일을 막는다).
// 고칠 때: `UPDATE_RUST_SQL_GOLDEN=1 pnpm --filter @harkroom/server exec vitest run test/rustSqlFragments.test.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { channelListVisibleSql, channelVisibleSql } from '../src/services/channels.js';
import { CHANNEL_DELETE_INFO_SQL, CHANNEL_MESSAGE_COUNT_SQL, CHANNEL_DOC_SQL, LIST_CHANNEL_MEMBERS_SQL, LIST_CHANNEL_PREFS_SQL, LIST_CHANNELS_SQL } from '../src/services/channels.js';
import { ALL_READ_STATES_SQL, READ_STATE_SQL } from '../src/services/readPositions.js';
import { LIST_CHANNEL_SECTIONS_SQL } from '../src/services/channelSections.js';
import { LIST_CHANNEL_AUTO_MENTIONS_SQL } from '../src/services/channelAutoMentions.js';
import { LIST_SCHEDULED_SQL } from '../src/services/scheduledMessages.js';
import { SELECT_PINS_SQL } from '../src/services/pins.js';
import { HAS_OLDER_SQL, LIST_MESSAGES_SQL, MESSAGE_BY_ID_SQL } from '../src/services/messages.js';
import { CHILD_FACTS_AUDIENCE_SQL, PLAN_PROGRESS_PLANS_SQL } from '../src/services/threadPlan.js';
import { displayBodySql } from '../src/services/systemBody.js';

const GOLDEN = fileURLToPath(new URL('../../../crates/harkroom-server/golden/sql_fragments.json', import.meta.url));

it('Rust 가 쓰는 SQL 조각이 TS 정본과 같다', () => {
  const want = {
    channel_visible_c_p1uuid: channelVisibleSql('c', '$1::uuid'),
    display_body_m: displayBodySql('m'),
    // 작업 항목(`workItems.ts::actorSeesItemSql`) — 주인이 아닌 쪽이 볼 수 있는 스레드인지, 별칭 ac·두째 인자.
    channel_visible_ac_p2uuid: channelVisibleSql('ac', '$2::uuid'),
    // 받는 사람 계산(`core/audience.rs`, S5.3 C1a) — 목록 이벤트 수신자(`channelListAudience`·`channelListLostAudience`)의 술어.
    channel_list_visible_c_aid_aadmin: channelListVisibleSql('c', 'a.id', 'a.is_admin'),
    // 링크 한 개 읽기(`core/msg_read.rs`, S5.3 C1b-1a) — `GET /messages/:id` 의 문장 전체(COLS 포함).
    message_by_id: MESSAGE_BY_ID_SQL,
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
  };
  const text = `${JSON.stringify(want, null, 2)}\n`;
  if (process.env.UPDATE_RUST_SQL_GOLDEN === '1') writeFileSync(GOLDEN, text);
  expect(readFileSync(GOLDEN, 'utf8')).toBe(text);
});
