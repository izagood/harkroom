import 'package:flutter/material.dart';

import '../i18n/i18n.dart';

/// 작성칸 왼쪽 **@ 버튼**(개정판 3.4). 누르면 커서 자리에 `@` 를 넣고 칸에 포커스를 준다 —
/// 그러면 `@` 후보 줄이 선다.
///
/// 자리표시에서 "@ 로 에이전트를 부른다" 를 뺀 뒤(S4b), 처음 쓰는 사람이 부르는 길을 찾을
/// 자리가 이 버튼이다(designer #1032).
class MentionButton extends StatelessWidget {
  const MentionButton({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.onInserted,
  });

  final TextEditingController controller;
  final FocusNode focusNode;

  /// 넣은 뒤 부른다 — 화면이 다시 그려져야 후보 줄이 글자를 읽는다.
  final VoidCallback onInserted;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: const Key('mention-add'),
      tooltip: context.t.mentionAdd,
      icon: const Icon(Icons.alternate_email),
      onPressed: () {
        insertMentionTrigger(controller);
        focusNode.requestFocus();
        onInserted();
      },
    );
  }
}

/// 커서 자리(고른 글이 있으면 그 자리)에 `@` 를 넣는다. 앞 글자가 공백이 아니면 띄우고 넣는다 —
/// `안녕@` 은 멘션으로 읽히지 않는다.
void insertMentionTrigger(TextEditingController controller) {
  final text = controller.text;
  final sel = controller.selection;
  final start = sel.isValid ? sel.start : text.length;
  final end = sel.isValid ? sel.end : text.length;
  final before = text.substring(0, start);
  final glue = before.isEmpty || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';
  final inserted = '$glue@';
  controller.value = TextEditingValue(
    text: before + inserted + text.substring(end),
    selection: TextSelection.collapsed(offset: start + inserted.length),
  );
}
