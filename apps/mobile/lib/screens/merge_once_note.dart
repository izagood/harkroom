import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';

/// 머지 거절에서 온 권한 카드의 [이번 한 번 머지](스레드 1b75d7a0, designer 시안 §모바일 1판).
///
/// 1회 승인은 머지할 GitHub 계정을 고르는 승인이고, 그 계정 목록은 에이전트가 도는 기기의 오퍼레이터에만 있다 — 모바일에서는
/// 고를 수 없다. 그래서 버튼은 보이게 두고 누르면 「데스크톱에서 승인하세요」 시트만 연다. 7일 허락·거절은 아래 선택 카드 그대로다.
/// 소유자에게만, 카드가 아직 정해지지 않았을 때만 선다(판정은 서버가 한다).
class MergeOnceNote extends StatelessWidget {
  const MergeOnceNote({super.key, required this.message, required this.number});

  final MessageRow message;
  final int number;

  /// `meta.permissionRequest` 가 머지이고 거절에서 왔으며(once) 아직 기다리는 중이면 PR 번호, 아니면 null.
  static int? pendingNumber(Map<String, Object?> meta, String? meId) {
    final p = meta['permissionRequest'];
    if (p is! Map) return null;
    if (p['kind'] != 'merge' || meId == null || p['ownerAccountId'] != meId) return null;
    final status = p['status'];
    if (status != null && status != 'pending') return null;
    final once = p['once'];
    if (once is! Map) return null;
    final n = once['number'];
    return n is int ? n : null;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Align(
      alignment: Alignment.centerLeft,
      child: OutlinedButton(
        key: Key('merge-once-${message.id}'),
        onPressed: () => showModalBottomSheet<void>(
          context: context,
          builder: (ctx) => SafeArea(
            child: Padding(
              key: const Key('merge-once-sheet'),
              padding: const EdgeInsets.all(16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(t.mergeOnceSheetTitle, style: Theme.of(ctx).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  Text(t.mergeOnceSheetBody),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(onPressed: () => Navigator.of(ctx).pop(), child: Text(MaterialLocalizations.of(ctx).closeButtonLabel)),
                  ),
                ],
              ),
            ),
          ),
        ),
        child: Text('${t.mergeOnceButton} · PR #$number'),
      ),
    );
  }
}
