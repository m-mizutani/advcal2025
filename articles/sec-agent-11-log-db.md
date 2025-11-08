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

- セキュリティ監視の文脈ではログの検索・集計ができることが非常に重要
  - 検知：ログを集計するなどしてそこから特定の事象や、不振な事象をみつける
  - 調査：何事かあったときにアプリ・サービスのログを調査することで事実の検証、原因の調査、影響範囲の確認などに活用する
  - さらに脅威ハンティングのような能動的に異常を見つける行為にも活用できる
- ログの保存は様々な形式があるがBigQueryは一つの最適解
  - SIEM（Security Information Event Manager）などに保管することもあるが高い
  - BigQueryは運用などを自分でしないといけない代わりに、ログの投入・維持コスト非常に安い
  - 主にクエリ課金なのもありがたい

# ツール設計において重要なポイント

## 「知らないモノは探さない」

- 例えばツールによって取得できる情報があるとしても、何が取得できるのかを生成AI側が知らないとそもそも探しにいかない
- 「探せばわかる」場合も「そもそも探しに行こう」とするアクションを取らない可能性もおおいにある
  - これは行動回数を短縮させるとおこりがち
  - コストや応答速度の観点から、行動回数を短縮させることは多い
- そのため適切に情報を伝播しなければならない

## コンテキスト・ウィンドウの限界

- 再三言っている通り、LLMはじめとする生成AIには入力トークンの限界＝コンテキストウィンドウが存在する
- これを超えるようなデータを入れると動かなくなる
  - 回避させる方法はあるが、そもそもむやみにでかいデータを突っ込まないことがまず重要である

## 制御の問題

- 生成AIに「〜をするな」「〜というルールを守れ」といっても守るときと守らないときがある
- そもそも生成AIが「忘れる」という現象がおきる
  - これは入力データの埋もれたり、途中でデータを整理したりなどによっておきる
  - 長いコンテキストの中間部分を忘れやすいという事象がある
    - これを Lost in the Middle と呼ぶらしい
- そのためクリティカルな制御はコード（ツール実装）側でやる必要がある

# BigQueryツールの要件

- BigQueryへ検索するツールを考えると「クエリを発行してその結果を生成AIに返すだけ」というシンプルな構造を考えがち
- もちろん小さなデータ＆シンプルでわかりやすいスキーマならそれでもワークするケースはある
- しかし現実にはログは大量かつスキーマも複雑である
- これをうまく解決しないと無効なクエリを投げ続けるエージェントができあがる
- このためにいろいろ副次的な要件が必要になるのである

## (1) ツールにスキーマ情報を与える必要がある

- BigQueryは一般的なSQLをベースとした[GoogleSQL](https://docs.cloud.google.com/bigquery/docs/introduction-sql?hl=ja)で検索をする
- SQLでクエリをするということはどのようなフィールドが存在しているかを知らなければならない
  - `SELECT * FROM xxx` とかできなくもないが一撃でトークン制限に達する
  - 適切に検索するためにはフィールドの型だけでなく、partitionなどの情報も必要になる
- そのため検索のためのスキーマ情報をなんらかの形で与えてあげるのがよい
- スキーマ情報を渡す方法はいくつか考えられるが、都度最新のスキーマ情報を取得するようにするべき
  - スキーマ情報が更新される可能性がある
  - セキュリティ監視に使うような外部から入ってくるログレコードの場合は、頻繁にスキーマ更新（特に追加）が起きる
  - そのためメンテコストの提言などを考えるとリアルタイムに取得するほうがよい

## (2) クエリ結果の取得量に制限をかける必要がある

- 結果の取得サイズを制限する必要がある
  - 1000000件のデータとかを返されてもトークンが爆発する
  - 適切なデータを順次読ませるというような設計にしておく必要がある
- これはLLMに指示しても遵守されない場合がある。わりとよくある
  - そのためツール内でこういう制御をかける必要がある

## (3) スキャンサイズに制限をかける必要がある

- AIエージェント自身の機能ではないが、スキャン量を制御しておくのが良い
  - BigQueryは主にクエリのスキャン量で課金される
  - 滅茶苦茶なスキャンをすると破産する（例 $6.25/1TB in us-central1）
  - 当然AIは予想の少し斜め上を行く
- こういうのもツール内で制御を掛ける必要がある

## (4) 効率的にSQLを組み立てるためのサポートが必要である

- スキーマを与えるだけだと適切なクエリを書けない可能性がある
  - どういうデータが入っているのか想像できない
  - 使うテーブル・フィールドが最適ではない可能性がある
- そのためもうちょっと例示を出してあげる必要がある

# 要件を踏まえたBigQueryツールの設計・実装

- これらの要件を満たすことを考え、BigQueryのツールを実装してく
- 基本的な部分は前日までに解説してきているので、要点のみ抜粋して解説する
- コードはGitHubにあるので、詳細は自身で確認してくれ

## スキーマ情報を取得するツールも用意する

- まずクエリを実行するだけでなく、メタ情報も取得するツールを用意する
- BigQueryの場合、テーブル単位でスキーマを吐き出せるAPIがあるので、それをwrapする
- フィールド情報だけでなく、partitionの情報も合わせて返してあげるようにする
- これでなるべくリアルタイムに近い情報を返すことができる
- ただこれだけ提供しても、どのテーブルを見に行けばいいか？ というのは生成AIはわからない
  - この方法については後述

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

- スキーマ情報も重要だが、生成AIは手本があるとそれをよく解釈してくれる
  - プロンプトエンジニアリングにおけるFew-shotプロンプティングの一種
  - よく調べるようなクエリを事前に用意しておく
  - 特に条件式にどのようなものを指定するかが重要
  - 生成AIはフィールドの値を雑に推測しがちなので、正解例を渡しておくと飛躍的に正解率があがる
- 例としては https://github.com/m-mizutani/leveret/tree/day11-db-query-tool/examples/bigquery/runbooks 参照だが、あくまで例である
  - 基本的には自分たちの持つデータに対して決定するのがよい
- ランブックはIDを指定すると対象のSQLを返すというシンプルなもの
  - こうしておくことでランブック自体が増えてもコンテキストを無駄に増やさないようにでる
  - ではどうやってIDを知るのかについては後述

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

- ランブックはSQLで用意しておく
- ファイル形式にしておくとエディタのSQL linterなどが活用できて便利
- 今回はメタデータもSQLファイルに同梱して、`title` と `description` というコメントから情報を拾うようにしている
  - これはどういうやりかたでもいいが、個人的には全部まとまっているのが管理がしやすくて好ましい
- 生成AIはこのサンプルをみて次にクエリを構築する
  - コレを参考にする場合もあるし、別のスキーマを見に行く場合もある

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

- 先述した通り、スキーマやランブックの情報を提供するツールを用意しても、そもそも何を探しに行けばいいかからない、ということが起きる
- これはプロンプトで一定解決できる。解決方法が大きく分けて2つある
  - 1. ツールが存在するのでそれを使ってまずテーブルやランブックを探せ、という指示をいれておく
    - これによってまずリストを取得するという動作をしてくれる
    - しかししてくれない場合もある。特に「最短で目的を達成せよ」とか指示をするとそういうことがおきる
    - また単純に生成AIとの往復が多くなり、応答時間が悪くなる
  - 2. ではどうするかというと最初からどういうテーブルがあるかという概要情報だけプロンプトに突っ込んでおく
    - これをしておくと生成AIがまず行動するときの選択肢にはいる
    - また都度ツール呼び出しでリスト生成とかしないでいいので応答時間的にも有利
    - 問題は事前プロンプト、ないしはシステムプロンプトでコンテキストウィンドウを消費してしまうが、数個〜数十個程度だったらまあ誤差
- 具体的には、先日用意して使っていなかった `Prompt` というメソッドを使う
  - これはエージェント起動前に呼び出されて、もし文字列を返せばsystem promptに追記される
  - ここにランブックやテーブルの一覧を書いておく
    - あくまでタイトルや簡単な概要だけでよい。あんまり細かくやるとコンテキストウィンドウを消費しすぎる
  - これがあるだけで呼び出しの精度がぐっと上がる

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

- 上記コードによってこういうプロンプトが追記される

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

- 生成AIに「〜は禁止」という指示をしても容易にやぶってくる
- なのでガードレールはツールとして実行されるコード内に実装する
- 今回はBigQueryのスキャンサイズと結果取得する際の上限の設定

- まずスキャンサイズはこんな感じ
- 事前にDryRunを回して、指定した上限を超えていたらエラーを返す
- エラーの返し方がポイントで単に「だめでした」ではなく改善の方向を示唆する
  - 例えばここではスキャンサイズが大きすぎた場合、カラム制限や日付の範囲指定、partition tableの利用を指示する
  - またどれくらいオーバーしていたのかも返す
  - このエラーを生成AIに投入することで、次の動作の修正が期待される
- 逆にこういう指示がないと、思いつきでクエリを連発して永遠にエラーになる

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

- 結果の取得はシンプルに上限を超えていたら矯正しているだけ
- `limit` の説明にも最大値をちゃんと埋め込んでおいて、生成AI側に理解させることが重要

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

- ここまでできるとクエリするツールが実行できるようになった
- 以下実行例。設定値は省略してます
- 実行例ではまずランブックを取得し、その後実際のクエリを発行している
- 結果では特に該当する結果を得られなかったのでその結果のみを返して説明している

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
