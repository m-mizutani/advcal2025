---
title: "より実践的なツールの実装：BigQueryからのログ取得"
emoji: "🗄️"
type: "tech"
topics: ["Go", "LLM", "Database", "SQL", "Agent"]
published: true
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の11日目です。ここまではシンプルなAPI問い合わせのツールや外部と接続できるMCP（Model Context Protocol）について解説してきましたが、今回はより実践的かつ複雑なツールの実装をしてみます。題材として、Google CloudのBigQueryからログを検索するツールをとりあげます。

今回のコードは https://github.com/m-mizutani/leveret の [day11-db-query-tool](https://github.com/m-mizutani/leveret/tree/day11-db-query-tool) ブランチに格納されていますので適宜参照してください。

# セキュリティ監視におけるBigQueryの利用

セキュリティ監視においてログの検索・集計機能は中核的な役割を果たします。ログを活用する場面は大きく3つに分けられます。まず検知では、ログを集計して特定の事象や不審な事象を見つけ出します。次に調査では、何らかのインシデントが発生した際にアプリケーションやサービスのログを調査することで、事実の検証、原因の究明、影響範囲の確認などを実施します。さらに脅威ハンティングのように、能動的に異常を探索する活動にもログは欠かせません。

ログの保存先としては様々な選択肢がありますが、BigQueryは現実的な最適解の一つといえます。SIEM（Security Information Event Manager）などの専用ソリューションにログを保管することもできますが、コストが高額になりがちです。一方でBigQueryは、運用を自ら行う必要がある代わりに、ログの投入コストと維持コストを抑えられます。特にクエリ実行量に応じた課金が中心となるため、ログを大量に保存しながらもコストを管理しやすい点が運用上の利点となります。

今回はセキュリティ監視のためのログがBigQuery内に保存されているという前提で、機能の解説をします。

# ツール設計において重要なポイント

まず、実践的かつ複雑なツールを作るうえでのポイントについてまとめます。

## 「知らないモノは探さない」

生成AIを活用したツール設計では、ツールが情報を取得できることと、生成AIがその情報の存在を認識することは別の問題です。ツールによって取得可能な情報があったとしても、生成AI側が何が取得できるのかを知らなければ、そもそも探索行動を開始しません。

さらに「探せばわかる」状況であっても、生成AIが探索アクションを取らない可能性があります。これは特に行動回数を短縮させようとする場合に顕著です。コストや応答速度の観点から行動回数の削減を図ることは一般的ですが、その結果として必要な情報収集が行われないことがあります。したがって、生成AIに対して適切に情報を伝播させる仕組みが必要になります。

## コンテキスト・ウィンドウの限界

これまで繰り返し述べてきた通り、LLMをはじめとする生成AIには入力トークンの限界、すなわちコンテキストウィンドウが存在します。この制限を超えるようなデータを入力すると、モデルが正常に動作しなくなります。回避する方法も存在しますが、そもそも不必要に大量のデータを投入しないことが基本的かつ重要な設計原則となります。

## 制御の問題

生成AIに対して「〜をするな」「〜というルールを守れ」といった指示を出しても、遵守される場合とそうでない場合があります。これは生成AIの確率的な性質に起因するものです。

加えて、生成AIが情報を「忘れる」という現象も発生します。これは入力データが他の情報に埋もれてしまったり、途中で文脈を整理する過程で情報が失われたりすることで起こります。特に長いコンテキストの中間部分に配置された情報は忘れられやすいことが知られており、この現象は Lost in the Middle[^lost-in-middle] と呼ばれています。

このような生成AIの特性を踏まえると、クリティカルな制御はプロンプトによる指示に依存せず、コード（ツール実装）側で確実に実施する必要があります。

# BigQueryツールの要件

BigQueryに対してクエリを実行するツールを考えるとき、「クエリを発行してその結果を生成AIに返すだけ」というシンプルな構造を想定しがちです。確かに小規模なデータかつシンプルで分かりやすいスキーマであれば、この単純な実装でも機能するケースはあります。

しかし現実のセキュリティ監視環境では、ログは大量に存在しスキーマも複雑です。この状況に対応できないと、無効なクエリを投げ続けるだけのエージェントができあがってしまいます。したがって、単純なクエリ実行機能だけでなく、様々な副次的な要件を満たす必要があります。

## (1) ツールにスキーマ情報を与える必要がある

BigQueryは一般的なSQLをベースとしたGoogleSQL[^googlesql]を使用してデータを検索します。SQLでクエリを作成するには、どのようなフィールドが存在しているかを知る必要があります。`SELECT * FROM xxx` のような全カラム取得も不可能ではありませんが、大量のデータを含むログテーブルに対して実行すると一撃でトークン制限に達してしまいます。適切に検索するためには、フィールドの型だけでなくpartitionなどのメタ情報も必要です。

したがって、検索のためのスキーマ情報を何らかの形で生成AIに提供する必要があります。スキーマ情報を渡す方法はいくつか考えられますが、都度最新のスキーマ情報を取得する方式を採用すべきです。

その理由として、スキーマ情報が更新される可能性があることが挙げられます。特にセキュリティ監視で利用する外部サービスからのログレコードでは、頻繁にスキーマ更新（特にフィールドの追加）が発生します。静的にスキーマ情報を管理すると、更新の度にメンテナンスが必要になりコストが増大します。リアルタイムに最新のスキーマ情報を取得することで、このメンテナンスコストを削減できます。

## (2) クエリ結果の取得量に制限をかける必要がある

クエリ結果の取得サイズを制限する必要があります。仮に100万件のデータを返されても、生成AIのコンテキストウィンドウ内で処理することは不可能であり、トークン数が爆発してしまいます。適切なデータ量を順次読み込ませるような設計にしておく必要があります。

この制限をLLMへの指示で実現しようとしても、遵守されない場合が少なくありません。前述の制御の問題と同様に、生成AIは確率的な振る舞いをするため、プロンプトによる指示だけでは不十分です。したがって、ツールの実装内で強制的に制御をかける必要があります。

## (3) スキャンサイズに制限をかける必要がある

AIエージェント自身の機能要件ではありませんが、スキャン量を制御しておくことが運用上重要です。BigQueryは主にクエリのスキャン量で課金されるため、無制限なスキャンを許すとコストが爆発的に増大します。例えばus-central1リージョンでは1TBあたり$6.25の課金が発生するため、不適切なクエリが実行され続けると深刻な金銭的損失につながります。

生成AIは時として予想の斜め上を行く動作をするため、コスト制御をプロンプトだけに依存することはできません。この制御についても、ツールの実装内でガードレールとして組み込む必要があります。

## (4) 効率的にSQLを組み立てるためのサポートが必要である

スキーマ情報を提供するだけでは、生成AIが適切なクエリを書けない可能性があります。スキーマはテーブルやフィールドの構造を示しますが、実際にどのようなデータが格納されているかまでは分かりません。その結果、使用すべきテーブルやフィールドの選択が最適でない場合があります。

この問題を解決するには、具体的なクエリの例示を提供する必要があります。例示によって、生成AIは実際のデータ構造とクエリパターンの関係を理解し、より適切なSQLを組み立てられるようになります。

# 要件を踏まえたBigQueryツールの設計・実装

これらの要件を満たすことを考慮しながら、BigQueryのツールを実装していきます。ツールの基本的な構造や実装方法については前日までに解説してきているため、ここでは要点のみを抜粋して解説します。完全なコードはGitHubリポジトリに格納されているので、詳細を確認したい場合はそちらを参照してください。

## スキーマ情報を取得するツールも用意する

まず、クエリを実行するだけでなく、メタ情報も取得するツールを用意します。BigQueryの場合、テーブル単位でスキーマを取得できるAPI[^bq-metadata]が提供されているので、それをラップする形で実装します。フィールド情報だけでなく、partitionの情報も合わせて返すようにすることで、生成AIがより効率的なクエリを構築できるようになります。

この仕組みによって、なるべくリアルタイムに近いスキーマ情報を返すことができます。ただし、このツールだけを提供しても、生成AIはどのテーブルを調べればよいかを判断できません。この問題への対処方法については後述します。

```go:pkg/tool/bigquery/tool.go
{
    Name:        "bigquery_schema",
    Description: "Get schema information for a BigQuery table including field names, types, and descriptions",
    Parameters: &genai.Schema{
        Type: genai.TypeObject,
        Properties: map[string]*genai.Schema{
            "project": {
                Type:        genai.TypeString,
                Description: "Google Cloud project ID",
            },
            "dataset_id": {
                Type:        genai.TypeString,
                Description: "BigQuery dataset ID",
            },
            "table": {
                Type:        genai.TypeString,
                Description: "BigQuery table name",
            },
        },
        Required: []string{"project", "dataset_id", "table"},
    },
},
```

## ランブックを用意して生成AIに提供する

スキーマ情報も重要ですが、生成AIは具体的な手本があるとそれをよく解釈して活用してくれます。これはプロンプトエンジニアリングにおけるFew-shotプロンプティング[^few-shot]の一種です。よく調べるようなクエリパターンを事前に用意しておくことで、生成AIがそれを参考にして適切なクエリを構築できるようになります。

特に重要なのは条件式にどのような値を指定するかという点です。生成AIはフィールドの値を推測で決めてしまいがちですが、正解例を渡しておくことで正答率が飛躍的に向上します。例えば、タイムスタンプのフィルタリング方法や特定のフィールド値の検索パターンなどを示すことで、生成AIは実際のデータに即したクエリを作成できるようになります。

具体的な例としては https://github.com/m-mizutani/leveret/tree/day11-db-query-tool/examples/bigquery/runbooks を参照してください。ただしこれはあくまで例であり、実際には各組織が持つデータの特性に応じてランブックを作成するのが望ましいです。

ランブックの仕組みはシンプルで、IDを指定すると対象のSQLを返すというものです。この設計にしておくことで、ランブック自体が増えてもコンテキストウィンドウを無駄に消費しないようにできます。では生成AIはどうやってIDを知るのかという点については後述します。

```go:pkg/tool/bigquery/tool.go
if len(t.runBooks) > 0 {
    declarations = append(declarations, &genai.FunctionDeclaration{
        Name:        "bigquery_runbook",
        Description: "Get SQL query from runBook by ID",
        Parameters: &genai.Schema{
            Type: genai.TypeObject,
            Properties: map[string]*genai.Schema{
                "runbook_id": {
                    Type:        genai.TypeString,
                    Description: "RunBook ID to retrieve",
                },
            },
            Required: []string{"runbook_id"},
        },
    })
}
```

ランブックはSQLファイルとして用意します。ファイル形式にしておくと、エディタのSQL linter機能などを活用できて便利です。今回の実装では、メタデータもSQLファイルに同梱し、`title` と `description` というコメント行から情報を読み取るようにしています。メタデータの管理方法は様々な選択肢がありますが、SQLとメタデータが一つのファイルにまとまっていると管理しやすいという利点があります。

生成AIはこのサンプルを見て次にクエリを構築します。ランブックをそのまま参考にする場合もあれば、ランブックから学んだパターンを別のスキーマに適用する場合もあります。

```sql:examples/bigquery/runbooks/admin_activities.sql
-- title: Admin Activities
-- description: Query to track administrative activities and configuration changes

SELECT
  timestamp,
  protopayload_auditlog.authenticationInfo.principalEmail as principal,
  protopayload_auditlog.resourceName as resource,
  protopayload_auditlog.methodName as method,
  protopayload_auditlog.serviceName as service
FROM
  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`
WHERE
  TIMESTAMP_TRUNC(timestamp, DAY) >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND (
    protopayload_auditlog.methodName LIKE '%create%'
    OR protopayload_auditlog.methodName LIKE '%delete%'
    OR protopayload_auditlog.methodName LIKE '%update%'
    OR protopayload_auditlog.methodName LIKE '%setIamPolicy%'
  )
ORDER BY
  timestamp DESC
LIMIT 100
```

## テーブル情報やランブックの情報を、最初からプロンプトに埋め込む

先述した通り、スキーマやランブックの情報を提供するツールを用意しても、生成AIがそもそも何を探しに行けばよいか分からないという問題が発生します。この問題はプロンプトで一定程度解決できます。解決方法は大きく分けて2つあります。

1つ目の方法は、「ツールが存在するのでそれを使ってまずテーブルやランブックを探せ」という指示をプロンプトに入れておくことです。これによって生成AIはまずリストを取得するという動作をしてくれます。しかしこの方法には欠点があります。指示を無視される場合があるのです。特に「最短で目的を達成せよ」といった指示と競合すると、リスト取得をスキップしてしまうことがあります。また単純に生成AIとの往復回数が増えるため、応答時間が悪化します。

2つ目の方法は、最初からどのようなテーブルがあるかという概要情報だけをプロンプトに埋め込んでおくことです。この方式を採用すると、生成AIが最初に行動を起こす際の選択肢にテーブル情報が含まれるようになります。また都度ツール呼び出しでリストを生成する必要がないため、応答時間の面でも有利です。懸念点として事前プロンプトやシステムプロンプトでコンテキストウィンドウを消費してしまうことが挙げられますが、数個から数十個程度のテーブルやランブックであれば消費量は誤差の範囲といえます。

具体的な実装では、以前用意していた `Prompt` というメソッドを使います。このメソッドはエージェント起動前に呼び出され、文字列を返すとsystem promptに追記されます。ここにランブックやテーブルの一覧を書いておきます。記述するのはタイトルや簡単な概要だけで十分です。詳細まで記述するとコンテキストウィンドウを過度に消費してしまいます。この情報があるだけで、ツール呼び出しの精度が大幅に向上します。

```go:pkg/tool/bigquery/tool.go
// Prompt returns additional information to be added to the system prompt
func (t *Tool) Prompt(ctx context.Context) string {
	var lines []string

	// Add runBook information
	if len(t.runBooks) > 0 {
		lines = append(lines, "Available BigQuery runBooks:")
		for _, rb := range t.runBooks {
			line := fmt.Sprintf("- ID: %s", rb.ID)
			if rb.Title != "" {
				line += fmt.Sprintf(", Title: %s", rb.Title)
			}
			if rb.Description != "" {
				line += fmt.Sprintf(", Description: %s", rb.Description)
			}
			lines = append(lines, line)
		}
	}

	// Add table list information
	if len(t.tables) > 0 {
		if len(lines) > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, "Available BigQuery tables:")
		for _, table := range t.tables {
			line := fmt.Sprintf("- %s", table.FullName())
			if table.Description != "" {
				line += fmt.Sprintf(": %s", table.Description)
			}
			lines = append(lines, line)
		}
	}

	if len(lines) == 0 {
		return ""
	}

	return strings.Join(lines, "\n")
}
```

上記のコードによって、以下のようなプロンプトがsystem promptに追記されます。

```markdown
Available BigQuery runBooks:
- ID: admin_activities, Title: Admin Activities, Description: Query to track administrative activities and configuration changes
- ID: failed_operations, Title: Failed Operations, Description: Query to find operations that resulted in errors or failures
- ID: recent_data_access, Title: Recent Data Access Logs, Description: Query to retrieve recent data access audit logs from the last 24 hours

Available BigQuery tables:
- mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity: Admin activity audit logs (configuration changes, resource creation/deletion)
- mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_data_access: Data access audit logs (read/write operations on data)
- mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_system_event: System event audit logs (GCP-initiated operations)
```

## スキャンサイズや結果取得数のガードを入れる

生成AIに「〜は禁止」という指示をしても、容易に破られてしまいます。したがってガードレールはツールとして実行されるコード内に実装する必要があります。今回はBigQueryのスキャンサイズと結果取得する際の上限を設定します。

まずスキャンサイズの制御から見ていきます。事前にDryRunを実行して、指定した上限を超えていたらエラーを返すようにします。エラーの返し方がポイントで、単に「だめでした」ではなく改善の方向を示唆することが重要です。

例えばスキャンサイズが大きすぎた場合、エラーメッセージ内でカラムの制限、日付範囲の指定、partitioned tableの利用などを指示します。また実際のスキャンサイズと上限値の両方を返すことで、どの程度オーバーしていたのかを生成AIが理解できるようにします。このエラーメッセージを生成AIに投入することで、次の動作で適切な修正が期待できます。

逆にこのような具体的な指示がないと、生成AIは思いつきでクエリを連発し続け、永遠にエラーになるという事態に陥ります。

```go:pkg/tool/bigquery/query.go
// Perform dry run to check scan size
bytesProcessed, err := t.bq.DryRun(ctx, in.Query)
if err != nil {
    return &genai.FunctionResponse{
        Name: fc.Name,
        Response: map[string]any{
            "error": fmt.Sprintf("Query validation failed: %v", err),
        },
    }, nil
}

// Check scan limit
scanLimitBytes := t.scanLimitMB * 1024 * 1024
bytesProcessedMB := float64(bytesProcessed) / 1024 / 1024

if bytesProcessed > scanLimitBytes {
    return &genai.FunctionResponse{
        Name: fc.Name,
        Response: map[string]any{
            "error": fmt.Sprintf(
                "Query would scan %.2f MB, which exceeds the limit of %d MB. Please refine your query to reduce data scanned (e.g., add date filters, limit columns, or use partitioned tables).",
                bytesProcessedMB,
                t.scanLimitMB,
            ),
        },
    }, nil
}

// Execute query
jobID, err := t.bq.Query(ctx, in.Query)
if err != nil {
    return &genai.FunctionResponse{
        Name: fc.Name,
        Response: map[string]any{
            "error": fmt.Sprintf("Query execution failed: %v", err),
        },
    }, nil
}
```

結果の取得については、シンプルに上限を超えていたら強制的に補正しているだけです。ただし `limit` パラメータの説明文に最大値をきちんと埋め込んでおき、生成AI側に制限を理解させることが重要です。

```go
func (t *Tool) executeGetResult(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error) {
	type input struct {
		JobID  string `json:"job_id"`
		Limit  int    `json:"limit"`
		Offset int    `json:"offset"`
	}

    // 中略

	if in.Limit > int(t.resultLimitRows) {
		in.Limit = int(t.resultLimitRows)
	}
```

```go
    "limit": {
        Type:        genai.TypeInteger,
        Description: fmt.Sprintf("Maximum number of rows to return (default: 100, max: %d)", t.resultLimitRows),
    },
```

# 実行例

ここまでの実装で、BigQueryに対してクエリを実行するツールが完成しました。以下に実行例を示します。なお、設定値などの詳細は省略しています。

この実行例では、まずエージェントがランブックを取得し、その後実際のクエリを発行しています。結果として特に該当するデータが得られなかったため、その旨のみを返して説明しています。

```shell
$ go run . chat -i 655c6341-43d4-4ebd-b44e-ab7222523463
Enabled tools: [search_alerts query_otx bigquery_query bigquery_get_result bigquery_schema bigquery_runbook]

Chat session started. Type 'exit' to quit.

> このアラートに関連するインスタンスが直近で変更された形跡があるかを調査し、結果を報告せよ

⠏ processing...
🔧 Calling tool: bigquery_runbook
   Args:
{
     "runbook_id": "admin_activities"
   }
✅ Tool result:
{
  "description": "Query to track administrative activities and configuration changes",
  "runbook_id": "admin_activities",
  "sql": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo....

⠹ processing...
🔧 Calling tool: bigquery_query
   Args:
{
     "query": "SELECT\n  timestamp,\n  protopayload_auditlog.authenticationInfo.principalEmail as principal,\n  protopayload_auditlog.resourceName as resource,\n  protopayload_auditlog.methodName as method,\n  protopayload_auditlog.serviceName as service\nFROM\n  `mztn-audit.google_cloud_audit.cloudaudit_googleapis_com_activity`\nWHERE\n  TIMESTAMP_TRUNC(timestamp, DAY) \u003e= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)\n  AND (\n    protopayload_auditlog.methodName LIKE '%create%'\n    OR protopayload_auditlog.methodName LIKE '%delete%'\n    OR protopayload_auditlog.methodName LIKE '%update%'\n    OR protopayload_auditlog.methodName LIKE '%setIamPolicy%'\n  )\n  AND protopayload_auditlog.resourceName LIKE '%projects/production-project-12345/zones/us-central1-a/instances/web-server-prod-01%'\nORDER BY\n  timestamp DESC\nLIMIT 100"
   }
⠸ processing...✅ Tool result:
{
  "job_id": "ZxHKSXCspe5safA58SyxR3PdT87",
  "rows_returned": 0
}

アラートに関連するインスタンス「web-server-prod-01」について、過去7日間に設定変更や管理アクティビティ（作成、削除、更新、IAMポリシー設定など）は確認されませんでした。
```

# まとめ

今回はセキュリティ監視で実践的に利用できるBigQueryログ検索ツールの実装について解説しました。

セキュリティ監視におけるログ検索ツールは、単純なクエリ実行機能だけでは不十分です。生成AIの特性として「知らないものは探さない」「コンテキストウィンドウの限界がある」「制御が確実でない」という点を理解した上で設計する必要があります。

BigQueryツールの実装では、以下の4つの要件を満たす必要があります。第一に、スキーマ情報をリアルタイムに取得できるツールを用意すること。第二に、結果取得量の制限をツール側で強制的に設けること。第三に、スキャンサイズの制限を実装してコスト爆発を防ぐこと。第四に、ランブックによる具体的なクエリ例を提供してSQL組み立てをサポートすることです。

これらの要件の中でも特に重要なのは、テーブル一覧やランブック一覧を事前プロンプトに埋め込むことです。この仕組みによって、生成AIが「何を探せばいいか」を最初から理解できるようになります。結果としてツール呼び出しの往復回数が減り、応答時間も改善されます。

またエラーメッセージには改善の方向性を含めることで、生成AIの次の行動を適切に誘導できます。単に「エラーが発生しました」ではなく、「カラムを制限してください」「日付範囲を指定してください」といった具体的な指示を含めることが重要です。

今回実装したBigQueryツールの設計パターンは、BigQueryに限らず他のデータベースやログ検索システムにも応用可能です。生成AIの特性を理解し、適切なガードレールと情報提供の仕組みを組み込むことで、実用的なツールを構築できます。

[^googlesql]: https://cloud.google.com/bigquery/docs/introduction-sql?hl=ja
[^bq-metadata]: BigQuery Metadata API https://cloud.google.com/bigquery/docs/information-schema-tables
[^few-shot]: Few-shot prompting https://www.promptingguide.ai/techniques/fewshot
[^lost-in-middle]: "Lost in the Middle: How Language Models Use Long Contexts" https://arxiv.org/abs/2307.03172
