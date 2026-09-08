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
import { readLastApiError } from '../src/harnessErrors.js';

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
