---
title: "Goで作るセキュリティ分析LLMエージェント(4): 開発環境の準備と事前実装済みコードの説明"
emoji: "⚙️"
type: "tech"
topics: ["go", "cli", "docker"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の4日目です。今回は開発環境のセットアップについて一通り解説し、明日からの開発が可能な状態にまでなるのが目的です。開発環境の設定方法および、開発で利用するためにこちらで事前実装したベースコードについて解説します。

# 開発環境の準備

すでにGo言語の開発環境およびGoogle Cloudサービスを利用しており自力で設定可能な方は読む必要はありません。今回で準備が必要なのは以下のとおりです。

- [ ] Goのローカル開発環境の用意
  - [ ] エディタ
  - [ ] Go環境のセットアップ
  - [ ] ベースコードの取得
- [ ] Google Cloud の Projectとリソースの作成
  - [ ] Firestore DB
  - [ ] Cloud Storage Bucket
  - [ ] Vertex AI (Gemini) の有効化

## エディタの用意

まず開発に使用するエディタを準備します。基本的にはお好みのエディタで問題ありませんが、VS Codeを推奨します。VS Codeを使用する場合は、[Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go)のインストールをおすすめします。この拡張機能により、デバッグ機能、コード補完、フォーマッターなどが利用可能になり、開発効率が向上します。他のエディタを使用する場合も、Go言語のサポートが充実しているものを選ぶと良いでしょう。

## Go環境のセットアップ

Go言語の開発環境をセットアップします。詳しいインストール手順は[公式サイト](https://go.dev/doc/install)を参照してください。

インストールが完了したら、以下のコマンドでバージョンを確認し、正しくインストールされていることを確認してください。

```bash
$ go version
go version go1.25.x darwin/arm64  # バージョン番号とアーキテクチャは環境により異なります
```

本シリーズではGo 1.25以降を想定していますが、それ以前のバージョンでも動作する可能性があります。

## GitHubからclone

今回利用するプロジェクトは [leveret](https://github.com/m-mizutani/leveret) です。以下のいずれかの方法でコードを取得してください。コードの構造などの解説は後述します。

`init` ブランチには、開発のベースとなるコードが含まれています。このブランチをベースに、記事を進めながら機能を追加していきます。完成版のコードは `main` ブランチで確認できます。

### Git cloneでの取得

```bash
# SSH経由
$ git clone git@github.com:m-mizutani/leveret.git
$ cd leveret
$ git checkout init

# HTTPS経由
$ git clone https://github.com/m-mizutani/leveret.git
$ cd leveret
$ git checkout init
```

### zipファイルでの取得

Gitがない環境や一時的に確認したい場合は、GitHubから直接ダウンロードも可能です。

1. https://github.com/m-mizutani/leveret にアクセス
2. ブランチを `init` に切り替え
3. 「Code」→「Download ZIP」からダウンロード
4. 解凍して利用

# Google Cloudのセットアップ

今回の開発においてコードを動かすのはローカル環境ですが、LLMやデータストアなどはクラウド上のものを利用します。あまり課金は発生しない見込みですが、このアドベントカレンダーの内容を一通り実施すると数ドル程度の課金が発生する見込みです。

- Google Cloudを初めて利用する場合、[$300分の無料クレジット](https://cloud.google.com/free)が提供されるのでこれを活用するのも良いでしょう
- あらかじめ設定した課金額の超過を警告する設定も後述するので、参考にしてください

## サインアップ・プロジェクト作成

まずGoogle Cloudを利用したことがない、あるいはプロジェクトを分けて準備したい方は新たにプロジェクトを作成してください。以下の手順でセットアップを行います。

1. [Google Cloud Console](https://console.cloud.google.com/)にアクセス
2. Googleアカウントでサインイン（アカウントがない場合は作成）
3. 利用規約に同意し、無料トライアルを開始
4. 「新しいプロジェクト」を作成
   - プロジェクト名: 任意（例: `leveret-dev`）
   - プロジェクトIDは自動生成されますが、変更も可能
5. 請求先アカウントの設定
   - クレジットカード情報を登録（無料期間内は課金されません）
   - 本人確認のため少額の一時的な決済が発生する場合があります

## Firestore有効化とDB作成

アラート情報やベクトルデータを保存するためにFirestoreを有効化します。

Firestoreを利用するのはベクタ検索を利用したいためです。ベクタ検索をする場合はインデックスを作成する必要がありますが、これは後日設定します。

### API有効化

まずFirestore APIを有効化します。

1. [Firestore API有効化リンク](https://console.cloud.google.com/flows/enableapi?apiid=firestore.googleapis.com)にアクセス
2. 「APIを有効にする」をクリック
3. APIが有効化されるまで数秒待つ

### データベース作成

次にFirestoreデータベースを作成します。

1. [Firestore画面](https://console.cloud.google.com/firestore)にアクセス
2. 「データベースの作成」をクリック
3. データベース名を指定（例: `leveret-dev` など）
4. モード選択
   - **「Firestoreモード」を選択**（Datastoreモードは非推奨）
5. ロケーション選択
   - **シングルリージョンを推奨**（例: `asia-northeast1` (東京)）
   - マルチリージョンは料金が高くなるため、学習目的では不要
   - **ロケーションは後から変更できないため注意**
6. 「作成」をクリック

:::message alert
Firestoreはストレージ容量と読み書き操作に応じて課金されます。本シリーズの用途であれば月額数ドル程度ですが、予算アラートの設定を推奨します（後述）。
:::

## Cloud Storage有効化とバケット作成

会話履歴を保存するためにCloud Storageバケットを作成します。

### API有効化

まずCloud Storage APIを有効化します。

1. [Cloud Storage API有効化リンク](https://console.cloud.google.com/flows/enableapi?apiid=storage-api.googleapis.com)にアクセス
2. 「APIを有効にする」をクリック
3. APIが有効化されるまで数秒待つ

### バケット作成

次にCloud Storageバケットを作成します。

1. [Cloud Storage画面](https://console.cloud.google.com/storage)にアクセス
2. 「バケットを作成」をクリック
3. バケット名を入力
   - グローバルに一意な名前が必要（例: `leveret-dev-conversations-20251213`）
4. ロケーション設定
   - 「リージョン」を選択
   - Firestoreと同じリージョン推奨（例: `asia-northeast1`）
5. ストレージクラス: 「Standard」を選択
6. アクセス制御: 「均一」を選択
7. 「作成」をクリック

バケット名は後ほど設定ファイルで指定するため、控えておいてください。

## Vertex AI (Gemini) の有効化

エージェントの対話的な分析、ツール呼び出し、およびアラートのEmbedding生成にGemini APIを使用するため、Vertex AIを有効化します。

1. [Vertex AI画面](https://console.cloud.google.com/vertex-ai)にアクセス
2. 「APIを有効にする」をクリック
   - または[こちらのリンク](https://console.cloud.google.com/flows/enableapi?apiid=aiplatform.googleapis.com)から直接有効化
3. APIが有効化されるまで数分待つ

:::message
Vertex AIを通じてGemini 2.5モデル（対話・ツール呼び出し）とEmbeddingモデル（`text-embedding-004`）を利用します。[料金](https://cloud.google.com/vertex-ai/generative-ai/pricing)は以下の通りです。
- Gemini 2.5 Flash: $0.075 / 1M入力トークン、$0.30 / 1M出力トークン
- テキストEmbedding: $0.00001 / 1K characters
- 本シリーズの用途であれば月額数ドル程度に収まります
:::

Vertex AIの認証は、後述するADC（Application Default Credentials）をそのまま利用できるため、追加の設定は不要です。

## gcloudツールのインストールとADCの認証

ローカル開発環境からGoogle Cloudにアクセスするため、gcloud CLIをインストールします。

### インストール

[gcloud CLIのインストール公式ドキュメント](https://cloud.google.com/sdk/docs/install)を参照してインストールしてください。インストール後、初期化を実行します。

```bash
$ gcloud init
```

### Application Default Credentials (ADC) の設定

ローカル開発環境でGoogle Cloud APIを利用するため、認証情報を設定します。

```bash
$ gcloud auth application-default login
```

ブラウザが開くので、Googleアカウントでログインして認証を完了します。これにより、アプリケーションから自動的にGoogle Cloud APIにアクセスできるようになります。

## Budget and Alertsの設定

予期しない課金を防ぐため、[予算アラート](https://cloud.google.com/billing/docs/how-to/budgets)を設定することを強く推奨します。

1. [予算とアラート画面](https://console.cloud.google.com/billing/budgets)にアクセス
2. 「予算を作成」をクリック
3. 予算名を入力（例: `leveret-dev-budget`）
4. 時間範囲: 「月次」を選択
5. プロジェクトを選択
6. 予算額を設定
   - **$5〜$10程度を推奨**
   - 本シリーズの実装であれば通常この範囲内に収まります
7. しきい値の設定
   - デフォルト（50%, 90%, 100%）のままでOK
   - 実際の支出と予測支出の両方でアラート推奨
8. 通知先のメールアドレスを設定
9. 「完了」をクリック

:::message alert
予算を設定しても、自動的に課金が停止されるわけではありません。アラートを受け取ったら速やかに確認し、必要に応じてリソースを削除してください。
:::

# 開発用ベースコードの解説

取得した `leveret` プロジェクトの `init` ブランチには、開発のベースとなるコードが用意されています。ここでは主要な構成要素を確認します。大枠としての構造は3日目の記事で説明したレイヤードアーキテクチャに対応していますが、ここでは実際のコードと付き合わせて確認していきます。

プロジェクトは以下のような構成になっています。

```
leveret/
├── main.go              # エントリーポイント
├── examples/            # サンプルデータ
│   └── alert/
│       └── guardduty.json
├── pkg/
│   ├── adapter/         # 外部サービス接続
│   │   ├── gemini.go
│   │   └── storage.go
│   ├── cli/             # CLIコマンド定義
│   ├── model/           # データ構造定義
│   ├── repository/      # データ永続化
│   └── usecase/         # ビジネスロジック
│       ├── alert/
│       ├── chat/
│       └── history/
├── go.mod
└── go.sum
```

ここではベースコード時点ですでに実装がほぼ終わっているコンポーネントを✅、これから改修などが必要になるものについて🚧で表現しています。

## ✅ エントリーポイント (`main.go`)

CLIアプリケーションのエントリーポイントです。Goコマンドによるインストールの容易さのためにトップレベルに `main.go` だけを配置しています。実装は非常にシンプルで、`pkg/cli` パッケージの `Run` 関数を呼び出し、エラーハンドリングを行うだけです。

```go
func main() {
    ctx := context.Background()
    if err := cli.Run(ctx, os.Args); err != nil {
        os.Exit(err.Code)
    }
}
```

## ✅ フレームワーク層 (`pkg/cli/`)

CLI層は各サブコマンドの定義と、コマンドライン引数の処理を担当する層です。ここではコマンドラインやテキスト入力とユースケースとの橋渡しをするのが責務です。

まずコマンドライン引数をパースし、必要な環境変数や設定ファイルを読み込みます。次にこれらの情報を元にレポジトリとアダプターのインスタンスを作成し、最後にそれらをユースケース層へ注入することで、ビジネスロジックの実行準備を整えます。

`cli.go` でメインコマンドを定義し、各サブコマンドを登録します。ここが `main.go` との接続点になります。例えば `new` サブコマンドは `newCommand()` を渡してサブコマンドを登録しています。

```go
cmd := &cli.Command{
    Name:  "leveret",
    Usage: "Security alert analysis agent",
    Commands: []*cli.Command{
        newCommand(),
        chatCommand(),
        // ...略...
```

この実装のオプションの取り方のポイントの一つとしては、各コマンドで共通の設定を `config` 構造体で管理している点です。各コマンドで共通しうる（しかし完全に共通ではない）設定値は `type config struct` で管理しており、フラグの設定もこの構造体から供出されます。

```go
type config struct {
    // Repository
    firestoreProject string
    database         string

    // Adapters
    geminiProject         string
    geminiGenerativeModel string
    geminiEmbeddingModel  string

    // Storage
    bucketName    string
    storagePrefix string
}
```

設定値はコマンドラインフラグまたは環境変数から取得します。`globalFlags()` と `llmFlags()` でフラグ定義をまとめており、各コマンドで再利用できます。

## 🚧 モデル層 (`pkg/model/`)

システム全体で使用するデータ構造を定義します。基本は `Alert` と `History` ですが、いくらか追加修正をする見込みです。

### `Alert` 構造体

受信したアラートのデータおよびそこから得られた付加情報を表現します。3日目の記事で説明した通り、実データや属性値などを持ちます。

```go
type Alert struct {
    ID          AlertID
    Title       string
    Description string
    Data        any
    Attributes  []*Attribute
    // 以下略
```

### `History` 構造体

どのアラートと会話履歴データが紐づくかを表現するモデルです。会話データの実態はCloud Storageに保管しますが、紐づけ情報は高速に検索できるように別モデルで管理し、DBに配置します。

```go
// History represents a conversation history for alert analysis
type History struct {
	ID        HistoryID
	Title     string
	AlertID   AlertID
    // 以下略
```

## 🚧 レポジトリ層 (`pkg/repository/`)

レポジトリ層はFirestoreへのデータ永続化を担当する層です。この層の特徴は、データ永続化のインターフェースとFirestoreという具体的な実装が分離されている点です。

`repository.go` でインターフェースを定義しています。

```go
type Repository interface {
    PutAlert(ctx context.Context, alert *model.Alert) error
    GetAlert(ctx context.Context, id model.AlertID) (*model.Alert, error)
    ListAlerts(ctx context.Context, offset, limit int) ([]*model.Alert, error)
    SearchSimilarAlerts(ctx context.Context, embedding []float64, limit int) ([]*model.Alert, error)

    PutHistory(ctx context.Context, history *model.History) error
    GetHistory(ctx context.Context, id model.HistoryID) (*model.History, error)
    ListHistory(ctx context.Context, offset, limit int) ([]*model.History, error)
}
```

`firestore.go` でFirestoreを使った実装を提供しています。`SearchSimilarAlerts` はベクトル検索を行うメソッドで、Embedding値を渡すと類似したアラートを返します。これは追って実装しますが、他の部分はほぼ実装済みとなっています。

テスト時にはモック実装に差し替えることができ、また将来的に別のデータベースへ移行する際にもこの層だけを書き換えれば済みます。今回の実装でも、もしFirestore以外を利用したかったらこの層を自由なデータベース用に書き換えていただいて大丈夫です（ただしEmbedding関連処理においてベクトル検索ができる必要があります）。

## ✅ アダプター層 (`pkg/adapter/`)

アダプター層は外部サービスとの接続を抽象化する層です。GeminiやCloud Storageのような外部サービスの具体的な呼び出し方法をこの層で隠蔽することで、上位層からは統一的なインターフェースで利用できるようにしています。またメソッドを簡易化することでテストのためにモックを作成しやすいというのも特徴です。

### ✅ Gemini Adapter (`gemini.go`)

Gemini APIとの接続を抽象化します。基本的には `google.golang.org/genai` の `Client` 構造体を少しwrapしている程度で、複雑なことは特にしていません。

実装では、生成モデル（`gemini-2.5-flash`）とEmbeddingモデル（`gemini-embedding-001`）をデフォルト値としています。

### ✅ Cloud Storage (`storage.go`)

Cloud Storageへの会話履歴の保存を抽象化します。ファイルのアップロードとダウンロードのみのシンプルな機能を提供します。

## 🚧 ユースケース層 (`pkg/usecase/`)

ユースケース層はビジネスロジックの中核を担う層です。レポジトリ層とアダプター層を組み合わせることで、各コマンドの機能を実現します。この層は今回のアドベントカレンダーにおいて多く書き換えをしていくことになります。

機能ごとにサブパッケージを分けています。

- `pkg/usecase/alert/` - アラート関連の操作（insert, list, show, search, resolve, merge, unmerge）
- `pkg/usecase/chat/` - 対話セッション関連の操作
- `pkg/usecase/history/` - 履歴管理関連の操作

例えばアラート作成処理（`alert/insert.go`）では、現時点では単純にアラートIDを生成してFirestoreに保存するだけですが、今後LLMによる要約生成やEmbedding生成などの処理を追加していきます。

```go
func (u *UseCase) Insert(ctx context.Context, data any) (*model.Alert, error) {
    alert := &model.Alert{
        ID:        model.NewAlertID(),
        Data:      data,
        CreatedAt: time.Now(),
    }

    // ここに生成AI関連の様々な処理を足していく

    if err := u.repo.PutAlert(ctx, alert); err != nil {
        return nil, err
    }

    return alert, nil
}
```

# コマンド構造

`leveret` は複数のサブコマンドで構成されています。`init` ブランチでは骨組みのみが実装されており、今後の記事で段階的に機能を追加していきます。

```
NAME:
   leveret - Security alert analysis agent

USAGE:
   leveret [global options] [command [command options]]

COMMANDS:
   new      Create a new alert from JSON input
   chat     Interactive analysis of an alert
   list     List all alerts
   show     Show detailed information of a specific alert
   search   Search for similar alerts using vector similarity
   resolve  Mark an alert as resolved
   merge    Merge an alert into another
   unmerge  Unmerge a merged alert
   help, h  Shows a list of commands or help for one command
```

細かい説明は実装を進めるとともにしますが、環境設定の確認を簡単に以下の手順で実施します。

以降のコマンド例では、オプションを毎回指定していますが、実際には後述する `zenv` を使うことでこれらの指定を省略できます。

## `new` コマンドでのアラート作成

`new` コマンドは、JSON形式のアラートデータを受け取り、新規アラートとして登録します。コマンドの実行は、現時点でのコードをそのまま実行するために `go run .` を使います。ソースコードを展開したルートディレクトリに移動してから実行してください。

またベースコードにサンプルのアラートデータ（ `examples/alert/guardduty.json` ）も含まれているのでそれを読み込ませます。

```bash
$ go run . new -i examples/alert/guardduty.json --firestore-project your-project-id --firestore-database database-id
Alert created: 550e8400-e29b-41d4-a716-446655440000
```

現時点の実装では、以下の処理を行います。

1. 指定されたJSONファイルを読み込み
2. 一意なアラートIDを生成（UUID）
3. アラートデータをFirestoreに保存
4. 生成されたアラートIDを出力

今後の記事で、LLMによるタイトル・要約の生成、属性値の抽出、Embedding生成などの機能を追加していきます。

## `list` コマンドでの一覧確認と `show` コマンドでの詳細確認

アラートが適切に登録されているかを確認するには `list` コマンドを使います。登録されているアラートの一覧を表示します。

例）
```bash
$ go run . list --firestore-project your-project-id --firestore-database database-id
550e8400-e29b-41d4-a716-446655440000        active
```

現在はタイトルや要約を生成する機能を実装していないため、Alert IDとステータスのみが表示されます。本来はタイトルも表示される設計ですが、今後の記事でLLMによるタイトル生成機能を追加すると、より読みやすい一覧表示になります。

Alert IDが確認できたらそれをもとに `show` コマンドを使って詳細を確認します。特定のアラートの詳細情報をJSON形式で表示します。

```bash
$ go run . show --alert-id 550e8400-e29b-41d4-a716-446655440000 --firestore-project your-project-id --firestore-database database-id
{
  "ID": "550e8400-e29b-41d4-a716-446655440000",
  "Title": "",
  "Description": "",
  "Data": { ... 元のGuardDutyアラートデータ ... },
  "Attributes": null,
  "CreatedAt": "2025-10-18T10:30:00Z",
  "ResolvedAt": null,
  "Conclusion": "",
  "Note": "",
  "MergedTo": ""
}
```

このコマンドは、アラートIDを指定して単一のアラートを取得し、全フィールドを整形されたJSONで出力します。デバッグやアラートの詳細確認に利用できます。

現時点では `Title`、`Description`、`Attributes` は空のままです。次回以降でLLMによる要約生成機能を実装することで、これらのフィールドが自動的に埋められるようになります。

# ⚠️ コマンドラインオプションと環境変数

ここまでの例では、各コマンドに `--firestore-project` や `--firestore-database-id` などのオプションを毎回指定してきました。しかし実際の開発では、同じオプションを繰り返し入力するのは手間がかかります。`leveret` の各コマンドは環境変数経由でも設定を受け取れるため、事前に設定しておくと便利です。

明日以降の記事では、コマンドサンプルの記載を簡潔にするため、以下のオプションは省略します。

| コマンドラインオプション | 対応する環境変数 |
|---|---|
| `--gemini-project` | `LEVERET_GEMINI_PROJECT` |
| `--firestore-project` | `LEVERET_FIRESTORE_PROJECT` |
| `--firestore-database-id` | `LEVERET_FIRESTORE_DATABASE_ID` |
| `--storage-bucket` | `LEVERET_STORAGE_BUCKET` |
| `--storage-prefix` | `LEVERET_STORAGE_PREFIX` |

これらは環境変数で設定されていることを前提として記述します。`leveret` の各コマンドは環境変数経由でも設定を受け取れるため、事前に設定しておくと便利です。

# 参考: 環境変数管理ツール `zenv`

シェルの起動スクリプト（`.bashrc` や `.zshrc`）に環境変数を直接書き込むこともできますが、この方法には問題があります。他のプロジェクトの環境変数と混在してしまったり、特定のプロジェクトでのみ必要な設定がすべてのシェルセッションで読み込まれてしまいます。

プロジェクトごとに環境変数を管理したい場合、筆者が実装している [zenv](https://github.com/m-mizutani/zenv) というツールが便利です。これはディレクトリごとに環境変数を管理し、コマンド実行時に自動的に読み込むツールです。

## インストール

```bash
go install github.com/m-mizutani/zenv/v2@latest
```

## 使い方

プロジェクトルートに `.env.yaml` を作成し、以下のように設定を記述します。

```yaml:.env.yaml
LEVERET_VERBOSE: 1 # エラー発生時にスタックトレースを表示するようにします

LEVERET_FIRESTORE_PROJECT: your-project-id
LEVERET_FIRESTORE_DATABASE_ID: leveret-dev

LEVERET_STORAGE_BUCKET: your-bucket-name
LEVERET_STORAGE_PREFIX: leveret-dev/

LEVERET_GEMINI_PROJECT: your-project-id
```

コマンド実行時に `zenv` を前置することで、これらの環境変数が自動的に読み込まれます。

設定が正しく読み込まれているか確認するには、`zenv` コマンド単体で実行してみましょう。

```bash
$ zenv | grep LEVERET | sort
LEVERET_FIRESTORE_DATABASE_ID=leveret-dev [.yaml]
LEVERET_FIRESTORE_PROJECT=your-project-id [.yaml]
LEVERET_GEMINI_PROJECT=your-project-id [.yaml]
LEVERET_STORAGE_BUCKET=your-bucket-name [.yaml]
LEVERET_STORAGE_PREFIX=leveret-dev/ [.yaml]
LEVERET_VERBOSE=1 [.yaml]
```

```bash
$ zenv go run . new -i alert.json
Alert created: 550e8400-e29b-41d4-a716-446655440000
```

これで毎回長いオプションを指定する必要がなくなります。

# まとめ

ここまでで、Go開発環境とGoogle Cloud（Firestore、Cloud Storage、Vertex AI）の設定、そして `leveret` プロジェクトの取得と構造理解まで進めました。Google Cloudの設定項目は多いですが、一度設定してしまえばあとは開発に集中できます。

次回からはいよいよコードを書いていきます。最初はシンプルなアラート要約から始めて、対話的な分析、ツール呼び出し、ポリシー処理と、徐々にエージェントらしい機能を積み上げていきましょう。
