// Rust 공용 프로토콜 crate(`crates/harkroom-proto`·`crates/harkroom-roots`)의 골든 — S1, Rust 전환.
//
// 정본은 이 TS 타입이다. 아래 표본은 `satisfies` 로 **TS 타입 검사를 통과한 값**이고, 이 시험이 그것을
// `crates/harkroom-proto/golden/proto.json` 과 비교한다(다르면 빨강). TS 프로토콜을 바꿨다면
// `UPDATE_PROTO_GOLDEN=1 npx vitest run test/protoGolden.test.ts` 로 다시 쓰고, Rust 쪽 `cargo test` 가 같은 파일을
// 읽어 **파싱 → 다시 직렬화 = 원본**(왕복)을 확인한다. 새 변종을 TS 에 더했는데 표본이 없으면 Rust 는 모른다 —
// 변종을 더할 때 여기 표본도 하나 더한다(타입별 `type` 목록이 Rust 의 변종 목록과 같은지도 Rust 시험이 본다).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVENT_NAMES, MAX_LINE_BYTES, REQUEST_TYPES,
  type DaemonError, type DaemonErrorCode, type DaemonEventMessage, type DaemonRequest, type DaemonResponse, type HelloMessage, type HelloResult,
} from '../src/daemonProtocol.js';
import { DAEMON_PROTOCOL_VERSION, daemonEndpointPaths } from '../src/daemonEndpoint.js';
import type { OperatorToServerFrame, ServerToOperatorFrame } from '../src/operatorProtocol.js';
import {
  COMMUNITY_ROOT_HASH_FALLBACK_LENGTH, COMMUNITY_ROOT_HASH_LENGTH, OPERATOR_ROOTS_INDEX_FILE, SOCKET_PATH_LIMIT_BYTES,
  communityRootHash, communityRootKey, resolveCommunityRoot, type OperatorRootsIndex,
} from '../src/operatorRoots.js';
import { PROVIDER_LANE_FAILURE_CODES } from '../src/providerLane.js';
import {
  RUNNER_LINK_PROTOCOL_VERSION,
  type OperatorToRunnerNotice, type RunnerHello, type RunnerLinkNotice, type RunnerLinkRejectedNotice, type RunnerLinkRequest, type RunnerLinkResponse,
} from '../src/runnerLink.js';

const GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-proto', 'golden', 'proto.json');
const ROOTS_GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-roots', 'golden', 'roots.json');

const ID = '00000000-aaaa-4bbb-8ccc-000000000001';
const RUNNER = 'r-00000000-0000-4000-8000-000000000002';
const SESSION = { id: 'ses-1', agentId: ID } as const;

// ── P1 러너 ↔ 오퍼레이터 링크 ──────────────────────────────────────────────────────────────
const p1Hello = [
  { type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner', runnerId: RUNNER, secret: 'example-secret' },
  { type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner', runnerId: RUNNER, turnKey: 'a'.repeat(64), kind: 'wrapper' },
  { type: 'hello', version: RUNNER_LINK_PROTOCOL_VERSION, role: 'runner', runnerId: RUNNER, secret: 'example-secret', kind: 'bridge' },
] satisfies RunnerHello[];

const p1Request = [
  { type: 'mcp.request', id: 'l1', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } },
  { type: 'mcp.request', id: 'l2', payload: { jsonrpc: '2.0', method: 'notifications/initialized' }, cause: ID, cwd: '/tmp/ws', turnId: ID, commandFiles: '[]' },
  { type: 'http.forward', id: 'h1', method: 'GET', path: '/agent/me' },
  { type: 'http.forward', id: 'h2', method: 'POST', path: '/attachments', bodyBase64: 'aGk=', contentType: 'multipart/form-data; boundary=x' },
  { type: 'http.forward', id: 'h3', method: 'POST', path: '/agent/turn-keys', body: '{"a":1}' },
] satisfies RunnerLinkRequest[];

const p1Response = [
  { type: 'mcp.response', id: 'l1', messages: [{ jsonrpc: '2.0', id: 1, result: { tools: [] } }] },
  { type: 'mcp.response', id: 'l2', messages: [] },
  { type: 'mcp.error', id: 'l3', status: 401, message: 'unauthorized' },
  { type: 'http.response', id: 'h1', status: 200, body: '{}' },
] satisfies RunnerLinkResponse[];

const p1Notice = [
  { type: 'runner.pollStopped', holding: [1, 2] },
  { type: 'runner.pollStopped', holding: [], done: [3] },
  { type: 'mcp.authRejected', servers: ['example'], turnStartedAtMs: 1_700_000_000_000 },
  { type: 'secret.lease', cause: ID, leaseId: 'lease-1', token: 'example-token', expiresAt: '2026-01-01T00:00:00.000Z' },
  { type: 'secret.leaseEnded', cause: ID },
  { type: 'secret.leaseHeartbeat', cause: ID },
  { type: 'providerLane.result', ok: true },
  { type: 'providerLane.result', ok: false, code: 'lane_unset' },
  { type: 'providerLane.mode', on: true },
  { type: 'providerLane.turn', ok: false },
] satisfies RunnerLinkNotice[];

const p1OperatorNotice = [{ type: 'handover.released' }] satisfies OperatorToRunnerNotice[];
const p1Rejected = [{ type: 'link.rejected', reason: 'unknown_runner' }] satisfies RunnerLinkRejectedNotice[];

// ── P2 오퍼레이터 ↔ 서버 WS ──────────────────────────────────────────────────────────────
// 깊은 도메인 객체(AgentSessionView·OperatorCapabilities·status…)는 Rust 쪽에서 아직 JSON 값 그대로다 — 모양만 실어 둔다.
const caps = { harnesses: ['codex'] } as unknown as Extract<OperatorToServerFrame, { type: 'capabilities' }>['capabilities'];
const session = SESSION as unknown as Extract<OperatorToServerFrame, { type: 'session.started' }>['session'];
const p2OperatorToServer = [
  { type: 'hello', protocol: 1, capabilities: caps, runners: [{ agentId: ID, runnerId: RUNNER, pid: 4242 }], sessions: [session] },
  { type: 'hello', protocol: 1, capabilities: caps, runners: [], sessions: [], version: '0.4.500' },
  { type: 'runner.started', agentId: ID, runnerId: RUNNER },
  { type: 'runner.exited', runnerId: RUNNER, code: null },
  { type: 'runner.exited', runnerId: RUNNER, code: 78, reason: 'credential', agentId: ID },
  { type: 'capabilities', capabilities: caps },
  { type: 'status', status: { turns: { running: 1, max: 4 } } },
  { type: 'status', status: { turns: { running: 0, max: null } }, machine: 'f'.repeat(64) },
  { type: 'upgrade.progress', stage: 'download' },
  { type: 'upgrade.progress', stage: 'failed', from: '0.4.1', to: '0.4.2', error: 'checksum' },
  { type: 'gh.report', report: { reach: true } },
  { type: 'gh.lines.result', requestId: 'g1', ok: true },
  { type: 'gh.lines.result', requestId: 'g2', ok: false, code: 'unknown_login', previous: null },
  { type: 'runner.announce', runnerId: RUNNER, sessions: [session] },
  { type: 'runner.announce', runnerId: RUNNER, sessions: [], caps: ['interactive'] as unknown as Extract<OperatorToServerFrame, { type: 'runner.announce' }>['caps'] },
  { type: 'session.started', runnerId: RUNNER, session },
  { type: 'session.updated', runnerId: RUNNER, session },
  { type: 'session.ended', runnerId: RUNNER, sessionId: 'ses-1' },
  { type: 'pty.output', runnerId: RUNNER, sessionId: 'ses-1', bytes: 'aGk=' },
  { type: 'pty.replay', runnerId: RUNNER, sessionId: 'ses-1', bytes: '' },
  { type: 'interactive.opened', runnerId: RUNNER, requestId: 'i1', sessionId: 'ses-1', created: true },
  { type: 'interactive.error', runnerId: RUNNER, requestId: 'i1', message: 'busy' },
  { type: 'attention.required', runnerId: RUNNER, sessionId: 'ses-1', accountLabel: 'example', screen: 'Do you want to proceed?' },
  { type: 'local.input', runnerId: RUNNER, sessionId: 'ses-1', gen: 3, bytes: 12 },
] satisfies OperatorToServerFrame[];

const p2ServerToOperator = [
  {
    type: 'assign', agentId: ID, definition: {
      agentId: ID, handle: 'example-agent', harness: 'codex', instructions: '', model: null, effort: 'high', mentionPermission: 'anyone',
      workingDirDefault: null, credentialScope: 'personal', ownerAccountId: ID, mcpServers: ['avcs'],
    },
  },
  { type: 'unassign', agentId: ID, drain: true },
  { type: 'agent.restart', agentId: ID },
  { type: 'runner.kill', runnerId: RUNNER },
  { type: 'pty.replay.request', runnerId: RUNNER, sessionId: 'ses-1' },
  { type: 'pty.input', runnerId: RUNNER, sessionId: 'ses-1', bytes: 'DQ==' },
  { type: 'pty.resize', runnerId: RUNNER, sessionId: 'ses-1', cols: 120, rows: 40 },
  { type: 'viewer.count', runnerId: RUNNER, sessionId: 'ses-1', count: 2 },
  { type: 'session.cancel', runnerId: RUNNER, sessionId: 'ses-1', byHandle: 'example' },
  { type: 'interactive.open', runnerId: RUNNER, requestId: 'i1', channelId: ID, threadRootId: ID, openedByHandle: 'example' },
  { type: 'interactive.open', runnerId: RUNNER, requestId: 'i2', channelId: ID, threadRootId: ID, openedByHandle: 'example', cols: 100, rows: 30 },
  { type: 'local.writer', runnerId: RUNNER, sessionId: 'ses-1', writerKey: null, gen: 1 },
  { type: 'local.view', runnerId: RUNNER, sessionId: 'ses-1', viewKey: 'k', granted: true },
  { type: 'gh.lines.set', requestId: 'g1', scope: 'example/*', ghUser: null },
] satisfies ServerToOperatorFrame[];

// ── P3 앱(Tauri) ↔ 오퍼레이터 소켓 — 봉투. 요청별 payload 타입은 S2 앞 PR 에서 Rust 로 옮긴다. ─────────────
const daemonErrorCodes = [
  'line-too-long', 'invalid-json', 'version-mismatch', 'unauthorized', 'not-authenticated', 'unknown-request', 'bad-payload', 'no-such-runner', 'retiring', 'internal',
] as const satisfies readonly DaemonErrorCode[];
// 위 목록이 TS 유니온을 빠짐없이 덮는지 — 하나라도 빠지면 이 줄이 타입 오류다.
const _allCodes: Record<DaemonErrorCode, true> = Object.fromEntries(daemonErrorCodes.map((c) => [c, true])) as Record<(typeof daemonErrorCodes)[number], true>;
void _allCodes;
const err: DaemonError = { code: 'bad-payload', message: 'payload.agentId is required' };
const p3Hello = [{ type: 'hello', version: DAEMON_PROTOCOL_VERSION, token: 'example-token', role: 'app' }] satisfies HelloMessage[];
const p3HelloResult = [
  { ok: true, daemon: { pid: 4242, startedAtMs: 1_700_000_000_000, launchNonce: 'n1', entryPath: '/Applications/Example.app/Contents/MacOS/harkroom-operator', appVersion: '0.4.500' } },
  { ok: false, error: { code: 'version-mismatch', message: 'expected 1' } },
] satisfies HelloResult[];
const p3Request = [
  { id: 'q1', type: 'ping' },
  { id: 'q2', type: 'spawnRunner', payload: { agentId: ID, env: { A: '1' } } },
] satisfies DaemonRequest[];
const p3Response = [
  { id: 'q1', ok: true, payload: { pong: true } },
  { id: 'q2', ok: false, error: err },
  { id: 'q3', ok: true },
] satisfies DaemonResponse[];
const p3Event = [
  { type: 'event', event: 'runnerExit', payload: { runnerId: RUNNER, code: 0 } },
  { type: 'event', event: 'terminalEnded', payload: null },
] satisfies DaemonEventMessage[];

// ── P4 `harkroom-operator merge` 한 줄 출력(operator `main.ts::mergeMain` + `turnMerge.ts`). 에이전트 지시문·허용 규칙이 이 키에 기댄다. ──
const p4MergeOutput = [
  { merged: true, queued: false, repo: 'example/repo', number: 12, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), grantedBy: ID, viaApproval: false, ghUser: 'example', note: 'reported to the thread as a system line', exit: 0 },
  { merged: true, queued: false, repo: 'example/repo', number: 12, headSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40), grantedBy: null, viaApproval: true, ghUser: 'example', ignoredChecks: ['lint'], noPrChecks: true, note: 'merged with no checks', exit: 0 },
  { merged: false, queued: true, alreadyQueued: false, repo: 'example/repo', number: 12, headSha: 'a'.repeat(40), queue: { position: 2 }, grantedBy: ID, viaApproval: false, ghUser: 'example', note: 'added to the merge queue', exit: 0 },
  { merged: false, queued: true, alreadyQueued: true, repo: 'example/repo', number: 12, headSha: 'a'.repeat(40), prHeadRefOid: null, queue: null, note: 'already in the merge queue', exit: 0 },
  { error: { code: 'not_granted', message: 'merge not allowed: not_granted', denialId: ID }, merged: false, exit: 1 },
  { error: { code: 'ci_not_green', message: 'required checks are not green', denialId: ID }, pr: { state: 'OPEN' }, merged: false, exit: 1 },
  { error: { code: 'bad_request', message: 'usage: merge <owner/name> <number> --head <sha>' }, merged: false, exit: 2 },
  { raw: 'not json', merged: false, exit: 1 },
];

function build() {
  return {
    note: 'generated by packages/shared/test/protoGolden.test.ts — do not edit by hand',
    constants: {
      runnerLinkProtocolVersion: RUNNER_LINK_PROTOCOL_VERSION,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      maxLineBytes: MAX_LINE_BYTES,
      requestTypes: [...REQUEST_TYPES],
      eventNames: [...EVENT_NAMES],
      daemonErrorCodes: [...daemonErrorCodes],
      providerLaneFailureCodes: [...PROVIDER_LANE_FAILURE_CODES],
    },
    p1: { hello: p1Hello, request: p1Request, response: p1Response, notice: p1Notice, operatorNotice: p1OperatorNotice, rejected: p1Rejected },
    p2: { operatorToServer: p2OperatorToServer, serverToOperator: p2ServerToOperator },
    p3: { hello: p3Hello, helloResult: p3HelloResult, request: p3Request, response: p3Response, event: p3Event },
    p4: { mergeOutput: p4MergeOutput },
  };
}

// ── P5 로컬 공유 파일 — `operators.json` 색인과 커뮤니티 뿌리 규칙(Tauri `community_root.rs`·오퍼레이터가 같은 규칙을 쓴다). ──
const HOME = '/home/example';
const BASES = ['https://one.example.com', 'https://one.example.com/', 'https://one.example.com///', 'https://two.example.com/sub', 'http://127.0.0.1:3400'];
function buildRoots() {
  const index: OperatorRootsIndex = {
    version: 1,
    communities: {
      'https://legacy.example.com': { root: `${HOME}/Library/Application Support/app.example/daemon`, operatorId: ID, legacy: true },
      'https://taken.example.com': { root: `${HOME}/.harkroom-agent/c/${communityRootHash('https://clash.example.com')}` },
    },
  };
  const cases = [
    ...BASES.map((b) => ({ home: HOME, baseUrl: b, index: { version: 1, communities: {} } as OperatorRootsIndex })),
    { home: HOME, baseUrl: 'https://legacy.example.com', index },
    { home: HOME, baseUrl: 'https://clash.example.com', index },
    { home: `/Users/${'x'.repeat(60)}`, baseUrl: 'https://long.example.com', index: { version: 1, communities: {} } as OperatorRootsIndex },
  ];
  return {
    note: 'generated by packages/shared/test/protoGolden.test.ts — do not edit by hand',
    constants: {
      indexFile: OPERATOR_ROOTS_INDEX_FILE, socketPathLimitBytes: SOCKET_PATH_LIMIT_BYTES,
      hashLength: COMMUNITY_ROOT_HASH_LENGTH, hashFallbackLength: COMMUNITY_ROOT_HASH_FALLBACK_LENGTH,
    },
    keys: BASES.map((b) => ({ baseUrl: b, key: communityRootKey(b), hash8: communityRootHash(b), hash16: communityRootHash(b, 16) })),
    endpoint: daemonEndpointPaths(`${HOME}/.harkroom-agent/c/abcd1234`),
    resolve: cases.map((c) => ({ ...c, result: resolveCommunityRoot(c.home, c.baseUrl, c.index) })),
    indexSample: index,
  };
}

describe('Rust 공용 프로토콜 골든', () => {
  for (const [file, make, env] of [[GOLDEN, build, 'UPDATE_PROTO_GOLDEN'], [ROOTS_GOLDEN, buildRoots, 'UPDATE_PROTO_GOLDEN']] as const) {
    it(`정본(TS) 표본이 ${file.split('/crates/')[1]} 과 같다`, () => {
      const now = `${JSON.stringify(make(), null, 1)}\n`;
      if (process.env[env] === '1') writeFileSync(file, now);
      expect(readFileSync(file, 'utf8')).toBe(now);
    });
  }
});
