// #337 — 인터랙티브 첫 턴 뒤 "하네스 세션이 실재하게 됐는가"의 관측(스파이크 §2 고정).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSessionFileExists, claudeSessionFilePath } from '../src/claudeSessions.js';

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

  // 다중 계정: 세션 파일도 `CLAUDE_CONFIG_DIR` 를 따라간다(2026-09-07 실측).
  describe('계정별 config 디렉터리', () => {
    it('configDir 가 있으면 그 아래 projects 를 본다', async () => {
      // 이 판정이 계속 ~/.claude/projects 를 보면, 계정 디렉터리로 돌린 세션을 "없음"으로
      // 읽어 다음 턴을 첫 턴으로 조립하고, claude 는 이미 쓰인 id 를 --session-id 로 다시
      // 받아 `Session ID <uuid> is already in use.` 로 즉사한다.
      const configDir = await mkdtemp(join(tmpdir(), 'murmur-cfg-'));
      const projectDir = join(configDir, 'projects', '-tmp-work');
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${UUID}.jsonl`), '{"type":"session"}\n');

      expect(await claudeSessionFileExists(UUID, { configDir })).toBe(true);
      expect(await claudeSessionFileExists('00000000-0000-4000-8000-000000000000', { configDir }))
        .toBe(false);
    });

    it('configDir 가 없으면 시스템 기본을 본다 — 계정 풀을 안 만든 러너의 경로', async () => {
      // 아래 파일은 홈이 아니라 임시 디렉터리에 있다. configDir 를 안 주면 못 본다 —
      // 이 동작이 바뀌면 하위 호환이 깨진다.
      const configDir = await mkdtemp(join(tmpdir(), 'murmur-cfg-unused-'));
      const projectDir = join(configDir, 'projects', '-tmp-work');
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${UUID}.jsonl`), '{"type":"session"}\n');

      expect(await claudeSessionFileExists(UUID, {})).toBe(false);
      expect(await claudeSessionFileExists(UUID, { configDir: null })).toBe(false);
    });

    it('projectsDir 가 configDir 보다 이긴다 — 기존 테스트의 직접 지정을 깨지 않는다', async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-projects-win-'));
      const projectDir = join(root, '-x');
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${UUID}.jsonl`), '{}\n');

      expect(await claudeSessionFileExists(UUID, { projectsDir: root, configDir: '/nope' }))
        .toBe(true);
    });
  });
});

describe('claudeSessionFilePath', () => {
  it('세션 파일의 경로를 돌려준다 — 존재 확인과 같은 탐색을 쓴다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
    const projectDir = join(root, '-private-tmp-whatever-cwd');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, `${UUID}.jsonl`), '{"type":"session"}\n');

    expect(await claudeSessionFilePath(UUID, { projectsDir: root }))
      .toBe(join(projectDir, `${UUID}.jsonl`));
    expect(await claudeSessionFilePath('00000000-0000-4000-8000-000000000000', { projectsDir: root }))
      .toBeNull();
  });

  it('projects 디렉터리가 없으면 null 이다 — 예외가 아니다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-projects-'));
    expect(await claudeSessionFilePath(UUID, { projectsDir: join(root, 'nope') })).toBeNull();
  });
});
