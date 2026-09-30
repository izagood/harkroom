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

  test('토큰이 없는 본문은 손대지 않는다', () {
    expect(renderMentions('메일은 a@example.com, <@not-an-id>', accounts, '@?'),
        '메일은 a@example.com, <@not-an-id>');
  });
}
