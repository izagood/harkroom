// 세션 JSONL 에서 하네스가 낸 API 에러를 읽는 경로의 회귀선.
//
// 왜 이 판정이 tail 이 아니라 여기 있어야 하는가: tail 은 PTY 출력의 끝 2KB 링이라
// ① 앞이 잘리고 ② 사람이 넣은 프롬프트가 에코돼 섞인다. 2026-09-07 19:03 사건에서
// 세션 파일에는 `resets 10:50pm (Asia/Seoul)` 이 있었는데 tail 판정은 "풀림: 알 수 없음"을
// 찍었다. 이 파일이 그 자리를 대신한다.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLastApiError, readLastAssistantText, readPermissionDenials, readTranscriptTurnState, sessionTranscriptGrewSince } from '../src/harnessErrors.js';

/** `isApiErrorMessage` 레코드 한 줄. 실물 세션 파일의 모양을 그대로 쓴다. */
const rec = (timestamp: string, text: string): string => JSON.stringify({
  type: 'assistant', isApiErrorMessage: true, timestamp, message: { content: text },
});

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** `<projects>/<프로젝트>/<sid>.jsonl` 을 만들고 그 projects 뿌리를 돌려준다. */
async function seed(lines: unknown[]): Promise<string> {
  const projects = await mkdtemp(join(tmpdir(), 'harness-err-'));
  const proj = join(projects, '-private-tmp-whatever-cwd');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return projects;
}

/** 실물과 같은 모양의 에러 레코드(2026-09-08 로컬 세션 전수 조사에서 확인한 형태). */
const apiErrorRecord = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('readLastApiError', () => {
  it('isApiErrorMessage 레코드의 문구를 돌려준다', async () => {
    const projectsDir = await seed([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '안녕' }] } },
      apiErrorRecord("You've hit your session limit · resets 10:50pm (Asia/Seoul)"),
    ]);
    const found = await readLastApiError('claude-code', SID, { projectsDir });
    expect(found?.text).toBe("You've hit your session limit · resets 10:50pm (Asia/Seoul)");
  });

  it('에러가 여럿이면 **마지막** 것을 돌려준다 — 이번 턴의 사실이 앞 턴의 것보다 뒤에 있다', async () => {
    const projectsDir = await seed([
      apiErrorRecord('옛 에러'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '정상 응답' }] } },
      apiErrorRecord('최신 에러'),
    ]);
    expect((await readLastApiError('claude-code', SID, { projectsDir }))?.text).toBe('최신 에러');
  });

  it('에러가 없으면 null — 사용자 발화를 에러로 읽지 않는다', async () => {
    const projectsDir = await seed([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'authentication_error 라는 문구' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '네' }] } },
    ]);
    expect(await readLastApiError('claude-code', SID, { projectsDir })).toBeNull();
  });

  it('isApiErrorMessage 가 false 인 레코드는 세지 않는다', async () => {
    const projectsDir = await seed([
      { ...apiErrorRecord('가짜'), isApiErrorMessage: false },
    ]);
    expect(await readLastApiError('claude-code', SID, { projectsDir })).toBeNull();
  });

  it('세션 파일이 없으면 null — 예외로 턴을 죽이지 않는다', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'harness-err-'));
    expect(await readLastApiError('claude-code', SID, { projectsDir: projects })).toBeNull();
  });

  it('sessionId 가 null 이면 null — 세션이 없는 턴은 읽을 것이 없다', async () => {
    expect(await readLastApiError('claude-code', null, {})).toBeNull();
  });

  it('깨진 줄이 있어도 나머지를 읽는다 — 한 줄이 전체를 막지 않는다', async () => {
    const projects = await mkdtemp(join(tmpdir(), 'harness-err-'));
    const proj = join(projects, '-p');
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, `${SID}.jsonl`),
      `{ 깨진 줄 isApiErrorMessage\n${JSON.stringify(apiErrorRecord('살아남은 에러'))}\n`,
    );
    expect((await readLastApiError('claude-code', SID, { projectsDir: projects }))?.text).toBe('살아남은 에러');
  });

  it('codex 는 아직 null 이다 — rollout 형식은 P5 에서 다룬다', async () => {
    const projectsDir = await seed([apiErrorRecord('무엇이든')]);
    expect(await readLastApiError('codex', SID, { projectsDir })).toBeNull();
  });
});

// ── 턴 도중에 읽는다(2026-09-09 프로덕션 관측)
//
// TUI 는 한도 에러를 받고도 **죽지 않는다** — 화면에 찍고 계속 산다. `-p` 시절에는
// 프로세스 종료가 곧 신호였고 그 exit code 가 계정 전환을 태웠는데, 그 신호가 사라졌다.
// 실측: 한도에 걸린 TUI 20여 개가 같은 계정으로 8분 넘게 살아 있었고 계정 전환은 0건.
//
// 그래서 러너가 **턴이 도는 동안** 이 파일을 본다. 그때 필요한 것이 `sinceMs` 다:
// 세션 파일은 그 스레드의 전체 이력이라 **앞 턴의 한도 에러**가 그대로 남아 있고,
// 그것을 지금 턴의 것으로 읽으면 멀쩡한 계정을 버리고 축을 헛돈다.
describe('readLastApiError — sinceMs', () => {
  it('그 시각 이후의 에러만 읽는다 — 앞 턴의 한도가 지금 턴을 죽이지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'since-'));
    const proj = join(dir, 'projects', '-w');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'S.jsonl'), [
      rec('2026-09-09T00:00:00.000Z', '앞 턴의 한도'),
      rec('2026-09-09T00:10:00.000Z', '지금 턴의 한도'),
    ].join('\n'));

    const 앞 = await readLastApiError('claude-code', 'S', {
      configDir: dir, sinceMs: Date.parse('2026-09-09T00:05:00.000Z'),
    });
    expect(앞?.text).toBe('지금 턴의 한도');
  });

  it('그 시각 이후에 아무것도 없으면 null 이다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'since-'));
    const proj = join(dir, 'projects', '-w');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'S.jsonl'), rec('2026-09-09T00:00:00.000Z', '앞 턴의 한도'));

    expect(await readLastApiError('claude-code', 'S', {
      configDir: dir, sinceMs: Date.parse('2026-09-09T00:05:00.000Z'),
    })).toBeNull();
  });

  it('sinceMs 가 없으면 지금까지처럼 마지막을 읽는다 — 기존 호출자는 그대로다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'since-'));
    const proj = join(dir, 'projects', '-w');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'S.jsonl'), rec('2026-09-09T00:00:00.000Z', '앞 턴의 한도'));

    expect((await readLastApiError('claude-code', 'S', { configDir: dir }))?.text).toBe('앞 턴의 한도');
  });

  it('타임스탬프가 없는 레코드는 sinceMs 가 있으면 세지 않는다 — 시각을 모르면 지금 것이 아니다', async () => {
    // 없는 것을 있다고 읽지 않는다. 시각 없는 레코드를 지금 턴의 것으로 세면, 앞 턴의
    // 에러 하나가 그 스레드의 모든 계정을 차례로 버리게 만든다.
    const dir = await mkdtemp(join(tmpdir(), 'since-'));
    const proj = join(dir, 'projects', '-w');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, 'S.jsonl'), JSON.stringify({
      type: 'assistant', isApiErrorMessage: true, message: { content: '시각 없음' },
    }));

    expect(await readLastApiError('claude-code', 'S', { configDir: dir, sinceMs: 1 })).toBeNull();
  });
});

// ── 기록이 **자랐는가**(2026-09-09)
//
// 왜 존재로는 안 되는가: `sessionTranscriptExists` 는 첫 턴에서만 "이 턴의 대화가
// 시작됐다"와 같은 뜻이다. 되살린 턴(`claude -r`)의 기록 파일은 앞 턴에 이미 생겨 있어
// 무조건 참이 되고, 그 구멍으로 프로덕션에서 턴 둘이 연달아 프롬프트를 못 받은 채 각각
// 10분씩 정지 시계에 접혔다(forge `5e08f534`, 31분 동안 기록 0줄).
describe('sessionTranscriptGrewSince', () => {
  const 자란시각 = async (projects: string): Promise<number> => {
    const { stat } = await import('node:fs/promises');
    return (await stat(join(projects, '-private-tmp-whatever-cwd', `${SID}.jsonl`))).mtimeMs;
  };

  it('턴 시작 뒤에 자랐으면 참 — 대화가 실제로 시작됐다', async () => {
    const projects = await seed([{ type: 'user' }]);
    const mtime = await 자란시각(projects);
    expect(await sessionTranscriptGrewSince('claude-code', SID, mtime - 1_000, { projectsDir: projects }))
      .toBe(true);
  });

  it('턴 시작 전이 마지막이면 거짓 — 되살린 턴이 프롬프트를 못 받은 그 상태다', async () => {
    const projects = await seed([{ type: 'user' }]);
    const mtime = await 자란시각(projects);
    // 파일은 **있다**. 존재로 재던 옛 판정은 여기서 참을 돌려주고 사람을 부르지 않았다.
    expect(await sessionTranscriptGrewSince('claude-code', SID, mtime + 1_000, { projectsDir: projects }))
      .toBe(false);
  });

  it('파일이 아예 없으면 거짓 — 첫 턴의 판정은 그대로 산다', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const projects = await mkdtemp(join(tmpdir(), 'harness-grew-'));
    expect(await sessionTranscriptGrewSince('claude-code', SID, 0, { projectsDir: projects }))
      .toBe(false);
  });

  it('codex 는 참 — 판정할 수 없는 하네스로 사람을 부르지 않는다', async () => {
    expect(await sessionTranscriptGrewSince('codex', SID, Date.now(), {})).toBe(true);
  });

  it('sessionId 가 null 이면 참 — 볼 파일이 없는 턴을 고장으로 읽지 않는다', async () => {
    expect(await sessionTranscriptGrewSince('claude-code', null, Date.now(), {})).toBe(true);
  });
});

// 실물 꼬리 모양(2026-09-30, work/lychee 세션 다섯 개): 끝난 턴은 `assistant(end_turn)` 뒤에
// `system/turn_duration`·`cost-state`·`last-prompt` 가 붙고, 일하는 턴은 `tool_use`·`tool_result`·`attachment` 로 끝난다.
describe('readTranscriptTurnState', () => {
  const T0 = Date.parse('2026-09-30T05:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const assistant = (s: number, stop: string, extra: object = {}) => ({
    type: 'assistant', timestamp: at(s), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'x' }] }, ...extra,
  });
  const toolResult = (s: number) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result' }] } });
  const tailNoise = [{ type: 'system', subtype: 'turn_duration', timestamp: at(99) }, { type: 'cost-state' }, { type: 'last-prompt' }];

  it('end_turn 뒤에 붙는 회계 줄을 건너뛰고 ended', async () => {
    const projectsDir = await seed([toolResult(1), assistant(2, 'end_turn'), ...tailNoise]);
    expect(await readTranscriptTurnState('claude-code', SID, { projectsDir, sinceMs: T0 })).toBe('ended');
  });

  it('도구 호출·도구 결과로 끝나면 working — 긴 셸 명령을 기다리는 중이다', async () => {
    expect(await readTranscriptTurnState('claude-code', SID, {
      projectsDir: await seed([assistant(1, 'tool_use'), { type: 'attachment', timestamp: at(2) }]), sinceMs: T0,
    })).toBe('working');
    expect(await readTranscriptTurnState('claude-code', SID, {
      projectsDir: await seed([assistant(1, 'tool_use'), toolResult(2)]), sinceMs: T0,
    })).toBe('working');
  });

  it('앞 턴의 end_turn 은 이 턴의 끝이 아니다 — 되살린 세션에 프롬프트가 들어가기 전', async () => {
    const projectsDir = await seed([assistant(-60, 'end_turn'), ...tailNoise]);
    expect(await readTranscriptTurnState('claude-code', SID, { projectsDir, sinceMs: T0 })).toBe('working');
  });

  it('API 에러 레코드는 끝이 아니다 — 계정을 넘길 실패다', async () => {
    const projectsDir = await seed([assistant(1, 'end_turn', { isApiErrorMessage: true })]);
    expect(await readTranscriptTurnState('claude-code', SID, { projectsDir, sinceMs: T0 })).toBe('working');
  });

  it('사이드체인(서브에이전트) 줄은 본 대화의 끝이 아니다', async () => {
    const projectsDir = await seed([assistant(1, 'tool_use'), assistant(2, 'end_turn', { isSidechain: true })]);
    expect(await readTranscriptTurnState('claude-code', SID, { projectsDir, sinceMs: T0 })).toBe('working');
  });

  it('판정할 수 없으면 null — 파일 없음·기록을 못 읽는 하네스·세션 미상', async () => {
    const projectsDir = await seed([assistant(1, 'end_turn')]);
    expect(await readTranscriptTurnState('claude-code', 'ffffffff-0000-0000-0000-000000000000', { projectsDir })).toBeNull();
    expect(await readTranscriptTurnState('codex', SID, { projectsDir })).toBeNull();
    expect(await readTranscriptTurnState('claude-code', null, { projectsDir })).toBeNull();
  });
});

// 실물 모양(2026-09-30, work/lychee 세션): 거부는 `tool_result`(is_error) 의 문자열 content 로 온다.
describe('readPermissionDenials', () => {
  const T0 = Date.parse('2026-09-30T05:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const use = (s: number, id: string, command: string) => ({
    type: 'assistant', timestamp: at(s),
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const denied = (s: number, id: string, reason: string) => ({
    type: 'user', timestamp: at(s),
    message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: id, is_error: true,
      content: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those.`,
    }] },
  });

  it('거부된 도구 호출을 명령·이유와 짝지어 돌려준다(로컬·서버 분류기 둘 다)', async () => {
    const projectsDir = await seed([
      use(1, 't1', 'gh pr merge 949 --squash'), denied(2, 't1', '[Merge Without Review]'),
      use(3, 't2', 'gh pr merge 356'), denied(4, 't2', 'The server-side auto mode classifier judged this action dangerous (it gave no explanation)'),
    ]);
    expect(await readPermissionDenials('claude-code', SID, { projectsDir, sinceMs: T0 })).toEqual([
      { toolUseId: 't1', tool: 'Bash', input: 'gh pr merge 949 --squash', reason: '[Merge Without Review]' },
      { toolUseId: 't2', tool: 'Bash', input: 'gh pr merge 356', reason: 'The server-side auto mode classifier judged this action dangerous (it gave no explanation)' },
    ]);
  });

  it('이 턴 이전의 거부·평범한 도구 에러·말 속 인용은 세지 않는다', async () => {
    const projectsDir = await seed([
      use(-10, 'old', 'gh pr merge 1'), denied(-9, 'old', '[Merge Without Review]'),
      use(1, 't1', 'false'),
      { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1' }] } },
      { type: 'assistant', timestamp: at(3), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [X]. If you' }] } },
    ]);
    expect(await readPermissionDenials('claude-code', SID, { projectsDir, sinceMs: T0 })).toEqual([]);
  });

  it('기록을 못 읽는 하네스는 빈 배열이다', async () => {
    expect(await readPermissionDenials('codex', SID, {})).toEqual([]);
  });
});

describe('readLastAssistantText', () => {
  const T0 = Date.parse('2026-09-30T05:00:00.000Z');
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  const say = (s: number, stop: string, text: string) => ({
    type: 'assistant', timestamp: at(s), message: { role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
  });

  it('이 턴의 마지막 end_turn 말을 돌려준다 — 도구 사이 혼잣말·앞 턴의 말은 아니다', async () => {
    const projectsDir = await seed([
      say(-60, 'end_turn', '앞 턴의 말'),
      say(1, 'tool_use', 'PR 을 본다'),
      say(2, 'end_turn', '새 소식이 없어서 글을 쓰지 않았어'),
      { type: 'system', subtype: 'turn_duration', timestamp: at(3) },
    ]);
    expect(await readLastAssistantText('claude-code', SID, { projectsDir, sinceMs: T0 })).toBe('새 소식이 없어서 글을 쓰지 않았어');
  });

  it('이 턴에 끝낸 말이 없으면 null', async () => {
    const projectsDir = await seed([say(-60, 'end_turn', '앞 턴의 말'), say(1, 'tool_use', '보는 중')]);
    expect(await readLastAssistantText('claude-code', SID, { projectsDir, sinceMs: T0 })).toBeNull();
  });
});
