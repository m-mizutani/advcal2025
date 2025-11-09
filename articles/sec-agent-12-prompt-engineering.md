---
title: "エージェントのプロンプトエンジニアリング"
emoji: "🗜️"
type: "tech"
topics: ["LLM"]
published: false
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の12日目です。今回はプロンプトエンジニアリングについて解説します。

一般的にプロンプトエンジニアリングとは、生成AIに与えるプロンプトを設計・調整・改善する一連の活動を指します。実際、すでにここまで開発をしてきたなかでもいくつかプロンプトエンジニアリングに該当するような調整をしてきています。今回はセキュリティ分析のエージェントを構築するに当たって、改めてどのような観点での調整をしうるのかについて解説します。

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

- 現状は最低限の指示
  - `You are a helpful assistant` でとりあえずアシストしろということは伝えている
  - `When asked about the alert, refer to the following data:\n\nAlert Data:\n" + string(alertData)` でアラートのデータに基づいて回答しろとしている
- アラートについて回答するというだけであればいいが、やるべきことを細かに指示する必要がある
- 実際の運用を考えるともう少し気の利いた処理が必要になる

# 改善しうるポイント

## 役割や目的の定義

- 今回はセキュリティ分析をするためのエージェントなので、その役割を明確化する
  - 単なるアシスタントではなく、セキュリティの専門家としての振る舞いを期待する
  - そうすることでセキュリティに関する知識などをちゃんと発揮するようになる
- 目的も明確化するのがよい
  - 結論を出すべきか、サポートをするべきかなど
  - 例えば専門家として分析せよ、みたいなことを強調するとリスク判定の結論を急ぐようになる
  - 少なくとも現状までの実装で与えたコンテキストからリスクの判定をするのはまったく無理
    - これはリスクを判定するために監視対象の環境の情報、どのようなポリシーで運用しているか、どういう構成や状況が本来あるべきか、などのコンテキスト情報がまったく入ってないから
    - またツールが足りず推論などだけで判断してしまう
- ただし、あまり強い役割や目的をつけるとそのためにしか動かなくなるので注意
  - 「セキュリティ分析の専門家」みたいにすると、挨拶をしただけでいきなり分析を始めたりする
  - あくまで役割は与えるが、ユーザからの指示をよく聞くようにといったプロンプトを挟んだりしておく必要がある
  - これは常設の生成AIエージェントならではの課題
    - 例えば単発でチャットをするだけだとあまり問題にならない
  - 指示に応じて行動を変えてほしいということを明確化しておく

## 背景情報の提示

- セキュリティ分析の場合、分析をするにあたって必要な背景情報を事前に与えておく
  - 環境について
    - クラウド環境で利用しているプラットフォーム
    - プラットフォーム上の構成、例えばアカウントやプロジェクトの分割方針
    - 権限などをどの様に付与しているか
    - 秘匿情報をどのように管理しているか
    - リソースをどの用に配置しているか
    - PC環境にどのような対策が講じられているか
  - システムについて
    - 組織内で利用しているシステム一覧
    - 誰にどのような権限が振られているか
  - ポリシーについて
    - どのような原則で運用されているか
    - 権限管理や承認状況など
- これは普遍的な情報ではないので、汎用的に使えるエージェント等の場合は外部から注入できるようにするのがよい
  - 今回の実装も一旦そっちによせる
  - これはtemplate機能などを使って埋め込む

## データの構造や発信元の理解

- 今回のようにアラートデータを渡す場合、各フィールドがどういう意味を持つか伝える
- 例えば重要な情報として、 `data` はオリジナルデータであるとか、 `title` は自動で付与されたものとか、そういう前提知識が必要となる
- おおよそ推定してくれるがちゃんとした解説があるとよい
  - とくに一般的な方針と異なるフィールドの使い方などがある場合はしっかり説明する必要がある
- またアラートのデータがどこから来たかなどの情報もあると有意

## 分析における指針やルールなどの定義

- 細かな指定をしなくてもツールなどは利用してくれるが、指示しておくとより意図した行動をしてくれる
  - 例えば「〜という情報が欲しい場合はこのツールを使え」「〜という方法でこのツールを使うとこういうことができる」「Xをする前にYという情報を取得してからやれ」など
  - 生成AIは基本的に推測で行動をしようとする
  - 推測がうまくハマるときもあるが全然来たいと違う行動をすることもある
    - 最近のモデルだと少なくなったが、それでも勝手に情報を補完して進行してしまうこともよくある
    - そのためちゃんとした情報を与えたり、取得できる場合はそれを先に当たれ、という指示を入れることが重要である
- また、分析に関しても何も指示しないと生成AI内で勝手に推論して結論を出すというようなことをし始める
  - したがって、「分析をする場合はちゃんとアラートから情報を読み取り、情報収集し、それを並べたうえで分析せよ」というような手順というか指針を明示することも必要である
- ツール実行についても都度確認するか、それとも最後まで走り切るかについて指示しておいた方が良い
  - これは利用者の好みによるが生成AIコーディングツールなどに慣れた人だと一発でやってくれたほうがよいというのがありそう
  - 逆に慎重に進めたいなら都度確認しろとしておいてもよい

## 出力に関するガイドライン

- 出力内容も定義できるものについては定義しておいた方が良い
- 例えば分析をした場合に、分析の過程のみ出力されても困る。ちゃんと結論や知見をだせみたいなことを指示しておく必要がある
- 場合によっては過程も必要ないので結論だけだせとか
- また結論に推論を混ぜるなという指示も入れておくとよい
  - 適当な辻褄合わせを始めたりする
  - ちゃんと事実に基づいた報告をしろって言う
- あと回答を特定言語（日本語）にしたい場合は指示しておくと良い

## その他のポイント

- プロンプトの改善も生成AIを活用すると良い

# 改善案と実装

## 実装の改善

- プロンプトは（すでにalertの要約やパラメータ抽出でもやったが） `text/template` を使うのがよい
  - `*.md` 形式で保存しておくとエディタのlinterやスタイルの恩恵を受けられる
  - テキストの埋め込みや分岐など、だいたいやりたいことはテンプレート制御で実現できる
  - Goの場合 `embed` を使うことで容易にデータの埋め込みができる
  - templateのコンパイルだけ `init()` でやっておくと、実際に利用するときにテンプレートのフォーマットが間違っていたというエラーを防ぐことができる

## プロンプトの改善

- 例として以下のような改善ができる
  - 全文は https://github.com/m-mizutani/leveret/blob/day12-prompt-engineering/pkg/usecase/chat/prompt/session.md をみよ

- 役割を明確かと基本的な方針を説明

```md
# Role and Purpose

You are a security analysis agent specialized in investigating and analyzing security alerts. Your role is to assist security analysts in understanding threats, gathering relevant information, and providing evidence-based insights.

**Important**: While you are a security expert, your primary purpose is to **support the analyst's investigation**, not to make final decisions. Always follow the analyst's instructions and questions carefully. Do not immediately jump to analysis unless explicitly asked.
```

- アラートとして与えるデータに関する説明

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

- 分析に関する方針を明確化

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

他詳細は適宜確認して

## 実行例

- 非常に長いのでトグル内に記載
- 動作が確率的なので単純な比較はできないが、簡易な指示でちゃんとした分析までしてくれる
  - プロンプト改善前に同様の「このアラートについてログ分析して」というと「分析とはなんでしょう？」「何をすればいいでしょう？」という回答が返ってきていた

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

🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo.principalEmail AS principalEmail,\n  protopayload_auditlog.requestMetadata.callerIp AS callerIp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage,\n  protopayload_auditlog.requestMetadata.callerSuppliedUserAgent AS userAgent\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`\nWHERE\n  timestamp BETWEEN '2025-11-08 05:15:00 UTC' AND '2025-11-08 05:30:00 UTC'\n  AND protopayload_auditlog.requestMetadata.callerIp = '185.220.101.42'\n  AND protopayload_auditlog.authenticationInfo.principalEmail = 'attacker@external-domain.com'\nORDER BY\n  timestamp ASC"
   }
⠇ searching...✅ Tool result:
{
  "job_id": "jN8CUMkiuAwUGsVbwlvqivSdRbG",
  "rows_returned": 0
}

⠧ searching...
💭 前のBigQueryクエリでは0件の結果が返されました。これは、指定された時間枠において、アラートに記載された `callerIp` (`185.220.101.42`) と `principalEmail` (`attacker@external-domain.com`) の両方に一致する管理アクティビティログが `cloudaudit_googleapis_com_activity` テーブル内に存在しないことを示しています。

考えられる理由はいくつかあります。
1. `principalEmail` または `callerIp` が、実際にログに記録された情報と完全に一致していない可能性があります。しかし、これらはアラートのデータから直接取得されたものです。
2. アラートの`eventTime`（2025-11-08T05:23:47.891Z）とログの実際のタイムスタンプにずれがある可能性があります。
3. `v1.compute.instances.start` メソッド名が、ログ内で異なる方法で記録されている可能性があります。

まず、タイムウィンドウをアラートの`eventTime`の前後1時間（2025-11-08 04:23:47 UTCから2025-11-08 06:23:47 UTC）に広げ、`callerIp`と`principalEmail`を条件に再度検索してみます。これにより、この期間に攻撃者が行った他のアクションが見つかる可能性があります。




🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo.principalEmail AS principalEmail,\n  protopayload_auditlog.requestMetadata.callerIp AS callerIp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage,\n  protopayload_auditlog.requestMetadata.callerSuppliedUserAgent AS userAgent\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`\nWHERE\n  timestamp BETWEEN '2025-11-08 04:23:47 UTC' AND '2025-11-08 06:23:47 UTC'\n  AND protopayload_auditlog.requestMetadata.callerIp = '185.220.101.42'\n  AND protopayload_auditlog.authenticationInfo.principalEmail = 'attacker@external-domain.com'\nORDER BY\n  timestamp ASC"
   }
⠏ searching...✅ Tool result:
{
  "job_id": "nem564hWNWVXXZiZGUzJTN4foDH",
  "rows_returned": 0
}

⠼ searching...
💭 タイムウィンドウを広げたBigQueryクエリでも結果が得られませんでした。これは、アラートで指定された `callerIp` ('185.220.101.42') と `principalEmail` ('attacker@external-domain.com') の組み合わせが、`cloudaudit_googleapis_com_activity` テーブル内に存在しないか、少なくともログ内での関連付けが異なる可能性を示唆しています。

しかし、アラートデータは明確に以下の情報を示しています。
- `finding.access.callerIp`: "185.220.101.42"
- `finding.access.principalEmail`: "attacker@external-domain.com"
- `finding.access.methodName`: "v1.compute.instances.start"

ログへの記録方法が異なるか、あるいは初回のアクセスイベント自体が、現在クエリしているような「アクティビティ」として直接記録されていない可能性も考えられます。アラートの`principalEmail`が「attacker@external-domain.com」という外部のIDであり、これが侵害されたプリンシパルである場合、ログに表示されるはずです。

戦略を変更します。`principalEmail`と`callerIp`の組み合わせで直接検索しても結果が得られなかったため、代わりに、初期のアクセス方法である `v1.compute.instances.start` と、影響を受けたインスタンス (`web-server-prod-01`) に関連するすべてのアクティビティを、広範な時間枠で検索してみます。これにより、別のプリンシパルまたは異なる方法でインスタンスが開始または変更されたかどうかを特定できるかもしれません。

以下のクエリで`resourceName`に`web-server-prod-01`が含まれ、`methodName`が`v1.compute.instances.start`であるログを検索します。




🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo.principalEmail AS principalEmail,\n  protopayload_auditlog.requestMetadata.callerIp AS callerIp,\n  protopayload_auditlog.methodName AS methodName,\n  protopayload_auditlog.serviceName AS serviceName,\n  protopayload_auditlog.resourceName AS resourceName,\n  protopayload_auditlog.status.message AS statusMessage,\n  protopayload_auditlog.requestMetadata.callerSuppliedUserAgent AS userAgent\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`\nWHERE\n  timestamp BETWEEN '2025-11-08 04:23:47 UTC' AND '2025-11-08 06:23:47 UTC'\n  AND protopayload_auditlog.methodName = 'v1.compute.instances.start'\n  AND protopayload_auditlog.resourceName LIKE '%web-server-prod-01%'\nORDER BY\n  timestamp ASC"
   }
⠸ searching...✅ Tool result:
{
  "job_id": "vzRqj6d3VH69fuG8OnqoAFW2Yeh",
  "rows_returned": 0
}

⠧ searching...
💭 3回目のBigQueryクエリ（拡張された時間枠内で`web-server-prod-01`に対する`v1.compute.instances.start`メソッドの検索）も0件の結果を返しました。

これは、アラートの説明が初回のアクセスに`v1.compute.instances.start`が関与していると強く示唆していることを考えると、予想外です。考えられる理由は以下の通りです。
1. 特定のインスタンスに対する`v1.compute.instances.start`イベントが、その時点の`cloudaudit_googleapis_com_activity`に記録されなかった（異常なアクセス方法やログ設定によるものかもしれません）。
2. 初回のアクセスは、インスタンスの起動につながる別のメソッドを伴っていた。アラートの`methodName`は、検出システムによる推論であり、直接のログエントリではない可能性があります。
3. 監査ログテーブルのデータに問題があるか、この特定のシナリオにおける監査ログとアラートデータのマッピングに関する私の理解が間違っている可能性があります。

再考します。もし`v1.compute.instances.start`が表示されない場合、初期アクセス周辺で他に何が起こりうるでしょうか？アラートでは次のことも言及されています。
- `compromised_principal_email`: attacker@external-domain.com
- `initial_access_cve`: CVE-2023-32784（脆弱性悪用）

インスタンスの「起動」が直接のAPI呼び出しではなく、別の行動の結果であったか、またはこの特定のインシデントのログが別の場所にある可能性があります。

`cloudaudit_googleapis_com_activity`テーブルに対して非常に広範な検索を試みます。拡張された時間枠内で、`attacker@external-domain.com` または `185.220.101.42` または `web-server-prod-01` に関連する**任意の**監査ログエントリを検索します。これにより、過度に具体的なフィルタリングによって何かを見逃すことがないようにします。

以下のクエリを実行します。




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

現時点までに、攻撃者のIP、メール、および影響を受けたインスタンスに関して、アラートのイベント時刻前後に`cloudaudit_googleapis_com_activity`と`cloudaudit_googleapis_com_system_event`の両方の監査ログを徹底的に検索しましたが、すべてのクエリで0件の結果が返されました。

これは監査ログからの情報が決定的に不足していることを示しています。これは強く次の可能性を示唆しています。
1.  **監査ログ（特にアクティビティログとシステムイベントログ）には、アラートに記載されている初期の侵害/インスタンス起動イベントが含まれていない。** これは以下の原因が考えられます。
    *   検出システムが`finding.access`データを生成する方法が、単一の監査ログエントリから直接ではない。
    *   巧妙な攻撃が、この初期段階で標準的な監査ログ記録メカニズムを回避した。
    *   この特定のプロジェクト/リソースのログ設定が不足している。
2.  **`attacker@external-domain.com`のメールアドレスと`185.220.101.42`のIPアドレスは、`初回アクセス`自体のログエントリと直接関連付けられていない。** アラートはこれらを「侵害されたプリンシパル」および「発生元」と記述しており、これはAPI呼び出しの直接的な監査ログエントリではなく、他のシグナルから導出された可能性があります。例えば、侵害されたプリンシパルがすでにインスタンス内に存在し、外部からの直接的な`v1.compute.instances.start`なしでインスタンスが再起動された、または新しいソフトウ
ェアがインストールされた可能性があります。

利用可能な情報とBigQuery監査ログの結果がないことから、調査結果を要約し、情報不足の点を強調する必要があります。

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