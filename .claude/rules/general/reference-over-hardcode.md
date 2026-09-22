---
description: ハードコード排除・参照型設計
paths:
  - "**/*.yaml"
  - "**/*.yml"
  - "**/*.json"
  - "scripts/**/*.py"
  - ".claude/rules/**/*.md"
  - "skills/**/*.md"
---

# ハードコード排除・参照型設計（グローバル憲法）

制定経緯（CaD）: `~/business/AGENT-HUB/docs/architecture/rules-general-cad-archive.md`「reference-over-hardcode.md からの移設」節を参照。

## 原則

**ハードコード（直書き）をしない。** 設定値・手順・API 名・パス・思想・スタイルなど、2 箇所以上で必要になる情報は、**正本（SSOT）を 1 箇所に置き、他はそれをライブ参照する**（参照型設計）。

- どうしても直書きが必要な場合は、**1 箇所に集約**し、なぜ集約先を作ったのかを CaD コメント等に残す。
- 「そこだけ直書き」を積み重ねると、後から値がずれる・改訂が反映されない・矛盾が生まれる。これは規模の大小を問わず起きる。

この原則は、サブエージェント作成・SSOT 構築・hook 実装・YAML 台帳・skill・rule のどの作業でも同じ扱いにする。特定のフェーズだけに適用される限定ルールではない。

## 参照型の実例

- **設計思想**: `~/business/AGENT-HUB/docs/design/design-philosophy.md` に集約し、UI/デザインに関わる各所（stitch-screen-creator 等のサブエージェント、UI 作成フロー）からライブ参照する。思想を各 PJ の rule や skill に複製しない。
- **MCP キー**: `~/.config/agent-hub/.env` に実値を集約し、各 PJ の `.mcp.json` や sync スクリプトはそこから展開する（`.claude/rules/general/mcp-key-management.md`）。`~/mcp-servers/<svc>/.env` への直書きは禁止。
- **スキル手順**: 各 rule は手順を複製せず、手順 SSOT（skill）をライブ読みで参照する（例: `plan-approval-gate.md` が `skills/plan-approval/SKILL.md` を参照する二段構え）。

## 発火場面

- 新しい設定値・API 名・閾値・手順・文言などを**2 箇所以上に書きそうになった時**。
- 既存の rule / skill / doc の内容を**別ファイルにコピーして使いたくなった時**（コピーせず参照にする）。
- サブエージェントや AI worker への delegate プロンプトに、正本にある情報を**そのまま貼り付けたくなった時**（正本のパスを渡し、読ませる方を優先する）。
- **配布物（他 PJ へ配る rule / agent / skill）から AGENT-HUB 専用ファイルを参照する時**: 相対パス（`docs/design/...`）ではなく**絶対パス**（`~/business/AGENT-HUB/docs/design/design-philosophy.md`）で書く。配布先 PJ の実行 cwd はその PJ 自身であり、相対パスでは正本を解決できず参照が壊れる（2026-07-07 実装監査が検出）。

## 個人開発スケールとの両立

`.claude/rules/general/constructive-dissent.md`「個人開発スケールと例外」節を参照（同根の原則・過剰な抽象化を避け素朴な解決を優先する基準）。

## 関連

- `.claude/rules/general/constructive-dissent.md` — 言いなり禁止・グローバル憲法（同種の常時ロード規範。メンテナンス観点の先出し提案として「正本参照」を挙げている）
- `~/business/AGENT-HUB/docs/design/design-philosophy.md` — 参照型設計の実例（G-Brain 正本からの派生ドキュメント）
- `.claude/rules/general/mcp-key-management.md` — MCP API キー一元管理（参照型設計の実例）

この原則は G-Brain の上流原則 `principle-single-source-of-truth-reference`（伸太郎殿の開発大原則）と同根である。

---

**追記ルール: 実測事例・長文詳細・制定経緯は `docs/architecture/rules-general-cad-archive.md` へ書き、本ルールには義務・トリガー・禁止事項だけ足す（再肥大化防止）。**
