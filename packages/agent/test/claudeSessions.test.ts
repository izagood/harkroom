// #337 — 인터랙티브 첫 턴 뒤 "하네스 세션이 실재하게 됐는가"의 관측(스파이크 §2 고정).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSessionFileExists } from '../src/claudeSessions.js';

const UUID = '6c3c4a88-3c5d-4c7e-af90-1b2c3d4e5f60';

describe('#337 claudeSessionFileExists', () => {
  it('projects 아래 어느 디렉터리에든 <uuid>.jsonl 이 있으면 참이다 — cwd 뭉개기 규칙에 안 기댄다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
    // 뭉개진 cwd 이름은 claude 내부 구현이다 — 어떤 이름이든 파일명만으로 찾아야 한다.
    const projectDir = join(root, '-private-tmp-whatever-cwd');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${UUID}.jsonl`), '{"type":"session"}\n');

    expect(await claudeSessionFileExists(UUID, { projectsDir: root })).toBe(true);
    expect(await claudeSessionFileExists('00000000-0000-4000-8000-000000000000', { projectsDir: root })).toBe(false);
  });

  it('projects 디렉터리 자체가 없으면 조용히 거짓이다 — claude 를 아직 안 돌린 머신의 정상 경로', async () => {
    expect(await claudeSessionFileExists(UUID, { projectsDir: '/nonexistent/claude/projects' })).toBe(false);
  });
});
