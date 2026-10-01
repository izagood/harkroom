// 스레드 × 에이전트 모델 지정(서버 079) — 모바일 작성칸이 무엇을 보내는가.
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/screens/agent_model.dart';

AccountView _acc(String id, String handle, {bool agent = true}) => AccountView(
      id: id, handle: handle, displayName: handle, isAgent: agent, isDisabled: false, avatarAttachmentId: null,
    );

void main() {
  final accounts = [_acc('a1', 'forge'), _acc('a2', 'codex'), _acc('u1', 'mina', agent: false)];

  test('본문이 부르는 에이전트 것만 보내고, `기본`(두 축 null)은 빼서 보낸다', () {
    final out = picksForBody({
      'a1': (model: 'opus', effort: null),
      'a2': (model: 'gpt-5.5', effort: null), // 고른 뒤 본문에서 지웠다
    }, '@forge 고도화', accounts);
    expect(out.keys, ['a1']);
    expect(picksForBody({'a1': (model: null, effort: null)}, '@forge', accounts), isEmpty);
  });

  test('이어받은 지정을 풀면(두 축 null) 스레드에 지정이 있을 때만 싣는다 — 그래야 실제로 풀린다', () {
    const row = ThreadAgentModel(agentId: 'a1', model: 'opus', effort: null, stale: false);
    final out = picksForBody({'a1': (model: null, effort: null)}, '@forge 이어서', accounts, threadRows: const [row]);
    expect(out, {'a1': (model: null, effort: null)});
  });

  test('칩 꼬리의 "정한 에이전트"(087 결정 7): 에이전트 지정만, 모르는 계정은 빈 문자열', () {
    final byId = {for (final a in accounts) a.id: a};
    ThreadAgentModel row({String? by, String kind = 'human'}) => ThreadAgentModel(
          agentId: 'a1', model: 'opus', effort: null, stale: false, setBy: by, setByKind: kind,
        );
    expect(setByAgentHandle(row(by: 'a2', kind: 'agent'), byId), 'codex');
    expect(setByAgentHandle(row(by: 'gone', kind: 'agent'), byId), '');
    expect(setByAgentHandle(row(by: null, kind: 'agent'), byId), '');
    expect(setByAgentHandle(row(by: 'u1'), byId), isNull);
    expect(setByAgentHandle(null, byId), isNull);
    // 옛 서버는 setByKind 를 싣지 않는다 — 사람 지정으로 읽는다.
    expect(ThreadAgentModel.fromJson({'agentId': 'a1', 'model': 'opus'}).setByKind, 'human');
    expect(ThreadAgentModel.fromJson({'agentId': 'a1', 'model': 'opus', 'setByKind': 'agent', 'setBy': 'a2'}).setBy, 'a2');
  });

  test('부르는 에이전트는 사람을 빼고 순서대로', () {
    expect(calledAgentIds('@mina @codex @forge', accounts), ['a2', 'a1']);
  });
}
