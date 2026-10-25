// codex 턴 hook(`hook pretool --codex`) — 실행 위치 확인(security W1~W6)과 규칙 파일을 같은 출처로 읽는지.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRulesFile, decodeCodexHookSpec, encodeCodexHookSpec, parseCodexRulesFile, type CodexHookSpec } from '@harkroom/shared/providerLane';
import { checkCodexWorkdir, CODEX_HOOK_WORKDIR_REASON, decideCodexHook } from '../src/codexHook.js';
import { LANE_HOOK_TAIL_REASON } from '../src/hookCli.js';

const APPROVED = 'Bash(gh pr list -R cli/cli --limit 3)';
const CMD = 'gh pr list -R cli/cli --limit 3';

let root: string;
let home: string;
let cwd: string;
let other: string;
let transcript: string;

/** codex 0.154 대화 기록의 function_call 줄(실측 꼴). */
const callLine = (callId: string, args: Record<string, unknown>) =>
  JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', id: 'fc', name: 'exec_command', arguments: JSON.stringify(args), call_id: callId } });
const outputLine = (callId: string, output: string) =>
  JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: callId, output } });

const input = (over: Record<string, unknown> = {}) => ({
  tool_name: 'Bash', tool_input: { command: CMD }, tool_use_id: 'call_7', cwd, transcript_path: transcript, ...over,
});
const writeTranscript = (...lines: string[]) => writeFile(transcript, `${lines.join('\n')}\n`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-hook-'));
  home = join(root, 'codex-home');
  cwd = join(root, 'work');
  other = join(root, 'elsewhere');
  await mkdir(join(home, 'sessions'), { recursive: true });
  await mkdir(join(home, 'rules'), { recursive: true });
  await mkdir(cwd);
  await mkdir(other);
  transcript = join(home, 'sessions', 'rollout-x.jsonl');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('checkCodexWorkdir — 승인 명령의 실행 위치', () => {
  it('① 다른 실행 폴더면 거절한다', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: other }));
    expect((await checkCodexWorkdir(input(), CMD, home))?.hookSpecificOutput.permissionDecisionReason).toBe(CODEX_HOOK_WORKDIR_REASON);
  });

  it('② 실행 폴더가 없거나 작업 폴더와 같으면(상대 경로 `.` 포함) 통과한다', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD }));
    expect(await checkCodexWorkdir(input(), CMD, home)).toBeNull();
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: cwd }));
    expect(await checkCodexWorkdir(input(), CMD, home)).toBeNull();
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: '.' }));
    expect(await checkCodexWorkdir(input(), CMD, home)).toBeNull();
  });

  it('W3 상대 경로·심볼릭 링크는 실제 경로로 본다', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: '../elsewhere' }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
    await symlink(other, join(cwd, 'link'));
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: join(cwd, 'link') }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
    await symlink(cwd, join(other, 'back'));
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: join(other, 'back') }));
    expect(await checkCodexWorkdir(input(), CMD, home)).toBeNull();
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: join(root, 'missing') }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
  });

  it('③ 호출 id 가 없거나, 그 줄이 없거나 둘 이상이면 거절한다 · 명령이 다르면 거절한다(W2)', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD }));
    expect(await checkCodexWorkdir(input({ tool_use_id: undefined }), CMD, home)).not.toBeNull();
    expect(await checkCodexWorkdir(input({ tool_use_id: 'call_8' }), CMD, home)).not.toBeNull();
    await writeTranscript(callLine('call_7', { cmd: CMD }), callLine('call_7', { cmd: CMD, workdir: other }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
    await writeTranscript(callLine('call_7', { cmd: 'gh pr list -R cli/cli --limit 4' }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
  });

  it('출력 글 속에 든 가짜 줄은 호출 줄로 세지 않는다', async () => {
    const fake = callLine('call_7', { cmd: CMD });
    await writeTranscript(outputLine('call_6', fake), callLine('call_7', { cmd: CMD, workdir: other }));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
    await writeTranscript(outputLine('call_6', fake));
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
  });

  it('④ 기록 파일이 없거나 이 턴 codex 홈 밖이면 거절한다(W1)', async () => {
    expect(await checkCodexWorkdir(input(), CMD, home)).not.toBeNull();
    const outside = join(cwd, 'rollout-x.jsonl');
    await writeFile(outside, `${callLine('call_7', { cmd: CMD })}\n`);
    expect(await checkCodexWorkdir(input({ transcript_path: outside }), CMD, home)).not.toBeNull();
    await symlink(outside, join(home, 'sessions', 'linked.jsonl'));
    expect(await checkCodexWorkdir(input({ transcript_path: join(home, 'sessions', 'linked.jsonl') }), CMD, home)).not.toBeNull();
  });

  it('꼬리만 읽는다 — 상한 밖의 줄은 보지 않는다', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD }), 'x'.repeat(4096));
    expect(await checkCodexWorkdir(input(), CMD, home, 1024)).not.toBeNull();
    expect(await checkCodexWorkdir(input(), CMD, home, 64 * 1024)).toBeNull();
  });
});

describe('decideCodexHook', () => {
  const spec = (over: Partial<CodexHookSpec> = {}): CodexHookSpec => ({ rules: [APPROVED], reach: [APPROVED], codexHome: home, ...over });

  it('⑤ 규칙 밖 명령은 판단하지 않는다 — 기록을 읽지 않는다(구독형)', async () => {
    expect(await decideCodexHook(JSON.stringify(input({ tool_input: { command: 'ls -la' } })), spec())).toBeNull();
    expect(await decideCodexHook(JSON.stringify(input({ tool_name: 'mcp__harkroom__message_post', tool_input: {} })), spec())).toBeNull();
  });

  it('규칙에 맞아 밖으로 나갈 명령만 실행 위치를 본다', async () => {
    await writeTranscript(callLine('call_7', { cmd: CMD, workdir: other }));
    expect(await decideCodexHook(JSON.stringify(input()), spec())).not.toBeNull();
    await writeTranscript(callLine('call_7', { cmd: CMD }));
    expect(await decideCodexHook(JSON.stringify(input()), spec())).toBeNull();
  });

  it('합집합은 지금 규칙 파일도 본다 — 러너가 준 값에 없어도 파일에 있으면 꼬리·다른 채널 명령을 막는다', async () => {
    await writeFile(join(home, 'rules', 'harkroom.rules'), codexRulesFile(['Bash(kubectl get pods)']));
    const raw = JSON.stringify(input({ tool_input: { command: 'kubectl get pods -A' } }));
    expect((await decideCodexHook(raw, spec()))?.hookSpecificOutput.permissionDecisionReason).toBe(LANE_HOOK_TAIL_REASON);
    expect(await decideCodexHook(raw, spec({ codexHome: join(root, 'no-home') }))).toBeNull();
  });

  it('규칙 파일 꼴이 다르면 셸 명령을 막는다', async () => {
    await writeFile(join(home, 'rules', 'harkroom.rules'), 'prefix_rule(pattern = ["ls"], decision = "prompt")\n');
    expect(await decideCodexHook(JSON.stringify(input({ tool_input: { command: 'ls' } })), spec())).not.toBeNull();
  });

  it('입력을 못 읽으면 막는다', async () => {
    expect(await decideCodexHook('not json', spec())).not.toBeNull();
  });
});

describe('규칙 파일·hook 값의 왕복', () => {
  it('codexRulesFile 이 쓴 글을 같은 규칙으로 읽는다 · 다른 줄이 섞이면 null', () => {
    const text = codexRulesFile([APPROVED, 'Bash(kubectl get:*)', 'mcp__harkroom']);
    expect(parseCodexRulesFile(text)).toEqual([APPROVED, 'Bash(kubectl get)']);
    expect(parseCodexRulesFile(`${text}prefix_rule(pattern = ["rm"], decision = "forbidden")\n`)).toBeNull();
    expect(parseCodexRulesFile('')).toEqual([]);
  });

  it('hook 값은 왕복하고, 꼴이 틀리면 null', () => {
    const s: CodexHookSpec = { rules: [APPROVED], reach: [APPROVED, 'Bash(ls)'], codexHome: '/h' };
    expect(decodeCodexHookSpec(encodeCodexHookSpec(s))).toEqual(s);
    expect(decodeCodexHookSpec(undefined)).toBeNull();
    expect(decodeCodexHookSpec('!!')).toBeNull();
    expect(decodeCodexHookSpec(Buffer.from(JSON.stringify({ ...s, codexHome: 'rel' })).toString('base64url'))).toBeNull();
    expect(decodeCodexHookSpec(Buffer.from(JSON.stringify({ ...s, rules: ['a b'] })).toString('base64url'))).toBeNull();
  });
});
