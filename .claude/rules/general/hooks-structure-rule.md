---
description: hooks構造ルール — チェックリストMDの配置制約とゾンビ復活禁止
paths:
  - 'hook-library/**'
  - 'hook-registry.yaml'
  - 'scripts/deploy-hooks.py'
---

# hooks 構造ルール

<!-- [2026-04-26][feat]
背景:
  - ユーザー依頼意図: jtt-cms 側で運用していた hooks 構造ルール（特に削除済みファイル復活の禁止事項）を
    AGENT-HUB の正本側にも置き、AI が hook-library / registry / deploy-hooks.py を編集する際に
    paths frontmatter で自動ロードされる形で強制したい。
  - 守るべき業務ルール: `security-review-check.md` を SSOT とし、重複していた `supabase-sql-review.md` は
    削除済みのまま戻さない。registry / deploy-hooks.py / hook-library の三者で同じ判断基準を共有する。
  - 他案不採用理由: jtt-cms 側だけにルールを置く案では AGENT-HUB を編集する AI がルールを読まず、
    過去に発生したゾンビ復活が再発するリスクが残るため不採用。
対応: jtt-cms `.claude/rules/general/hooks-structure-rule.md` を AGENT-HUB に上流取り込みし、
  paths を AGENT-HUB の構造（hook-library/ / hook-registry.yaml / scripts/deploy-hooks.py）に適合させた。
-->

## チェックリストMDの配置

| 正しい配置                                            | 禁止                       |
| ----------------------------------------------------- | -------------------------- |
| `hook-library/lib/code-quality-check.md`              | `hook-library/prompts/`    |
| `hook-library/checklists/security/security-review-check.md` | 任意の新規サブディレクトリ |

配布後の PJ 側でも同じ規約に従う:

| 正しい配置                                   | 禁止                       |
| -------------------------------------------- | -------------------------- |
| `.claude/hooks/lib/code-quality-check.md`    | `.claude/hooks/prompts/`   |
| `.claude/hooks/lib/security-review-check.md` | 任意の新規サブディレクトリ |

## 禁止事項

- `prompts/` ディレクトリの作成・復活（AGENT-HUB / 配布先 PJ いずれも）
- `quality-check-common.sh` のチェックリスト参照パスを `lib/` 以外に変更
- `supabase-sql-review.md` の復活（`security-review-check.md` と重複していた削除済みファイル）
- `ui-quality-gate.json` の復活（`type: "prompt"` でレビュー LLM に丸投げする方式は失敗時にプロンプト原文がチャットに漏れるため廃止。UI 品質チェックは `code-quality-check.md` の `ui-quality-jp` domain を `subagent-quality-check.sh` / `stop-quality-check.sh` がファイル参照型で reason に出す形で完結する）
- `hook-registry.yaml` の `checklist.security` に `KNOWN_SECURITY_CHECKLISTS` allow-list 外の名前を書くこと（`scripts/deploy-hooks.py` が fail-fast で拒否する）
- 対象PJを明示せずに hook を追加・配布すること。新規 hook は「必要な PJ」「不要な PJ」「Codex/Augment へ載せるか」を AGENT-HUB セッションで決めてから `hook-registry.yaml` に登録する。
- `/hook-publish` の復活。project 配布applyは
  `scripts/sync-agents.py --project <project> --project-root <clean-linked-worktree>` だけを公開入口とし、物理 hook writerを単独実行しない。

## hook 追加・配布フロー

1. AGENT-HUB セッションで hook の目的と対象PJを決める。
2. `hook-library/scripts/`、`hook-library/settings/`、`scripts/deploy-hooks.py` の script map、`hook-registry.yaml` を同一PRで更新する。
3. `scripts/sync-agents.py --project <project> --dry-run` で全 surface の同一generation差分を確認する。
4. 実配布が必要ならcleanな専用linked worktreeを明示してfull applyする。複数PJでも明示リストを1件ずつ処理する。
5. 個別 writer の `--all` は使わない。全PJの一括同期は別の明示承認とscope確認を必要とする。

## チェックリスト注入方式

| 方式                     | 説明                                                      |
| ------------------------ | --------------------------------------------------------- |
| ファイル参照型（採用）   | reason にファイルパスを記載し、AIがReadツールで読む       |
| インライン注入型（廃止） | reason にチェックリスト全文を埋め込む（チャットが埋まる） |

reason にチェックリスト全文を埋め込まないこと。AI が Read ツールでファイルを読む形にすることで、ユーザーのチャット視認性を確保する。

## 配布スクリプトによる強制ガード（`scripts/deploy-hooks.py:merge_settings()`）

| ガード | 役割 |
| --- | --- |
| `_strip_prompt_type_hooks()` | `type: "prompt"` の hook をマージ時に強制除去。インライン注入型の混入を配布パイプラインで遮断する |
| `_dedupe_hooks_by_command()` | `(matcher, paths, command)` ベースで dedupe。dict 完全一致比較が空白・キー順差で破綻し、過去 jtt-cms に重複 4 件（`prettier-format` / `seo-check` / `storage-url-check` / `block-main-commit`）が混入した実績の再発防止 |

これらのガードと `--all --confirm-all-hook-scope` の安全弁を外す変更は禁止。検証スクリプト `scripts/test-deploy-hooks-merge-settings.sh` がガードの挙動を回帰チェックする。

## 理由

`scripts/deploy-hooks.py`（テンプレート配布スクリプト）は配布先 PJ の `lib/` にチェックリストMDをデプロイする。`quality-check-common.sh`（runtime）が異なるパスを参照すると、新規 PJ セットアップ後に品質チェックリストが見つからず approve が素通りする。

`security-review-check.md` の内容は SECURITY DEFINER / RLS / `crm.` schema 等 Supabase + Postgres 専用のため、Supabase を使わない PJ には配布しない（registry の `checklist.security` を空配列にする）。
