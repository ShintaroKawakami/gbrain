---
name: settings-protection-coexistence
description: settings.json等の保護テスト（直接編集ブロック）と、telemetry配線等の正当な変更を共存させる手順。テスト赤のままマージしない
paths:
  - '.claude/**'
  - '.codex/**'
  - '.cursor/**'
  - '.gemini/**'
  - '.kimi-code/**'
  - '.augment/**'
  - '.opencode/**'
  - '.githooks/**'
  - 'tests/test_handover_manual.py'
  - 'skills/handover-manual/scripts/resolve-handover-path.py'
---

<!-- [2026-07-07][feat]
背景:
  - ユーザー依頼意図: 2026-07-06 PR #742 で「自己テレメトリ配線の正当な変更が保護テスト
    （tests/test_handover_manual.py::test_protected_paths_are_not_directly_edited）を赤にしたまま、
    内容はレビュー済み・有効だったためマージされた」。保護パス（settings.json 等）への正当な配線変更を
    安全に通す手順が明文化されておらず、テスト赤マージが個別対応・都度判断になっていた。
  - 守るべき業務ルール: 保護テストは `.claude/` `.codex/` `.cursor/` `.gemini/` `.kimi-code/` `.augment/`
    `.opencode/` `.githooks/` `claude-plans/` `node_modules/` と `.env` 系への**プレフィックス一致**で
    広く保護判定する（`is_protected_path()`）。この粗さゆえ `.claude/rules/general/*.md` の新規ルール追加のような
    正当な変更も毎回引っかかる。テストの検査ロジック自体を弱めず、allowlist（fix-forward）で個別許可する
    既存パターン（PR#637 / #666 / #695 / #736）を標準手順として明文化する。
  - 他案不採用理由: (1) 保護テストの対象プレフィックスを狭める案は、真に守りたい settings.json / hooks.json 等の
    誤編集検知力を落とすため不採用。(2) 都度アドホックに allowlist へ足すだけで手順化しない案は、
    #742 のように「テスト赤のままマージ」を再発させるため不採用（手順として明文化し merge ゲートと接続する）。
対応: 保護パスの検査対象・allowlist機構・共存手順（配布経由を優先→どうしても直接編集ならallowlist追加→
  テスト赤のままマージしない）を明文化する。
-->

# settings.json 等の保護テストと正当な配線変更の共存ルール

## 原則

`.claude/` `.codex/` `.cursor/` `.gemini/` `.kimi-code/` `.augment/` `.opencode/` `.githooks/`
`claude-plans/` `node_modules/` 配下および `.env` / `.env.*` は、`tests/test_handover_manual.py::test_protected_paths_are_not_directly_edited`
が **プレフィックス一致で広く保護対象と判定**する（実装: `skills/handover-manual/scripts/resolve-handover-path.py` の `is_protected_path()`、
`PROTECTED_PREFIXES`）。テストは `origin/main` とのマージベース以降 + working tree + staged の変更ファイルを走査し、
保護対象なのに `allowed_managed_placements`（テスト内のallowlist）に無いパスがあれば **fail** する。

この判定は粗い（ディレクトリ丸ごと保護）ため、telemetry 配線・新規ルール追加・hook 再配備など
**正当な変更でも毎回検知される**。これは仕様であり、バグではない。正当な変更を安全に通す手順は以下。

## 必須手順

1. **まず中央配布経路で済まないか確認する**: project harness は `scripts/sync-agents.py --project <pj> --dry-run`
   で全surfaceを確認し、承認後だけcleanな専用linked worktreeへfull applyする。個別writerを手で連結しない。
2. **どうしても直接編集が必要なら、同一PRで `allowed_managed_placements` に追加する**:
   `tests/test_handover_manual.py::test_protected_paths_are_not_directly_edited` 内のセットへ、
   変更した具体パスと日付・理由コメントを添えて追記する（例: `# [YYYY-MM-DD][fix] PR#nnn で〜が弾かれた。理由。`）。
   既存の fix-forward 例（PR#637 `ai-model-selection.md` / PR#666 `constructive-dissent.md` /
   PR#695 `responsive-both-viewports.md` / PR#736 `dotfiles/.env.example`）と同じパターンに倣う。
3. **保護テストの検査ロジック自体を弱めない**: `is_protected_path()` のプレフィックス判定や
   `changed_paths_for_protected_check()` の走査範囲を変更・無効化しない。許可は必ず allowlist の
   個別パス追加で行う（一括 skip・正規表現の緩和は禁止）。
4. **テスト赤のままマージしない**: `python3 -m pytest tests/test_handover_manual.py -q` を PR 作成前に
   ローカル実行し green を確認する。CI の同テストが赤の状態での merge は `branch-rule.md` の
   CI 緑ゲートに反する（#742 の再発防止）。

## 関連

- `.claude/rules/general/branch-rule.md` — main 直接コミット禁止・CI緑ゲート
- `.claude/rules/general/plan-commitment-tracking.md` — workaround 自問（正本修正を先送りしない）
- `.claude/rules/general/hooks-structure-rule.md` — hook 配置の隣接ルール（配布経由の管理配置）
- `tests/test_handover_manual.py` — 保護テスト本体・allowlist 実体
- `skills/handover-manual/scripts/resolve-handover-path.py` — `is_protected_path()` / `PROTECTED_PREFIXES` 実装
