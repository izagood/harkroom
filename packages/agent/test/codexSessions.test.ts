import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findCodexSessionId } from '../src/codexSessions.js';

// rollout 파일 하나를 tmpdir 트리에 만든다. session_meta 줄만 있으면 되고(첫 줄만 읽으므로),
// mtime 을 직접 지정할 수 있어야 sinceMs 필터링을 결정론적으로 테스트할 수 있다.
async function writeRollout(
  dir: string,
  fileName: string,
  firstLine: string,
  mtimeMs: number,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, `${firstLine}\n`, 'utf8');
  const seconds = mtimeMs / 1000;
  await utimes(path, seconds, seconds);
  return path;
}

function sessionMeta(id: string, cwd: string, sessionId = id): string {
  return JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { id, session_id: sessionId, cwd } });
}

describe('findCodexSessionId', () => {
  it('대상 cwd 의 세션 id 만 잡히고, 다른 cwd 는 무시된다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const now = Date.now();
    await writeRollout(join(root, 'a'), 'rollout-2026-09-01T00-00-00-aaaaaaaa-0000-7000-8000-000000000001.jsonl', sessionMeta('aaaaaaaa-0000-7000-8000-000000000001', '/somewhere/else'), now);
    const targetDir = join(root, 'b');
    await writeRollout(join(root, 'b'), 'rollout-2026-09-01T00-00-01-bbbbbbbb-0000-7000-8000-000000000002.jsonl', sessionMeta('bbbbbbbb-0000-7000-8000-000000000002', targetDir), now);

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBe('bbbbbbbb-0000-7000-8000-000000000002');
  });

  it('sinceMs 보다 오래된 파일은 (cwd 가 일치해도) 무시한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    const longAgo = Date.now() - 60 * 60 * 1000; // 1시간 전 — 클럭 오차 여유(수백 ms)보다 압도적으로 큼
    await writeRollout(root, 'rollout-2026-09-01T00-00-00-cccccccc-0000-7000-8000-000000000003.jsonl', sessionMeta('cccccccc-0000-7000-8000-000000000003', targetDir), longAgo);

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: Date.now() });
    expect(found).toBeNull();
  });

  it('빈 디렉터리면 null 을 돌려준다(에러가 아니다)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const found = await findCodexSessionId(root, { cwd: '/whatever', sinceMs: 0 });
    expect(found).toBeNull();
  });

  it('존재하지 않는 sessionsDir 도 null 을 돌려준다 — codex 를 아직 한 번도 안 돌린 경우', async () => {
    const found = await findCodexSessionId('/nonexistent-codex-sessions-dir-xyz', { cwd: '/whatever', sinceMs: 0 });
    expect(found).toBeNull();
  });

  it('첫 줄이 깨진 파일은 건너뛰고 다음 파일에서 찾는다 — 손상 파일 하나가 발견 전체를 죽이지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    const now = Date.now();
    // 쓰는 도중 잘린 것처럼 첫 줄이 JSON 으로 파싱되지 않는다.
    await writeRollout(root, 'rollout-2026-09-01T00-00-00-dddddddd-0000-7000-8000-000000000004.jsonl', '{"timestamp":"2026-09-01T00:00', now + 10);
    await writeRollout(root, 'rollout-2026-09-01T00-00-01-eeeeeeee-0000-7000-8000-000000000005.jsonl', sessionMeta('eeeeeeee-0000-7000-8000-000000000005', targetDir), now);

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBe('eeeeeeee-0000-7000-8000-000000000005');
  });

  // 실측(브리프): resume 으로 이어진 세션은 payload.id 와 payload.session_id 가 어긋난다 —
  // session_id 는 최초 조상 세션에 고정된 채 여러 rollout 파일에 반복되고, id 만 파일마다
  // 새로 발급된다. 파일명의 uuid 는 실측 57개 파일 전부에서 id 와 일치했다. id 대신
  // session_id 를 골랐다면 이 테스트가 실패한다 — 두 필드가 오늘은 우연히 같아서 그
  // 실수가 다른 모든 테스트를 통과시키기 때문에 이 케이스를 별도로 박아 둔다.
  it('payload.id 와 payload.session_id 가 다르면 파일명과 일치하는 id 를 쓴다(session_id 아님)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    const now = Date.now();
    const line = sessionMeta('ffffffff-0000-7000-8000-000000000006', targetDir, '11111111-0000-7000-8000-000000000000');
    await writeRollout(root, 'rollout-2026-09-01T00-00-00-ffffffff-0000-7000-8000-000000000006.jsonl', line, now);

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBe('ffffffff-0000-7000-8000-000000000006');
  });

  // macOS 는 /var 가 /private/var 의 심볼릭 링크다(브리프 실측: 관찰된 파일의 cwd 는
  // /private/var/... 였는데 프로세스에는 /var/... 가 주어졌을 수 있다). os.tmpdir() 자체가
  // 이 macOS 특성을 그대로 재현하므로 별도 목킹 없이 실제 경로로 검증한다.
  it('cwd 비교는 심볼릭 링크를 realpath 로 풀어서 한다(macOS /var vs /private/var)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    await mkdir(targetDir, { recursive: true });
    const resolvedTargetDir = await realpath(targetDir);
    const now = Date.now();
    // rollout 파일에는 codex 가 실제로 관찰한(realpath 된) cwd 가 적혀 있다고 가정.
    await writeRollout(root, 'rollout-2026-09-01T00-00-00-01010101-0000-7000-8000-000000000007.jsonl', sessionMeta('01010101-0000-7000-8000-000000000007', resolvedTargetDir), now);

    // 호출자는 심볼릭 링크가 안 풀린 원래 경로(targetDir)를 넘긴다.
    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBe('01010101-0000-7000-8000-000000000007');
  });

  it('cwd 의 trailing slash 차이는 무시한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    await mkdir(targetDir, { recursive: true });
    const now = Date.now();
    await writeRollout(root, 'rollout-2026-09-01T00-00-00-02020202-0000-7000-8000-000000000008.jsonl', sessionMeta('02020202-0000-7000-8000-000000000008', `${targetDir}/`), now);

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBe('02020202-0000-7000-8000-000000000008');
  });

  it('rollout 파일이 아닌 파일은 무시한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-sessions-'));
    const targetDir = join(root, 'ws');
    const now = Date.now();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), sessionMeta('99999999-0000-7000-8000-000000000009', targetDir), 'utf8');

    const found = await findCodexSessionId(root, { cwd: targetDir, sinceMs: now - 1000 });
    expect(found).toBeNull();
  });
});
