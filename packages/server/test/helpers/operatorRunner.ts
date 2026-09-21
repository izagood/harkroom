/**
 * 오퍼레이터 채널 위의 가짜 러너(단계 3, 스펙 2026-09-20 §5).
 *
 * 옛 테스트들은 `/agent-relay` 에 PAT 로 붙는 `connectRunner(pat)` 를 각자 들고 있었다. 그 소켓은
 * 사라졌다 — 러너 프레임은 오퍼레이터가 `runnerId` 를 달아 `/operator` 채널에 싣는다. 이 헬퍼가
 * 그 절차 전부를 감춘다(등록 → hello → 배정 → runner.started)라, 테스트 본문은 여전히 릴레이
 * 프레임(`RelayRunnerFrame`/`RelayServerFrame`)만 다룬다: 지키려는 사실이 바뀐 것이 아니라 그
 * 사실이 흐르는 관이 바뀐 것이기 때문이다.
 *
 * 오퍼레이터는 팩토리당 **하나**다. 붙을 때마다 새 소켓으로 다시 붙고(앞 소켓은 허브가 교체로
 * 끊는다) 능력에 그동안 본 에이전트를 전부 싣는다 — 한 파일이 에이전트 둘을 쓰는 경우가 있다.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import type { OperatorToServerFrame, ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { unwrapServerFrame, wrapRunnerFrame } from '@harkroom/shared/runnerLink';
import { registerOperator } from './fixtures.js';

export interface OperatorRunner {
  socket: WebSocket;
  operatorId: string;
  runnerId: string;
  /** 서버가 이 러너에게 보낸 프레임(runnerId 를 뗀 것). 다른 러너의 것은 안 섞인다. */
  received: RelayServerFrame[];
  send(frame: RelayRunnerFrame): void;
  /** 이 러너에게 오는 프레임을 도착 순서대로 받는다(`received` 에 쌓이는 것과 같은 것). */
  onFrame(listener: (frame: RelayServerFrame) => void): void;
  /** 오퍼레이터 소켓을 닫는다 — 서버는 이 오퍼레이터의 러너 전부를 떨어진 것으로 본다. */
  close(): Promise<void>;
  /** 소켓 읽기를 멈춘다 — ping 이 와도 pong 이 안 나간다(케이블이 뽑힌 피어). */
  wedge(): void;
}

export interface OperatorRunnerFactory {
  connect(agentId: string): Promise<OperatorRunner>;
  operatorId(): Promise<string>;
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const waitForAsync = async (pred: () => Promise<boolean>, ms = 4000): Promise<void> => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * @param adminToken 배정할 수 있는 사람의 토큰(`agent.manage`). admin 이면 어느 오퍼레이터에도 배정한다.
 * @param baseUrl `host:port` — `app.listen` 뒤의 주소.
 */
export function operatorRunnerFactory(app: FastifyInstance, baseUrl: () => string, adminToken: string): OperatorRunnerFactory {
  let op: Promise<{ token: string; operatorId: string }> | null = null;
  const capable = new Set<string>();
  const operator = () => (op ??= registerOperator(app, adminToken, `test-op-${randomUUID().slice(0, 8)}`));

  return {
    operatorId: async () => (await operator()).operatorId,
    async connect(agentId) {
      const { token, operatorId } = await operator();
      capable.add(agentId);
      const runnerId = randomUUID();
      const socket = new WebSocket(`ws://${baseUrl()}/operator`, { headers: auth(token) });
      const received: RelayServerFrame[] = [];
      const listeners: ((frame: RelayServerFrame) => void)[] = [];
      socket.on('message', (d) => {
        const frame = JSON.parse(String(d)) as ServerToOperatorFrame;
        if ((frame as { runnerId?: string }).runnerId !== runnerId) return;
        const inner = unwrapServerFrame(frame);
        if (!inner) return;
        received.push(inner);
        for (const l of listeners) l(inner);
      });
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve());
        socket.on('error', reject);
        socket.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
      });
      const hello: OperatorToServerFrame = {
        type: 'hello', protocol: 1, capabilities: { agentIds: [...capable], harnesses: {} }, runners: [], sessions: [],
      };
      socket.send(JSON.stringify(hello));
      // hello 가 허브에 반영돼야 배정이 409 가 아니다 — 능력 조회로 확인한다.
      await waitForAsync(async () => {
        const res = await app.inject({ method: 'GET', url: `/operators/${operatorId}/capabilities`, headers: auth(adminToken) });
        return res.statusCode === 200 && (res.json().agentIds as string[]).includes(agentId);
      });
      const assigned = await app.inject({
        method: 'PUT', url: `/accounts/agents/${agentId}/assignment`, headers: auth(adminToken), payload: { operatorId },
      });
      if (assigned.statusCode !== 200) throw new Error(`배정 실패: ${assigned.statusCode} ${assigned.body}`);
      const started: OperatorToServerFrame = { type: 'runner.started', agentId, runnerId };
      socket.send(JSON.stringify(started));
      return {
        socket, operatorId, runnerId, received,
        onFrame: (listener) => { listeners.push(listener); },
        send: (frame) => {
          const wrapped = wrapRunnerFrame(runnerId, frame);
          if (!wrapped) throw new Error(`감쌀 수 없는 프레임: ${frame.type}`);
          socket.send(JSON.stringify(wrapped));
        },
        close: () => new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
          socket.on('close', () => resolve()); socket.close();
        }),
        wedge: () => (socket as unknown as { _socket: { pause(): void } })._socket.pause(),
      };
    },
  };
}
