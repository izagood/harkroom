import 'package:flutter/material.dart';

import '../api/permission_card.dart';
import '../i18n/i18n.dart';
import '../ui/tokens.dart';

/// 🔑 위임장 칩. 이름이 비면(뿌리 채널을 이 채널 청중이 다 보지 못함) 「🔑 위임장 · @소유자 · MM-DD 시작」.
class MandateChip extends StatelessWidget {
  const MandateChip({super.key, required this.mandate, this.ownerHandle});

  final PermissionCardMandate mandate;
  final String? ownerHandle;

  static String? mmdd(String? iso) {
    final at = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    if (at == null) return null;
    return '${at.month.toString().padLeft(2, '0')}-${at.day.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final tok = context.tokens;
    final date = mmdd(mandate.startedAt);
    final parts = <String>[
      if (mandate.name.isNotEmpty) mandate.name else t.permMandateChip,
      if (mandate.name.isEmpty && ownerHandle != null) '@$ownerHandle',
      if (date != null) mandate.name.isEmpty ? t.permMandateStarted(date) : date,
    ];
    return Container(
      key: const Key('perm-mandate-chip'),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: tok.accentSurface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: tok.border),
      ),
      child: Text(
        '🔑 ${parts.join(' · ')}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(color: tok.accentText),
      ),
    );
  }
}

/// 더할 줄 — cap 알약 · 고정폭 scope · 한도 칩.
class PermissionLineBox extends StatelessWidget {
  const PermissionLineBox({super.key, required this.line, this.limits, this.once});

  final PermissionCardLine line;
  final PermissionCardLimits? limits;
  final PermissionCardOnce? once;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final tok = context.tokens;
    final theme = Theme.of(context);
    final l = limits;
    final chips = <String>[
      if (once != null) 'PR #${once!.number}',
      if (once != null) 'head ${once!.headSha.length > 7 ? once!.headSha.substring(0, 7) : once!.headSha}',
      if (once == null && l?.pr != null) 'PR #${l!.pr}',
      if (l?.untilMs != null)
        l!.untilMs! >= 86400000 ? t.permLimitDays((l.untilMs! / 86400000).round()) : t.permLimitHours((l.untilMs! / 3600000).ceil()),
      if (l?.uses != null) t.permLimitUses(l!.uses!),
      if (l?.ciOverride == true || (once?.ci ?? false)) t.permLimitCi,
    ];
    return Container(
      key: const Key('perm-line'),
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: tok.surfaceSunken,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: tok.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Container(
                key: const Key('perm-cap'),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(color: tok.surfaceInverse, borderRadius: BorderRadius.circular(4)),
                child: Text(line.cap, style: theme.textTheme.labelSmall?.copyWith(color: tok.fgOnInverse, fontWeight: FontWeight.w700)),
              ),
              Text(line.scope, key: const Key('perm-scope'), style: theme.textTheme.bodySmall?.copyWith(fontFamily: 'monospace', color: tok.fg)),
            ],
          ),
          if (chips.isNotEmpty) ...[
            const SizedBox(height: 6),
            Wrap(
              spacing: 6,
              runSpacing: 4,
              children: [
                for (final c in chips)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(border: Border.all(color: tok.border), borderRadius: BorderRadius.circular(999), color: tok.surface),
                    child: Text(c, style: theme.textTheme.labelSmall?.copyWith(color: tok.fgMuted)),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
