<!-- agents-md-card:start -->
### CARD: gbrain-recall — 相談時は両G-Brain
- **いつ**: 相談・直し・判断の発話（毎回は探さない）
- **何を**: `shintaro-gbrain` と `tech-gbrain` の両方を検索（必須）。`jtt-gbrain` は `AVAILABLE` なら追加で見る（無くても止めない）。可用性の status と証拠は共通 rule に従う
- **できた状態**: `AVAILABLE` を確認した該当 brain を読んでから応答している（未確認・runtime unavailable は停止案内）
- **詳細**: `.claude/rules/general/gbrain-recall.md`
<!-- agents-md-card:end -->

# G-Brain リコール層（会話中の「読む側」発火条件）

制定経緯（CaD）: `~/business/AGENT-HUB/docs/architecture/rules-general-cad-archive.md`「gbrain-recall.md からの移設」節を参照。

## 0. scope 宣言（重複防止・複製しない）

本ルールは **非 plan の日常会話における「読む側」の発火条件だけ** を定義する。以下は別の正本が担当し、
本ルールでは内容を複製しない（G-Brain ハーネス設計仕様書 D9 役割分担表）:

| 責務 | 正本（変更しない・本ルールは複製しない） |
|------|------|
| plan 入口の preflight（読む） | `skills/plan-approval/plan-commitment-registry.yaml` seq 0.1 / 0.15 |
| 保存先の3層判断（書く） | `skills/agentmemory-routing/SKILL.md` + `agent-memory/registry/placement-policy.md` |
| put_page の安全手順・承認ゲート・合図式保存 | `skills/shintaro-gbrain/SKILL.md` |
| closeout 時の GBrain 候補承認キュー | `skills/handover-manual/SKILL.md`（合図式＝会話中の即時承認、closeout＝session 末の候補提示で別物） |
| auto-memory の参照 | `.claude/rules/general/memory-lookups.md`（相互参照のみ、内容は複製しない） |
| 敵対的レビュー手順（business） | `skills/adversarial-review/references/business-review.md` |

## 1. 発火条件表

**毎回の発言では探さない。** 相談・直し・判断のときだけ、応答を出す前に該当 brain を検索する。

| 発話・作業の性質 | 検索する先 | 例 |
|---|---|---|
| 相談・直し・判断（意見・修正方針） | **`shintaro-gbrain` と `tech-gbrain` の両方**（必須）＋ `jtt-gbrain` が `AVAILABLE` なら追加で | 「どう思う？」「直して」「修正して」「どうすれば」「どういう風に」 |
| バグ修正・障害調査・回帰の原因特定（上記に当たらない純粋な調査） | `tech-gbrain`（`mcp__tech-gbrain__search` / `recall`） | 「〇〇が直らない」「なぜこのエラーが出るか」「前も似た不具合あったはず」 |
| 経営相談・戦略・クレーム対応・売上・オペレーション改善（上記に当たらない） | `shintaro-gbrain`（判断軸）＋ `jtt-gbrain`（会社の事実）が `AVAILABLE` なら両方 | 「この施策の戦略は」「クレームにどう対応すべきか」「売上を改善したい」 |
| 会社そのものの事実（誰が・どの取引先・何が動いているか） | `jtt-gbrain`（`mcp__jtt-gbrain__search` / `recall`） | 「この件は誰の担当だっけ」「あの取引先との経緯は」「今どのPJが動いてる」 |
| 作業再開・引き継ぎ・「あの続き」 | `agentmemory`（continuation） | 「〇〇の続き」「前回どこまでやったか」 |

上表の「例」は説明用。hook（gbrain-recall-preflight）が実際に照合する発火語の正本は AGENT-HUB `hook-library/lib/gbrain-recall-policy.json` で、語の追加・変更はそこへ行う（本ファイルとスクリプトへ複製しない。2026-09-08 Policy as Code）。

3つの脳の切り分けは「その記述は誰／何がいなくなったら成立しなくなるか」で決める。

- `shintaro-gbrain` — 伸太郎さんが**別の会社を経営していても**まだ正しい（判断軸・好み）
- `jtt-gbrain` — **株式会社ジェイティティが無くなったら**意味を失う（人・取引先・PJ・会社としての戦略）
- `tech-gbrain` — **JTT と無関係のどのプロジェクトでも**使える（技術の知見）

判断に迷う場合は検索する側に倒す（誤爆コストは低く、未検索コストは高い）。

## 1-bis. tool availability の解決と必須 G-Brain の境界

§1 の検索先 MCP（`shintaro-gbrain` / `tech-gbrain` / `jtt-gbrain`）も、共通ルール
`.claude/rules/general/tool-availability-resolution.md` の証拠順序と status を使う。初期 tool
一覧に無いだけでは `OFF` と判定しない。catalog の欠落だけなら `UNPROVEN` とし、登録・選択・
runtime の証拠を確認するまで、検索済みだと主張しない。

**必須は `shintaro-gbrain` と `tech-gbrain` の2つ**。この2つは次の境界で扱う。

- `AVAILABLE`: 該当 brain を検索してから応答する。
- `RUNTIME_UNAVAILABLE`: 推測で進めず停止する。利用者へ「G-Brain の runtime が利用できないため、
  検索せずに推測で進めません。runtime を復旧してから続けます」と案内する。
- `NOT_SELECTED` / `UNPROVEN`: 選択・runtime の証拠が不足しているため検索済みと扱わず、確認できるまで
  判断を要する作業を進めない。

**`jtt-gbrain` は「あるなら追加で見る」**（2026-08-30 決定）。`AVAILABLE` なら検索し、
`NOT_SELECTED` / `UNPROVEN` / `RUNTIME_UNAVAILABLE` なら**その1つを飛ばして先へ進んでよい**（必須2つの
検索まで止めない）。飛ばした場合は、その旨を一言添える。

理由: 3つとも必須にすると、jtt-gbrain がまだ繋がっていない環境で既存2つの検索まで止まる。
配線の強制は別の層（`registries/mcp-registry.yaml` の `shintaro-gbrain.requires_assets` →
resolver の fail-close）が担っており、本ルールで二重に止める必要がない。

配線は harness type 依存であり、Claude Code / Codex でも status が異なることがある。
status を初期一覧の欠落から推測せず、確認できた根拠を明示する。

## 2. 検索実行の判断はモデル側に残す

本ルールは「検索しに行くべきタイミング」を定義するだけで、検索実行を強制する hook ではない。
`hook-library` の UserPromptSubmit hook（`gbrain-recall-preflight`）は軽量キーワード検知による
短いリマインドだけを担い、実際に検索するかどうかの判断はモデル自身が行う（仕様書 D6）。

## 3. 関連

- 手順・落とし穴の詳細: `skills/shintaro-gbrain/SKILL.md`
- 保存先判断の詳細: `skills/agentmemory-routing/SKILL.md`
- 仕様書: `claude-plans/2026-08-04-jtt-gbrain-harness-spec.md`（D6 / D9）

---

**追記ルール: 実測事例・長文詳細・制定経緯は `docs/architecture/rules-general-cad-archive.md` へ書き、本ルールには義務・トリガー・禁止事項だけ足す（再肥大化防止）。**
