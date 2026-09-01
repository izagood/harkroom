// 스레드당 하니스 세션을 디스크에 붙잡아 둔다 — 러너는 멘션마다 프로세스를 새로 띄우고
// 버리므로, 여기 저장해 두지 않으면 에이전트는 자기 스레드를 매번 처음 보는 것처럼 대한다.
// 세션은 상태일 뿐이다: avcs 워크스페이스 경로와 하니스 세션 id. 살아있는 프로세스가 아니라서
// 러너가 죽거나 재배포되어도 다음 멘션이 같은 대화를 이어받을 수 있다.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AgentHarness } from '@murmur/shared';

export interface SessionRecord {
  workspaceDir: string;
  /**
   * claude 는 시작 전에 `--session-id` 로 UUID 를 미리 지정할 수 있지만, codex 는 그렇지 않다 —
   * 첫 턴이 끝나야 자기 세션 id 를 알려준다. null 은 "아직 첫 턴을 못 돌렸다"이지 고장이 아니다.
   */
  sessionId: string | null;
  harness: AgentHarness;
  /**
   * 이 세션에 마지막으로 먹인 스레드 seq (spec §4). resume 턴은 이 값보다 큰 메시지만 새로
   * 넘긴다. 경계가 없으면 두 에이전트가 한 스레드에서 같이 일할 때 각자 자기한테 온 멘션만
   * 보게 되어, 협업이 서로 독백하는 꼴이 된다.
   */
  lastFedSeq: number;
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, SessionRecord>();
  // put 이 겹쳐 들어오면(같은 프로세스에서 두 스레드가 동시에 답장) 먼저 시작한 쓰기가 늦게
  // 끝나면서 나중 쓰기가 반영한 최신 맵을 옛 스냅샷으로 덮어쓸 수 있다. 쓰기를 이 큐로 한 줄로
  // 세워 항상 "쓰는 시점의" 전체 맵을 파일에 반영하게 한다.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static threadKey(channelId: string, threadRootId: string | null): string {
    return `${channelId}/${threadRootId ?? '_root'}`;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.sessions = new Map();
        return;
      }
      throw err;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, SessionRecord>;
      this.sessions = new Map(Object.entries(parsed));
    } catch {
      // 깨진 파일 때문에 러너가 못 뜨면, 세션 하나를 잃는 것보다 훨씬 큰 손해다. 원본은
      // 조사할 수 있게 옆으로 치워 두고, 빈 상태로 계속 진행한다.
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      await rename(this.filePath, backupPath).catch(() => {});
      console.warn(
        `[sessions] ${this.filePath} 파싱 실패 — 빈 상태로 시작한다 (원본은 ${backupPath} 에 보존)`,
      );
      this.sessions = new Map();
    }
  }

  get(key: string): SessionRecord | undefined {
    return this.sessions.get(key);
  }

  async put(key: string, rec: SessionRecord): Promise<void> {
    this.sessions.set(key, rec);
    const next = this.writeQueue.then(() => this.flush());
    // 실패한 쓰기 하나가 큐를 영원히 막지 않도록, 큐 자체는 항상 이어지게 한다. 호출자에게는
    // 이번 쓰기의 성패를 그대로 돌려준다.
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const body = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    // tmp 에 다 쓴 뒤 rename — 세션 id 자체는 비밀이 아니지만 굳이 넓게 열어 둘 이유도 없어
    // 0o600 으로 좁힌다. rename 은 원자적이라 쓰는 도중 프로세스가 죽어도 기존 파일은 온전하다.
    await writeFile(tmpPath, body, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
