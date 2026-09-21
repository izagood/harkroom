// 오퍼레이터 허브 — 스펙 2026-09-20 §4. 붙어 있는 오퍼레이터와 그들이 `hello` 로 알린 것
// (능력·러너)을 **연결이 살아 있는 동안만** 든다. 저장하지 않는 이유는 스펙 §3 확정대로:
// 능력은 오퍼레이터가 살아 있을 때의 사실이지 기록이 아니다 — 테이블에 남기면 꺼진 머신의
// 능력이 UI 에 계속 보인다.
//
// 러너 릴레이 허브(`relay.ts`)와 별개다. 단계 3 에서 그쪽 세션 맵이 이 허브 위로 올라온다 —
// 그때까지 이 허브는 "누가 붙어 있고 무엇을 돌릴 수 있나"만 안다.
import { EventEmitter } from 'node:events';
import type { OperatorCapabilities } from '@harkroom/shared';
import {
  parseOperatorFrame, type OperatorToServerFrame, type ServerToOperatorFrame,
} from '@harkroom/shared/operatorProtocol';
import type { RelaySocket } from './relay.js';

interface LiveOperator {
  socket: RelaySocket;
  capabilities: OperatorCapabilities | null;
  /** runnerId → agentId. hello 의 announce 와 runner.started/exited 가 유지한다. */
  runners: Map<string, string>;
}

export interface OperatorHub {
  /**
   * 오퍼레이터 소켓을 등록한다. 같은 오퍼레이터가 두 번 붙으면 **앞의 것을 끊는다** —
   * 재접속이 앞 소켓의 close 보다 먼저 도착하는 순서가 실제로 있다(릴레이 허브의 같은 판단).
   * 반환값을 부르면 등록을 지운다(소켓 close 경로).
   */
  addOperator(operatorId: string, socket: RelaySocket): () => void;
  /** 원문 프레임 한 개. 파싱 실패·모르는 타입은 조용히 버린다. */
  onOperatorMessage(operatorId: string, raw: string): void;
  isOnline(operatorId: string): boolean;
  capabilities(operatorId: string): OperatorCapabilities | null;
  /** 보냈는가까지다 — 오프라인이면 false. 도착은 프레임 왕복이 말한다. */
  send(operatorId: string, frame: ServerToOperatorFrame): boolean;
  /** 이 에이전트의 러너가 지금 어느 오퍼레이터에 살아 있나. 없으면 null. */
  runnerOf(agentId: string): { operatorId: string; runnerId: string } | null;
  /** 파싱된 모든 프레임을 구독한다. 배정 라우트(hello 에 배정 재전송)와 릴레이(단계 3)가 쓴다. */
  onFrame(listener: (operatorId: string, frame: OperatorToServerFrame) => void): () => void;
  /** 오퍼레이터가 떨어졌다(소켓 close·교체). 릴레이가 그 오퍼레이터의 러너 세션을 접는 근거다. */
  onClose(listener: (operatorId: string) => void): () => void;
}

export function createOperatorHub(): OperatorHub {
  const live = new Map<string, LiveOperator>();
  const bus = new EventEmitter();
  bus.setMaxListeners(100);

  return {
    addOperator(operatorId, socket) {
      const previous = live.get(operatorId);
      if (previous && previous.socket !== socket) {
        previous.socket.close(4409, 'replaced by a newer operator connection');
        // 교체도 끊김이다 — 앞 소켓의 러너들은 새 hello 가 다시 알린다.
        bus.emit('close', operatorId);
      }
      const entry: LiveOperator = { socket, capabilities: null, runners: new Map() };
      live.set(operatorId, entry);
      return () => {
        // 이미 다른 소켓으로 교체됐다면 그쪽 등록을 지우지 않는다.
        if (live.get(operatorId) !== entry) return;
        live.delete(operatorId);
        bus.emit('close', operatorId);
      };
    },

    onOperatorMessage(operatorId, raw) {
      const frame = parseOperatorFrame(raw);
      const entry = live.get(operatorId);
      if (!frame || !entry) return;
      if (frame.type === 'hello') {
        entry.capabilities = frame.capabilities;
        entry.runners = new Map(frame.runners.map((r) => [r.runnerId, r.agentId]));
      } else if (frame.type === 'capabilities') {
        // 앱이 오퍼레이터 로컬 설정을 고쳤다 — 러너 목록은 그대로, 능력만 바뀐다.
        entry.capabilities = frame.capabilities;
      } else if (frame.type === 'runner.started') {
        entry.runners.set(frame.runnerId, frame.agentId);
      } else if (frame.type === 'runner.exited') {
        entry.runners.delete(frame.runnerId);
      }
      bus.emit('frame', operatorId, frame);
    },

    isOnline: (operatorId) => live.has(operatorId),
    capabilities: (operatorId) => live.get(operatorId)?.capabilities ?? null,

    send(operatorId, frame) {
      const entry = live.get(operatorId);
      if (!entry) return false;
      // 소켓이 방금 죽었을 수 있다 — 던지게 두지 않는다. 재접속의 hello 가 배정을 다시 받는다.
      try { entry.socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    },

    runnerOf(agentId) {
      for (const [operatorId, entry] of live) {
        for (const [runnerId, a] of entry.runners) if (a === agentId) return { operatorId, runnerId };
      }
      return null;
    },

    onFrame(listener) {
      bus.on('frame', listener);
      return () => { bus.off('frame', listener); };
    },
    onClose(listener) {
      bus.on('close', listener);
      return () => { bus.off('close', listener); };
    },
  };
}
