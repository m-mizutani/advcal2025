---
title: "Goで作るセキュリティ分析LLMエージェント(12): エージェントのプロンプトエンジニアリング"
emoji: "🗜️"
type: "tech"
topics: ["ai", "llm", "prompt"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の12日目です。今回はプロンプトエンジニアリングについて解説します。

一般的にプロンプトエンジニアリングとは、LLMに与えるプロンプトを設計・調整・改善する一連の活動を指します。実際、すでにここまで開発をしてきたなかでもいくつかプロンプトエンジニアリングに該当するような調整をしてきています。今回はセキュリティ分析のエージェントを構築するに当たって、改めてどのような観点での調整をしうるのかについて解説します。

今回のコードは https://github.com/m-mizutani/leveret の [day12-prompt-engineering](https://github.com/m-mizutani/leveret/tree/day12-prompt-engineering) ブランチに格納されていますので適宜参照してください。

# 現在のプロンプト

ここまでの実装で利用してきた、エージェントに与える基本のプロンプトが以下になります。

```go:pkg/usecase/chat/session.go
systemPrompt := "You are a helpful assistant. When asked about the alert, refer to the following data:\n\nAlert Data:\n" + string(alertData)

// Add tool-specific prompts
if s.registry != nil {
    if toolPrompts := s.registry.Prompts(ctx); toolPrompts != "" {
        systemPrompt += "\n\n" + toolPrompts
    }
}
```

現状では最低限の指示のみをエージェントに与えています。`You are a helpful assistant` という一般的な役割を与え、`When asked about the alert, refer to the following data` でアラートデータを参照して回答するよう指示しているだけです。

この程度のシンプルなプロンプトでもアラートについての質問に答えるという基本動作は実現できます。しかし実際の運用を考えると、エージェントに期待する動作や制約をもっと明確に指示する必要があります。たとえば、どのような観点で分析すべきか、どのツールをどう使うべきか、どのような形式で結果を返すべきかといった詳細な指針がないと、エージェントは期待通りに動作してくれません。

# 改善しうるポイント

プロンプトエンジニアリングは、生成AIの性能を最大限に引き出すために、プロンプトを体系的に設計・調整する技術です[^prompt-guide]。以下では、セキュリティ分析エージェントのプロンプトを改善するための具体的な観点を解説します。

## 役割や目的の定義

今回構築しているのはセキュリティ分析をするためのエージェントなので、その役割を明確に定義します。単なる「アシスタント」ではなく「セキュリティの専門家」としての振る舞いを期待することで、生成AIはセキュリティに関する専門知識を適切に発揮するようになります。

ただし、役割とともに目的も慎重に定義する必要があります。たとえば「専門家として分析せよ」というように結論を出すことを強調すると、エージェントはリスク判定の結論を急ぐようになります。しかし現状の実装で与えているコンテキストからは、適切なリスク判定は不可能です。リスクを判定するには、監視対象の環境情報、運用ポリシー、本来あるべき構成や状況といったコンテキスト情報が必要ですが、これらはまだ与えていません。また必要なツールも不足しており、推論だけで判断してしまう危険があります。たとえば、不審なIPアドレスからのアクセスを発見しただけで、組織の運用ポリシーや許可されたアクセス経路を考慮せずに「攻撃である」と断定してしまうといった誤判断が起こりえます。

さらに、あまり強い役割や目的を与えすぎると、エージェントがその役割のためにしか動かなくなる点にも注意が必要です。たとえば「セキュリティ分析の専門家」という役割を強調しすぎると、ユーザが挨拶をしただけでいきなり分析を始めてしまうといった不自然な動作になります。

これは常設のLLMエージェントならではの課題です。単発のチャットであればあまり問題になりませんが、継続的に利用されるエージェントでは、あくまで役割は与えつつも「ユーザからの指示をよく聞く」といったプロンプトを追加しておく必要があります。ユーザの指示に応じて適切に行動を変えてほしいということを明確化しておくことが重要です。

## 背景情報の提示

セキュリティ分析を実施するには、分析対象の環境やシステムに関する背景情報が必要です。これらの情報を事前にプロンプトで与えておくことで、エージェントはより適切な判断ができるようになります。

具体的には以下のような情報が考えられます。

**環境について**:
- 利用しているクラウドプラットフォーム（AWS、GCP、Azureなど）
- アカウントやプロジェクトの分割方針
- 権限の付与方針
- 秘匿情報の管理方法
- リソースの配置方針
- PC環境に講じられているセキュリティ対策

**システムについて**:
- 組織内で利用しているシステムの一覧
- 各システムの権限設定や担当者

**ポリシーについて**:
- 運用の基本原則
- 権限管理や承認プロセス

これらの情報は組織ごとに異なります。そのため、汎用的に使えるエージェントを構築する場合は、外部から注入できるようにするのが適切です。今回の実装でも、この方針に沿ってtemplate機能を使って背景情報を埋め込めるようにします。具体的には、`NewInput` 構造体に `EnvironmentInfo` フィールドを設け、エージェント初期化時に環境情報を引数として受け取り、プロンプトテンプレートに埋め込む実装としています。

## データの構造や発信元の理解

アラートデータをエージェントに渡す場合、各フィールドがどのような意味を持つかを明確に伝える必要があります。生成AIはある程度フィールド名から意味を推定してくれますが、正確な解説があるとより適切な分析が可能になります。

今回のケースで言えば、以下のような重要な前提知識を伝えておく必要があります。

- `data` フィールドは検出元からのオリジナルデータであり、最も信頼できる一次情報源である
- `title` や `description` は自動生成されたものであり、すべての詳細を含んでいない可能性がある
- `attributes` には事前抽出されたIoCや重要な情報が含まれている

特に、一般的な方針と異なるフィールドの使い方をしている場合は、その点をしっかり説明することが重要です。またアラートのデータがどこから来たか（どの検出システムから発行されたか）といった発信元の情報も分析に役立ちます。

## 分析における指針やルールなどの定義

エージェントは細かな指定をしなくてもツールを利用してくれますが、明確な指針を与えておくことでより意図した行動をしてくれるようになります。生成AIは基本的に推測で行動しようとします。推測がうまくハマるときもありますが、期待と全く違う行動をすることもあります。最近のモデルでは少なくなりましたが、それでも勝手に情報を補完して進行してしまうことがあるため、以下のような指針を明示することが重要です。

**ツールの使い方**: 「〜という情報が欲しい場合はこのツールを使え」「Xをする前にYという情報を取得してからやれ」といった具体的な指示により、エージェントの行動をより確実なものにできます。たとえば、前回実装したBigQueryツールでは、クエリを実行する前にスキーマ情報を取得するといった段階的なアプローチを明示しておきます。

**分析手順**: 何も指示しないと生成AI内で勝手に推論して結論を出してしまうため、「分析をする場合はアラートから情報を読み取り、情報収集し、それを並べたうえで分析せよ」というような手順や指針を明示する必要があります。

**ツール実行の自律性**: 都度確認するか、最後まで自動で走り切るかは利用者の好みによりますが、今回の実装では自律的に実行を続ける方針を採用しています。これにより、「このアラートについてログ分析して」という簡潔な指示だけで、エージェントが必要な調査を自律的に完遂できるようになります。

## 出力に関するガイドライン

出力内容についても、定義できるものは明確に定義しておくことが重要です。

分析を実施した場合、分析の過程のみが出力されても困ります。結論や知見を出すよう指示しておく必要があります。逆に、用途によっては過程は不要で結論だけを出力するよう指示することもできます。また、結論に推論を混ぜないという指示も入れておくとよいでしょう。生成AIは辻褄を合わせるために適当な推測を混ぜてしまうことがあるため、事実に基づいた報告をするよう明示することでこの問題を軽減できます。

今回の実装では、Findings（調査結果）、Assessment（評価）、Knowledge Gaps（情報不足）、Recommended Actions（推奨アクション）、Conclusion（結論）というセクションに分けて出力するよう指示しています。これにより、観測された事実と分析者の解釈を明確に分離し、不足している情報も明示できるようになります。回答を特定の言語（日本語など）で出力したい場合は、その旨を明示的に指示しておくとよいでしょう。プロンプト自体は英語で書いても、出力言語は別途指定できます。

## その他の考慮事項

プロンプトエンジニアリングにおいて、その他にも知っておくべきポイントがいくつかあります。

**LLMによるプロンプト改善**: プロンプト自体の改善にも生成AIを活用できます。意図を伝えると適切な表現で記載してくれることが多いです。ただし、たまに意図と異なる実装になったり、過剰に強調表現（**IMPORTANT**や**CRITICAL**など）をつけたりすることがあります。強調表現が多すぎるとそれぞれの重要性が薄れてしまうため、生成されたプロンプトは適度に調整する必要があります。

**プロンプトの言語選択**: プロンプトはなるべく英語にするのが望ましいとされています。生成AIは英語での学習が中心のため、性能が安定すると考えられているためです[^english-performance]。特にChain-of-Thought（CoT）などの高度なプロンプト技法は、英語での方が効果が高い傾向があります。ただし最近のモデル（GPT-4、Gemini、Claude）は日本語でも十分な性能を発揮します。実用上は、システムプロンプト（役割定義、ルール、ガイドライン）は英語推奨、出力言語は明示的に指定、ユーザーとのやり取りはユーザーの言語に合わせる、といった使い分けが考えられます。今回の実装では、システムプロンプトは英語で記述し、出力言語として日本語を明示的に指定しています。

**情報配置の最適化**: 情報の配置位置によって生成AIの認識精度が変わることが知られています。重要な情報はプロンプトの最初か最後に配置するのが効果的です。中間部分の情報は見落とされやすい傾向があり、これは「Lost in the Middle」と呼ばれる現象で、前回のBigQueryツールの実装でも触れましたが、長いコンテキストを扱う場合は特に注意が必要です[^lost-in-middle]。今回のように複数のツールの説明や背景情報を含む場合、最も重要な情報を冒頭や末尾に配置し、補足的な情報を中間に配置するといった工夫が考えられます。

# 改善案と実装

## 実装の改善

プロンプトの管理には `text/template` を使うのがよいでしょう。すでにアラートの要約やパラメータ抽出でも使っていますが、ここでも同じアプローチを採用します。複雑なプロンプトを文字列連結で管理すると可読性が低下し、変更も困難になります。そこで `text/template` を使います。利点は以下の通りです。

- `*.md` 形式で保存しておくとエディタのlinterやスタイルチェックの恩恵を受けられる
- テキストの埋め込みや条件分岐など、テンプレート制御でやりたいことがだいたい実現できる
- Goの `embed` パッケージを使うことで、バイナリへのデータ埋め込みが容易
- テンプレートのコンパイルを起動時（グローバル変数の初期化時）に実行しておくことで、実行時のテンプレートフォーマットエラーを防げる

具体的な実装例を以下に示します。

```go:pkg/usecase/chat/session.go
//go:embed prompt/session.md
var sessionPromptRaw string

var sessionPromptTmpl = template.Must(template.New("session").Parse(sessionPromptRaw))
```

この実装により、プロンプトテンプレートをMarkdown形式で管理し、実行時に動的にデータを埋め込むことができます。`template.Must` を使うことで、テンプレート構文エラーがあれば起動時にパニックするため、デプロイ前に問題を検出できます。

## プロンプトの改善

ここまで説明してきた改善ポイントを実際のプロンプトに適用した例を紹介します。全文は https://github.com/m-mizutani/leveret/blob/day12-prompt-engineering/pkg/usecase/chat/prompt/session.md を参照してください。

### 役割と目的の明確化

```md
# Role and Purpose

You are a security analysis agent specialized in investigating and analyzing security alerts. Your role is to assist security analysts in understanding threats, gathering relevant information, and providing evidence-based insights.

**Important**: While you are a security expert, your primary purpose is to **support the analyst's investigation**, not to make final decisions. Always follow the analyst's instructions and questions carefully. Do not immediately jump to analysis unless explicitly asked.
```

このセクションでは、エージェントがセキュリティ分析の専門家であることを明示しつつ、最終的な判断はアナリストに委ねることを強調しています。これにより、不十分な情報で結論を急ぐことを防ぎます。

### データ構造の説明

```md
## Alert Data Structure

You have access to an alert with the following structure:

- **ID**: Unique identifier for this alert ({{.AlertID}})
- **Title**: Auto-generated summary title
- **Description**: Auto-generated description of the alert
- **Attributes**: Key security indicators extracted from the alert (IOCs and contextual information)
- **Data**: Original raw alert data from the detection source

**Critical understanding**:
- The `title` and `description` fields are automatically generated summaries - they may not capture all nuances
- The `attributes` contain pre-extracted IOCs (IPs, domains, hashes, URLs) and key contextual information
- The `data` field contains the **authoritative source** - always refer to this for detailed investigation
```

アラートデータの構造と各フィールドの意味を明確に説明しています。特に `data` フィールドが権威的なソースであることを強調することで、自動生成された要約だけに頼らず、オリジナルデータを参照するよう促しています。

### 分析方針の定義

```md
## Investigation Methodology

When conducting security analysis, follow these principles:

1. **Gather before concluding**: Always collect relevant information before making assessments
   - Use available tools to fetch additional context (threat intelligence, logs, schema information)
   - Cross-reference multiple data sources
   - Verify assumptions with actual data

2. **Evidence-based analysis**: Base your analysis on facts, not speculation
   - Clearly distinguish between observed facts and inferences
   - When making inferences, explicitly state your reasoning
   - Acknowledge when information is missing or uncertain

3. **Structured investigation flow**:
   - Start by understanding what happened (the facts)
   - Gather additional context using available tools
   - Identify what is known vs. unknown
   - Present findings clearly before drawing conclusions
```

このプロンプトでは、情報収集してから結論を出すこと、事実に基づいた分析をすること、体系的な調査フローに従うことといった原則を明示しています。これにより、エージェントは推測だけで結論を急ぐのではなく、利用可能なツールを使って情報を収集し、証拠に基づいた分析を実施するようになります。

その他にも、ツールの使用方法に関するガイドライン（具体的なツール名と使用タイミング）、自律的な調査の継続に関する指示（IMPORTANT: When instructed to investigate...の部分）、制約事項の明示（Limitations and Constraintsセクション）、出力形式の定義（Output Guidelinesセクション）などが含まれています。詳細はリポジトリ内のプロンプトファイルを参照してください。

## 実行例

改善したプロンプトを使った実行例[^result]を示します。実行ログは非常に長いため、以下のトグル内に記載します。
[^result]: ちなみにこのアラートはテスト用のダミーなので、BigQueryを検索して何も関連するログが見つからなかった、というエージェントの調査結果は正解です。

生成AIの動作は確率的なので単純な比較はできませんが、プロンプト改善後は「このアラートについてログ分析して」という簡潔な指示だけで、エージェントが自律的に以下の処理を実行しています。これらの処理は、プロンプトで明示した「情報収集してから結論を出す」「ツールを使う前に必要な情報を取得する」といった指針に従った結果です。

1. BigQueryのスキーマ確認
2. アラート情報から関連するIPアドレスやプリンシパル、時刻を抽出
3. 複数のクエリパターンを試行（時間範囲の拡大、検索条件の変更など）
4. 結果が見つからない場合の理由を考察
5. 別のログテーブルの確認
6. 最終的な調査結果と推奨アクションの提示

プロンプト改善前に同様の指示をした場合は「分析とはなんでしょう？」「何をすればいいでしょう？」といった質問が返ってきていました。改善後はこのような明確な指針により、エージェントが期待される動作を自律的に実行できるようになっています。

:::details プロンプト修正後の実行例
go run . chat -i 81aa9921-3dea-4365-ac18-5967596933ac                                                                                             1.9m  Sun Nov  9 12:53:20 2025
Enabled tools: [search_alerts query_otx bigquery_query bigquery_get_result bigquery_schema bigquery_runbook]

Chat session started. Type 'exit' to quit.

> このアラートについてログ分析して

⠸ searching...
💭 このアラートに関するログ分析に着手します。
まず、管理アクティビティログ（`mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`）のスキーマを確認し、その後、攻撃者のIPアドレス、プリンシパル、およびアラートのイベント時刻周辺の関連アクティビティを検索します。

🔧 Calling tool: bigquery_schema
   Args:
{
     "dataset_id": "google_cloud_audit",
     "project": "mztn-audit",
     "table": "cloudaudit_googleapis_com_activity"
   }
⠇ searching...✅ Tool result:
{
  "dataset_id": "google_cloud_audit",
  "field_count": 18,
  "full_table": "mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity",
  "num_bytes": 231681022,
  "num_rows": 151269,
  "proj...

⠴ searching...
💭 スキーマを確認しました。これを受けて、`attacker@external-domain.com` (`attacker_ip_address`: `185.220.101.42`) がアラートのイベント時刻（2025-11-08T05:23:47.891Z）の約15分前から15分後までの間に実行した管理アクティビティを検索するBigQueryクエリを作成します。特に、インスタンスの起動に関連する `v1.compute.instances.start` メソッドに注目します。

このクエリにより、攻撃者の活動に関する詳細なログエントリを取得します。

（中略：複数のBigQueryクエリを試行し、時間範囲を拡大したり、検索条件を変更したりしながら、関連するログエントリを探索）




🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo.principalEmail AS principalEmail,\n  protopayload_auditlog.requestMetadata.callerIp AS callerIp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage,\n  protopayload_auditlog.requestMetadata.callerSuppliedUserAgent AS userAgent\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`\nWHERE\n  timestamp BETWEEN '2025-11-08 04:23:47 UTC' AND '2025-11-08 06:23:47 UTC'\n  AND (\n    protopayload_auditlog.authenticationInfo.principalEmail = 'attacker@external-domain.com'\n    OR protopayload_auditlog.requestMetadata.callerIp = '185.220.101.42'\n    OR protopayload_auditlog.resourceName LIKE '%web-server-prod-01%'\n  )\nORDER BY\n  timestamp ASC"
   }
⠧ searching...✅ Tool result:
{
  "job_id": "dsdXS3U9jdzudjn4km6cOqbj5YZ",
  "rows_returned": 0
}

⠇ searching...
💭 拡張された時間枠内で、攻撃者のメール、IP、または影響を受けたインスタンス名に関連するアクティビティを`cloudaudit_googleapis_com_activity`で検索した4回目のBigQueryクエリも0件の結果を返しました。

これは重要な発見です。アラートに記載されている「初回アクセス」イベント、特にアラートの`finding.access`セクションからの`v1.compute.instances.start`メソッド、および関連する`callerIp`と`principalEmail`が、**`cloudaudit_googleapis_com_activity`テーブルに存在しない**ことを示しています。

これにより、いくつかの可能性が示唆されます。
1.  **ログ記録のギャップ/設定の問題**: 関連するプロジェクトまたは特定のイベントタイプに対して、`cloudaudit_googleapis_com_activity`のログ記録にギャップがある可能性があります。
2.  **異なるログソース**: 初回アクセスイベント、または`finding.access`で取得された部分は、`cloudaudit_googleapis_com_activity`ではない別のログソースから来ている可能性があります。アラートの`data`フィールドは「検出元からのオリジナルの生のアラートデータ」であり、`finding.access`情報はアラートのコンテキスト内では信頼できるものです。
3.  **ログ記録の侵害**: 可能性は低いですが、ログ記録自体が侵害または改ざんされた可能性があります。
4.  **エクスプロイトの性質**: `CVE-2023-32784`が悪用された場合、それは`attacker@external-domain.com`プリンシパルによる`v1.compute.instances.start`の監査ログエントリを、期待される形式で生成せずに初回アクセスを可能にした可能性があります。たとえば、コード実行につながるエクスプロイトによってマイナーが起動された場合、`v1.compute.instances.start`は内部システムのアクションであったり、検出による推測であったりする可能性があり、プリンシパルによる直接のAPI呼び出しではないかもしれません。

`cloudaudit_googleapis_com_activity`で結果が得られなかったため、他のログタイプを検討します。アラートには「不正なアクセス試行とAPI呼び出しについてCloud Audit Logsを確認する」とも記載されています。私たちは「アクティビティ」ログを確認しました。他の監査ログタイプには`cloudaudit_googleapis_com_data_access`と`cloudaudit_googleapis_com_system_event`があります。

`cloudaudit_googleapis_com_data_access`はデータの読み書き操作用であり、インスタンス起動の初回アクセスが含まれる可能性は低いです。
`cloudaudit_googleapis_com_system_event`はGCPが開始する操作用です。エクスプロイト後に基盤となるシステムによってトリガーされた場合、インスタンスの「起動」がここに表示される可能性があります。

しかし、アラートが`principalEmail`、`callerIp`、`methodName`、`userAgent`を含む`finding.access`の詳細を明示的に提供していることから、これは管理タイプのアクションを強く示唆しています。これが`cloudaudit_googleapis_com_activity`にないことは重要です。

`cloudaudit_googleapis_com_system_event`のスキーマを確認し、その後、イベント時間周辺で`web-server-prod-01`インスタンスに関連するログを検索してみます。




🔧 Calling tool: bigquery_schema
   Args:
{
     "dataset_id": "google_cloud_audit",
     "project": "mztn-audit",
     "table": "cloudaudit_googleapis_com_system_event"
   }
⠏ searching...✅ Tool result:
{
  "dataset_id": "google_cloud_audit",
  "field_count": 17,
  "full_table": "mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_system_event",
  "num_bytes": 1064762,
  "num_rows": 293,
  "proje...

⠏ searching...
💭 `cloudaudit_googleapis_com_system_event`のスキーマを取得しました。これには`protopayload_auditlog.methodName`、`protopayload_auditlog.serviceName`、`protopayload_auditlog.resourceName`といった関連フィールドが含まれています。また、非標準フィールドを見つけるのに役立つ`jsonPayload`もあります。

次に、広範な時間枠内で`web-server-prod-01`インスタンスに関連するログを探すため、`cloudaudit_googleapis_com_system_event`に対するクエリを実行します。




🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage,\n  jsonPayload AS jsonPayload\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_system_event`\nWHERE\n  timestamp BETWEEN '2025-11-08 04:23:47 UTC' AND '2025-11-08 06:23:47 UTC'\n  AND protopayload_auditlog.resourceName LIKE '%web-server-prod-01%'\nORDER BY\n  timestamp ASC"
   }
⠹ searching...⚠️  Tool returned error:
Query validation failed: failed to run dry-run query: googleapi: Error 400: Unrecognized name: jsonPayload; Did you mean textPayload? at [7:3], invalidQuery

⠸ searching...
💭 前回のBigQueryクエリは「Unrecognized name: jsonPayload; Did you mean textPayload?」というエラーで失敗しました。これは、`jsonPayload`が`cloudaudit_googleapis_com_system_event`の直接のフィールドではないことを示しています。私は一般的なログ構造に基づいて仮定をしてしまいました。スキーマは`textPayload`と`protopayload_auditlog`をトップレベルのペイロードフィールドとして示しており、`protopayload_auditlog`は既に利用しています。

`jsonPayload`を削除し、クエリを再試行します。`methodName`や`resourceName`などの重要なフィールドは`protopayload_auditlog`から正しく抽出されています。




🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_system_event`\nWHERE\n  timestamp BETWEEN '2025-11-08 04:23:47 UTC' AND '2025-11-08 06:23:47 UTC'\n  AND protopayload_auditlog.resourceName LIKE '%web-server-prod-01%'\nORDER BY\n  timestamp ASC"
   }
⠹ searching...✅ Tool result:
{
  "job_id": "hpLRnBT3OLVkJUNEJsnoiKdSasT",
  "rows_returned": 0
}

`cloudaudit_googleapis_com_system_event`に対するクエリも0件の結果を返しました。これは、指定された期間に`web-server-prod-01`に関連するシステムイベントが存在しないことを意味します。

（中略：さらに他のログテーブルの確認や、検索条件の再検討を実施）

最終的に、すべてのクエリで0件の結果が返されました。これは監査ログからの情報が決定的に不足していることを示しています。

### 調査結果
- `cloudaudit_googleapis_com_activity`および`cloudaudit_googleapis_com_system_event`に対して、攻撃者のIPアドレス（185.220.101.42）、侵害されたプリンシパルメールアドレス（attacker@external-domain.com）、関連メソッド（`v1.compute.instances.start`）、および影響を受けたインスタンス（web-server-prod-01）の組み合わせで、アラートのイベント時刻（2025-11-08T05:23:47.891Z）の前後1時間の広範な時間枠でログを検索しましたが、関連するエントリは一切見つかりませんでした。

### 評価
アラートの`data.finding.access`セクションで明確に示されているにもかかわらず、Google Cloudの管理アクティビティログおよびシステムイベントログに、初期のインスタンス起動イベント、またはそれに直接関連する攻撃者の活動に関するログエントリが見つからないことは、非常に重要な点です。これは、この侵害の初期段階が通常の監査ログ記録メカニズムによって捕捉されていないか、捕捉された情報が現在調査しているログソースとは異なることを強く示唆しています。

### 情報不足
- `attacker@external-domain.com`および`185.220.101.42`による`v1.compute.instances.start`の直接的な監査ログエントリが存在しない理由。
- 検出システムが`finding.access`の情報をどのように導出したかの詳細。
- 脆弱性`CVE-2023-32784`の悪用が、具体的にどのようにログを回避したり、異なるログタイプに記録されたりしたか。

### 推奨されるアクション
1.  **他のログソースの確認**:
    *   Google Cloud Loggingの他のログ（例: VPC Flow Logs、Kubernetes Engine Audit Logs、Compute Engine Serial Console Outputなど）に、この期間の関連アクティビティがないかを確認します。
    *   GCP以外のシステムログやアプリケーションログ（web-server-prod-01で実行されている可能性のあるサービスに関連するもの）も調査します。
2.  **検出システムの調査**:
    *   アラートを生成した検出システムが、`finding.access`の情報をどのようなソースから取得したか、そのロジックを理解するための深掘り調査が必要です。
3.  **インスタンススナップショットのフォレンジック分析**:
    *   影響を受けたインスタンス（`web-server-prod-01`）のフォレンジック分析を実施し、ファイルシステム、メモリ、ネットワーク接続などから、初回アクセス方法やマルウェアの展開プロセスに関する証拠を収集します。
4.  **関連する他のアラートの検索**:
    *   同じIPアドレス（185.220.101.42）や同じメールアドレス（attacker@external-domain.com）に関連する他のセキュリティアラートが、この期間または過去に存在しないかを確認します。

### 結論
この調査では、提供されたアラート情報に基づいてGoogle Cloudの主要な監査ログ（アクティビティログおよびシステムイベントログ）を分析しましたが、アラートで示唆されている初回アクセスイベントに関する直接的なログエントリを見つけることはできませんでした。この情報の欠如は、攻撃が通常のログ記録メカニズムを回避した可能性、または検出情報が異なるログソースから派生した可能性を示唆しています。このギャップを埋めるためには、他のログソースの調査、検出システムの詳細分析、およびインスタンスのフォレンジック分析が不可欠です。
:::

# まとめ

本記事では、セキュリティ分析エージェントのプロンプトエンジニアリングについて解説しました。プロンプトはLLMエージェントの「行動規範」であり、その設計次第でエージェントの性能は大きく変わります。

特に重要なのは、エージェントに何を期待するかを明確に定義することです。役割と目的のバランスが重要で、専門性を持たせつつも推測だけで結論を急がないよう制約を設ける必要があります。ツールの使い方や分析手順を具体的に指示することで、エージェントは「情報を集めてから判断する」という適切な行動パターンを学習します。事実と推論を分離した出力形式を定義することも、セキュリティ分析においては特に重要です。これらはすべて、エージェントの思考プロセスそのものを設計することに他なりません。

プロンプトエンジニアリングは一度で完成するものではありません。実際の運用で得られたフィードバックをもとに、継続的に改善していくことが重要です。エージェントが期待通りに動かなかった場合、それはプロンプトの改善点を示すシグナルでもあります。どのような指示が不足していたのか、どのような制約を追加すべきかを観察し、プロンプトに反映していくことで、エージェントはより信頼できるものになっていきます。

[^prompt-guide]: Prompt Engineering Guide: https://www.promptingguide.ai/
[^english-performance]: 英語での学習が中心のLLMでは、Zero-shot CoTなどの技法を日本語テキスト処理に適用する際も、"step by step"のような英語フレーズをそのまま使う方が良い結果が得られることが報告されています。ただし最近のモデルは多言語性能が向上しているため、この差は徐々に縮小しています。
[^lost-in-middle]: Liu, N. F., Lin, K., Hewitt, J., Paranjape, A., Bevilacqua, M., Petroni, F., & Liang, P. (2023). Lost in the Middle: How Language Models Use Long Contexts. arXiv:2307.03172. https://arxiv.org/abs/2307.03172