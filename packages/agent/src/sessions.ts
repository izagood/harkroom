// 스레드당 하니스 세션을 디스크에 붙잡아 둔다 — 러너는 멘션마다 프로세스를 새로 띄우고
// 버리므로, 여기 저장해 두지 않으면 에이전트는 자기 스레드를 매번 처음 보는 것처럼 대한다.
// 세션은 상태일 뿐이다: avcs 워크스페이스 경로와 하니스 세션 id. 살아있는 프로세스가 아니라서
// 러너가 죽거나 재배포되어도 다음 멘션이 같은 대화를 이어받을 수 있다.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AGENT_HARNESSES, type AgentHarness } from '@murmur/shared';

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
  /**
   * 이 세션으로 실제로 하네스를 돌린 횟수. 0 이면 아직 한 번도 안 돌았다는 뜻이고, 이때만
   * `buildTurnCommand` 의 `isFirstTurn` 이 true 여야 한다(main.ts::runMentionTurn).
   *
   * **`lastFedSeq === 0` 으로 유도하면 안 된다 — 별개의 사실이다.** `buildTurnPrompt` 가
   * 프롬프트를 비워 턴 자체를 건너뛰는 경우(새 메시지가 전부 자기 발화)에도 `lastFedSeq`
   * 는 전진한다 — 무엇을 "봤는지"의 경계이지 "하네스를 돌렸는지"의 증거가 아니다. 오늘의
   * `buildTurnPrompt` 구현은 첫 턴에서는 자기 발화 필터를 걸지 않아(이 필드가 0 일 때
   * 상응하는 lastFedSeq 도 항상 0) 이 둘이 실제로 어긋나는 사례를 만들어 내지는 못했지만,
   * 그 사실은 이 모듈이 알 수 있는 게 아니라 prompt.ts 의 현재 구현에 우연히 기대는
   * 불변식이다 — prompt.ts 가 나중에 바뀌면 조용히 깨질 수 있다. 그래서 "돌았는가"를
   * 직접 세어 두는 쪽이 맞다: 유도된 값이 아니라 사실 자체를 저장한다.
   */
  turnsRun: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 파싱은 통과하지만 우리가 아는 SessionRecord 모양이 아닌 값(배열, 문자열, 필드 누락·오타)이
// 조용히 들어오면, 나중에 `.workspaceDir` 을 읽는 코드에서 터진다 — 그때는 원인이 여기라는
// 단서가 하나도 안 남는다. 저장 전에 모양을 확인해서 여기서 걸러낸다.
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isPlainObject(value)) return false;
  const { workspaceDir, sessionId, harness, lastFedSeq, turnsRun } = value;
  return (
    typeof workspaceDir === 'string' &&
    (sessionId === null || typeof sessionId === 'string') &&
    typeof harness === 'string' &&
    (AGENT_HARNESSES as readonly string[]).includes(harness) &&
    typeof lastFedSeq === 'number' &&
    typeof turnsRun === 'number'
  );
}

export class SessionStore {
  private readonly filePath: string;
  private sessions = new Map<string, SessionRecord>();
  // 동시에 put 이 두 번 들어오면(한 프로세스가 여러 스레드에 동시에 답장) flush 도 두 번
  // 겹칠 수 있다. tmp 경로가 고정이던 예전 버전은 먼저 끝난 rename 이 tmp 파일을 치워버려서
  // 나중 rename 이 ENOENT 로 죽었다 — 그 충돌 자체는 flush 마다 유일한 tmp 이름을 써서
  // 없앴다(원자성, flush 참고). 이 큐는 별개의 보장이다: flush 호출 순서를 직렬화한다.
  // 원자성과 직렬성은 서로 다른 성질이고, 하나로 퉁쳐 두면 나중에 한쪽만 손보다 다른 쪽을
  // 깨뜨리기 쉬우므로 둘을 분리해 각각 보장한다.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * 세션 키를 만든다. #98 이후로 threadRootId 가 null 인 경우는 main.ts 에서
   * 이미 messageId 로 변환되므로 이 함수는 항상 non-null 값을 받는다 — _root 는
   * 호환성을 위해 남겨두지만 실제로는 쓰이지 않는다.
   */
  static threadKey(channelId: string, threadRootId: string | null): string {
    return `${channelId}/${threadRootId ?? '_root'}`;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // 첫 기동이라 파일이 아직 없다 — 정상 경로다. 매 기동마다 경고를 찍으면 사람이
        // 경고 자체를 무시하는 버릇이 들어서, 진짜 문제가 났을 때도 눈에 안 띈다.
        this.sessions = new Map();
        return;
      }
      // ENOENT 가 아닌 에러(권한 등)까지 여기서 던지면, 이 모듈이 앉아 있는 러너 기동 경로가
      // 통째로 막힌다 — 세션 하나를 잃는 것보다 훨씬 나쁘고, 원인도 "왜 러너가 안 뜨지"로만
      // 보인다. 읽기 자체가 안 되면 빈 상태로 시작해서 러너는 뜨게 한다.
      console.warn(`[sessions] ${this.filePath} 읽기 실패(${code ?? String(err)}) — 빈 상태로 시작한다`);
      this.sessions = new Map();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine('JSON 파싱 실패');
      return;
    }

    if (!isPlainObject(parsed)) {
      // 유효한 JSON 이지만 세션 맵 모양이 아니다(배열, 문자열, 숫자 …). 이걸 그냥
      // `Object.entries` 에 넘기면 조용히 쓰레기 키('0','1',…)로 채워진다 — 파싱 실패와
      // 같은 손상으로 보고 같은 경로(백업 + 빈 상태)로 보낸다. 손상 경로가 둘로 갈리면
      // 하나는 반드시 테스트되지 않는다.
      await this.quarantine('최상위가 세션 맵(객체) 형태가 아니다');
      return;
    }

    const sessions = new Map<string, SessionRecord>();
    for (const [key, value] of Object.entries(parsed)) {
      if (isSessionRecord(value)) {
        sessions.set(key, value);
      } else {
        // 레코드 하나가 깨졌다고 나머지 스레드의 세션까지 다 버릴 이유는 없다 — 그 레코드만
        // 버리고 나머지는 살린다. 대신 무엇을 버렸는지는 남긴다.
        console.warn(`[sessions] ${this.filePath} 의 '${key}' 레코드가 SessionRecord 모양이 아니다 — 이 레코드만 버린다`);
      }
    }
    this.sessions = sessions;
  }

  // 파일 자체가 손상됐을 때(파싱 실패 또는 세션 맵이 아닌 모양) 공통으로 타는 경로.
  // 원본은 조사할 수 있게 옆으로 치워 두고, 빈 상태로 계속 진행한다 — 세션 전체를 잃는
  // 것보다 러너가 못 뜨는 게 훨씬 큰 손해다.
  private async quarantine(reason: string): Promise<void> {
    const backupPath = `${this.filePath}.broken-${Date.now()}`;
    await rename(this.filePath, backupPath).catch(() => {});
    console.warn(`[sessions] ${this.filePath} 문제(${reason}) — 빈 상태로 시작한다 (원본은 ${backupPath} 에 보존)`);
    this.sessions = new Map();
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
    // flush 마다 유일한 tmp 이름을 쓴다 — 쓰기 큐가 있어도, 원자성(각 flush 가 남의 tmp 를
    // 밟지 않는 것)은 직렬성(호출 순서)과 별개로 보장해 둬야 나중에 큐 쪽만 손보다 이 부분을
    // 깨뜨리는 일이 없다.
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const body = JSON.stringify(Object.fromEntries(this.sessions), null, 2);
    // tmp 에 다 쓴 뒤 rename — 세션 id 자체는 비밀이 아니지만 굳이 넓게 열어 둘 이유도 없어
    // 0o600 으로 좁힌다. rename 은 원자적이라 쓰는 도중 프로세스가 죽어도 기존 파일은 온전하다.
    await writeFile(tmpPath, body, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
