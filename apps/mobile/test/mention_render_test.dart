import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/mention/render.dart';

/// 서버가 주는 본문은 `<@계정id>` 정본이다 — 실서버에 붙여 보기 전까지 모바일은 이것을
/// 날것으로 그렸다(시험의 가짜 서버가 `@handle` 을 줬다).
void main() {
  const id = '0f3c1b2a-1111-4222-8333-944455556666';
  final accounts = {
    id: const AccountView(
      id: id,
      handle: 'forge',
      displayName: 'Forge',
      isAgent: true,
      isDisabled: false,
      avatarAttachmentId: null,
    ),
  };

  test('계정 토큰은 지금의 handle 로 그린다', () {
    expect(renderMentions('<@$id> 이거 봐', accounts, '@?'), '@forge 이거 봐');
  });

  test('모르는 계정·팀·집합은 날것 대신 표시 문구로 그린다', () {
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(renderMentions('<@$other>', accounts, '@?'), '@?');
    expect(renderMentions('<@team:$other> 와 <@group:$other>', accounts, '@?'), '@? 와 @?');
  });

  MessageRow row(String body, {MessageKind kind = MessageKind.system, Map<String, Object?> meta = const {}}) => MessageRow(
        id: 'm1',
        seq: 1,
        channelId: 'c1',
        threadRootId: 'r1',
        authorId: id,
        body: body,
        kind: kind,
        meta: meta,
        createdAt: DateTime.utc(2026, 10, 2),
        editedAt: null,
        reactions: const [],
        attachments: const [],
        replyCount: null,
      );
  String shown(MessageRow m) => displayBody(m, accounts, unknownMention: '@?', unknownAccount: '?');

  // TestFlight 실측: 스레드 모델 지정 줄이 `{account}님이 …` 로 그대로 나왔다.
  test('시스템 메시지의 {account} 는 meta.accountId 의 지금 handle 로 채운다(@ 없이)', () {
    expect(shown(row('{account}님이 이 스레드에서 infra 의 모델을 fable 로 정했습니다.', meta: {'accountId': id})),
        'forge님이 이 스레드에서 infra 의 모델을 fable 로 정했습니다.');
  });

  test('모르는 계정이면 표시 문구로, meta.accountId 가 없거나 시스템이 아니면 그대로', () {
    expect(shown(row('{account}님이 나갔습니다.', meta: {'accountId': 'gone'})), '?님이 나갔습니다.');
    expect(shown(row('jaebin님이 나갔습니다.')), 'jaebin님이 나갔습니다.');
    expect(shown(row('{account} 는 글자다', kind: MessageKind.user, meta: {'accountId': id})), '{account} 는 글자다');
  });

  test('채운 뒤 멘션 토큰도 그린다', () {
    expect(shown(row('{account}님 <@$id>', meta: {'accountId': id})), 'forge님 @forge');
  });

  test('토큰이 없는 본문은 손대지 않는다', () {
    expect(renderMentions('메일은 a@example.com, <@not-an-id>', accounts, '@?'),
        '메일은 a@example.com, <@not-an-id>');
  });
}
