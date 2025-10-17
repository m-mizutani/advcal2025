---
title: "開発環境の準備"
emoji: "⚙️"
type: "tech"
topics: ["Go", "security", "development", "CLI"]
published: false
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の4日目です。今回は開発環境のセットアップについて一通り解説し、明日からの開発が可能な状態にまでなるのが目的です。開発環境の設定方法および、開発で利用するテンプレートのコードについて解説します。

# 開発環境の準備

すでにGo言語の開発環境およびGoogle Cloudサービスを利用しており自力で設定可能な方は読む必要はありません。今回で準備が必要なのは以下のとおりです。

- [ ] Goのローカル開発環境の用意
  - [ ] エディタ
  - [ ] Go環境のセットアップ
  - [ ] テンプレートのコード取得
- [ ] Google Cloud の Projectとリソースの作成
  - [ ] Firestore DB
  - [ ] Cloud Storage Bucket
  - [ ] Vertex AI (Gemini) の有効化

## エディタの用意

まず開発に使用するエディタを準備します。基本的にはお好みのエディタで問題ありませんが、VS Codeを推奨します。VS Codeを使用する場合は、[Go extension](https://marketplace.visualstudio.com/items?itemName=golang.go)をインストールしてください。この拡張機能により、デバッグ機能、コード補完、フォーマッターなどが利用可能になり、開発効率が大幅に向上します。他のエディタを使用する場合も、Go言語のサポートが充実しているものを選ぶと良いでしょう。

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

## サインアップ・プロジェクト作成

Google Cloudを初めて利用する場合、[$300分の無料クレジット](https://cloud.google.com/free)が提供されます。以下の手順でセットアップを行います。

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

Vertex AIの認証は、前述のADC（Application Default Credentials）をそのまま利用できるため、追加の設定は不要です。

## gcloudツールのインストールとADCの認証

ローカル開発環境からGoogle Cloudにアクセスするため、[gcloud CLI](https://cloud.google.com/sdk/docs/install)をインストールします。

### インストール手順

#### macOS/Linuxの場合

```bash
# インストーラーをダウンロードして実行
$ curl https://sdk.cloud.google.com | bash

# シェルを再起動
$ exec -l $SHELL

# 初期化
$ gcloud init
```

#### Windowsの場合

1. [Google Cloud SDK インストーラー](https://cloud.google.com/sdk/docs/install)をダウンロード
2. インストーラーを実行
3. コマンドプロンプトまたはPowerShellを再起動
4. 初期化

```powershell
> gcloud init
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

# 用意されたベースコードの読み解き

取得した `leveret` プロジェクトの `init` ブランチには、最小限の骨組みとなるコードが用意されています。ここでは主要な構成要素を確認します。

## エントリーポイント (`main.go`)

CLIアプリケーションのエントリーポイントです。[urfave/cli/v3](https://cli.urfave.org/)を使用してコマンドライン引数をパースし、サブコマンドを実行します。

```go
func main() {
    cmd := &cli.Command{
        Name:  "leveret",
        Usage: "Security alert analysis agent",
        Commands: []*cli.Command{
            cli.NewCommand,    // newコマンド
            cli.ChatCommand,   // chatコマンド
            cli.ListCommand,   // listコマンド
            // ... 他のコマンド
        },
    }
    cmd.Run(context.Background(), os.Args)
}
```

## CLI層 (`pkg/cli/`)

CLI層は各サブコマンドの定義と、コマンドライン引数の処理を担当する層です。まずコマンドライン引数をパースし、必要な環境変数や設定ファイルを読み込みます。次にこれらの情報を元にレポジトリとアダプターのインスタンスを作成し、最後にそれらをユースケース層へDI（依存性注入）することで、ビジネスロジックの実行準備を整えます。

例えば `new.go` では以下のような構造になっています。

```go
var NewCommand = &cli.Command{
    Name:  "new",
    Usage: "Create a new alert from JSON input",
    Flags: []cli.Flag{
        &cli.StringFlag{Name: "input", Aliases: []string{"i"}},
    },
    Action: func(ctx context.Context, c *cli.Command) error {
        // レポジトリとアダプターの初期化
        repo := repository.NewFirestore(...)
        gemini := adapter.NewGemini(...)

        // ユースケースの作成と実行
        uc := usecase.New(repo, gemini)
        return uc.CreateAlert(ctx, input)
    },
}
```

## モデル層 (`pkg/model/`)

システム全体で使用するデータ構造を定義します。

```go
// Alert はセキュリティアラートを表す構造体
type Alert struct {
    ID          AlertID
    Title       string
    Description string
    Data        any
    Attributes  []*Attribute
    CreatedAt   time.Time
    // ...
}

// Attribute はアラートから抽出された属性値
type Attribute struct {
    Key   string
    Value string
    Type  AttributeType
}
```

この構造は3日目の記事で解説したデータモデルに対応しています。

## レポジトリ層 (`pkg/repository/`)

レポジトリ層はFirestoreへのデータ永続化を担当する層です。この層の特徴は、データ永続化のインターフェースとFirestoreという具体的な実装が分離されている点です。これによりテスト時にはモック実装に差し替えることができ、また将来的に別のデータベースへ移行する際にもこの層だけを書き換えれば済むようになっています。

```go
// Repository はデータ永続化のインターフェース
type Repository interface {
    SaveAlert(ctx context.Context, alert *model.Alert) error
    GetAlert(ctx context.Context, id model.AlertID) (*model.Alert, error)
    ListAlerts(ctx context.Context, filters ...Filter) ([]*model.Alert, error)
    // ...
}

// firestoreRepo はFirestore実装
type firestoreRepo struct {
    client *firestore.Client
}

func NewFirestore(projectID string) (Repository, error) {
    // Firestoreクライアントの初期化
    // ...
}
```

## アダプター層 (`pkg/adapter/`)

アダプター層は外部サービスとの接続を抽象化する層です。Gemini APIといった外部サービスの具体的な呼び出し方法をこの層で隠蔽することで、上位層からは統一的なインターフェースで利用できるようにしています。また外部APIの仕様変更や別サービスへの切り替えが発生した場合も、この層のみを修正すれば済むため、保守性が高まります。

### Gemini Adapter (`gemini.go`)

```go
// Gemini はGemini APIクライアントのインターフェース
type Gemini interface {
    Chat(ctx context.Context, messages []Message) (*Response, error)
    GenerateEmbedding(ctx context.Context, text string) ([]float64, error)
    // ...
}

type geminiAdapter struct {
    projectID string
    location  string
    client    *genai.Client
}

func NewGemini(projectID, location string) Gemini {
    // Gemini APIクライアントの初期化
    // ...
}
```

## ユースケース層 (`pkg/usecase/`)

ユースケース層はビジネスロジックの中核を担う層です。レポジトリ層とアダプター層を組み合わせることで、各コマンドの機能を実現します。例えばアラート作成処理では、まずJSONデータをパースし、次にGemini APIで要約を生成させ、同じくGemini APIでEmbeddingベクトルを作成し、最後にFirestoreへ保存するという一連の流れをこの層で制御します。

```go
type UseCase struct {
    repo   repository.Repository
    gemini adapter.Gemini
}

func New(repo repository.Repository, gemini adapter.Gemini) *UseCase {
    return &UseCase{
        repo:   repo,
        gemini: gemini,
    }
}

func (uc *UseCase) CreateAlert(ctx context.Context, data []byte) error {
    // アラート作成のロジック
    // 1. JSONをパース
    // 2. Gemini APIで要約生成
    // 3. Gemini APIでEmbedding生成
    // 4. Firestoreに保存
    // ...
}
```

# コマンド構造

`leveret` は複数のサブコマンドで構成されています。`init` ブランチでは骨組みのみが実装されており、今後の記事で段階的に機能を追加していきます。

## newコマンド

`new`コマンドはアラートを新規登録するコマンドです。

```bash
$ leveret new -i alert.json
```

このコマンドの処理の流れは以下のとおりです。まずJSON形式のアラートデータを受け取り、ポリシー判定を実行して受理するかどうかを判断します（ポリシー判定機能は15日目以降で実装します）。受理されたアラートはGemini APIで要約とIOC（侵害指標）を抽出し（5〜6日目で実装）、さらにGemini APIでEmbeddingベクトルを生成します（21日目で実装）。最後にこれらの情報をFirestoreに保存し、生成されたアラートIDを返します。

## chatコマンド

`chat`コマンドは既存のアラートに対して対話的な分析を行うコマンドです。

```bash
$ leveret chat <alert-id>
```

まず指定されたIDのアラートをFirestoreから取得します。次にGemini APIとTool Callループを使って対話的な分析を進めます（9日目以降で実装）。この際、会話履歴はCloud Storageに保存されるため、分析を中断しても後から継続することができます（8日目で実装）。また類似アラートをベクトル検索で取得し、過去の対応事例をコンテキストとして活用することで、より適切な分析が可能になります（21日目で実装）。

## listコマンド

`list`コマンドは登録されているアラートの一覧を表示するコマンドです。

```bash
$ leveret list
$ leveret list -a  # マージ済みも含めて表示
```

Firestoreから全アラートを取得し、ID、タイトル、作成日時、要約を表示します。デフォルトでは既にマージ済みのアラートは除外されますが、`-a`オプションを指定することでマージ済みのアラートも含めて全件表示することができます。これによりアラートの全体像を把握したり、過去の対応履歴を確認したりすることができます。

## resolveコマンド

`resolve`コマンドは分析が完了したアラートを解決状態にするコマンドです。

```bash
$ leveret resolve <alert-id>
```

指定されたIDのアラートに対して、分析結果の結論を記録してアラートを解決状態にします。解決時には「影響のあるアラートだった」「誤検知だった」などの記録を残すことができ、後から参照することが可能です。

## mergeコマンド

`merge`コマンドは類似するアラートを統合するコマンドです。

```bash
$ leveret merge <source-alert-id> <target-alert-id>
```

`source-alert-id`で指定したアラートを`target-alert-id`で指定したアラートに統合します。実態としては`MergedTo`フィールドに統合先IDを設定します。マージされたアラートは以降`list`コマンドで表示されなくなります。

## unmergeコマンド

`unmerge`コマンドは誤ってマージしたアラートを元に戻すコマンドです。

```bash
$ leveret unmerge <alert-id>
```

指定されたIDのアラートのマージを解除し、再び独立したアラートとして扱えるようにします。`MergedTo`フィールドをクリアすることで、`list`コマンドでも再び表示されるようになります。

# 開発フロー：ビルド、実行、デバッグ

## ビルド

プロジェクトルートで以下のコマンドを実行することで、実行可能ファイルをビルドできます。

```bash
$ cd leveret
$ go build -o leveret
```

ビルドが成功すると、カレントディレクトリに実行可能ファイル `leveret` が生成されます。このファイルを実行することで、後述するサブコマンドを利用できるようになります。

## 実行

ビルドした実行ファイルを直接実行できます。`--help`オプションを付けることで、利用可能なコマンドの一覧を確認できます。

```bash
$ ./leveret --help
NAME:
   leveret - Security alert analysis agent

USAGE:
   leveret [global options] command [command options] [arguments...]

COMMANDS:
   new      Create a new alert from JSON input
   chat     Interactive analysis of an alert
   list     List all alerts
   help, h  Shows a list of commands or help for one command

GLOBAL OPTIONS:
   --help, -h  show help
```

またビルドせずに `go run` で直接実行することもできます。開発中の動作確認ではこちらの方が手軽です。

```bash
$ go run . --help
```

## デバッグ

### VS Codeでのデバッグ

VS Codeを使用している場合、デバッグ設定を追加することでブレークポイントを設定したデバッグ実行が可能になります。プロジェクトルートに `.vscode/launch.json` を作成し、以下の設定を追加してください。

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Debug leveret",
            "type": "go",
            "request": "launch",
            "mode": "debug",
            "program": "${workspaceFolder}",
            "args": ["new", "-i", "testdata/alert.json"],
            "env": {
                "GOOGLE_CLOUD_PROJECT": "your-project-id"
            }
        }
    ]
}
```

この設定により、F5キーを押すだけでデバッグ実行が開始されます。ブレークポイントを設定して変数の値を確認したり、ステップ実行で処理の流れを追ったりすることができます。

### ログ出力によるデバッグ

より手軽なデバッグ方法として、ログ出力を活用することもできます。標準的な `log` パッケージや構造化ログライブラリ（例: [slog](https://pkg.go.dev/log/slog)）を使用してデバッグ情報を出力することで、実行時の状態を確認できます。

```go
import "log/slog"

func (uc *UseCase) CreateAlert(ctx context.Context, data []byte) error {
    slog.Info("creating alert", "data_size", len(data))
    // ...
}
```

構造化ログを使うことで、後からログを解析しやすくなり、本番環境でのトラブルシューティングにも役立ちます。

### テストの実行

開発中はユニットテストを実行してコードの動作を確認することも重要です。Goの標準テストツールを使って、以下のようにテストを実行できます。

```bash
$ go test ./...
```

このコマンドはプロジェクト内の全パッケージのテストを実行します。特定のパッケージのみテストしたい場合は、パッケージのパスを指定します。

```bash
$ go test ./pkg/usecase
```

テストの詳細な出力が必要な場合は、`-v`オプションを付けることで、各テストケースの実行結果を確認できます。

```bash
$ go test -v ./...
```

# まとめ

今回は開発環境のセットアップとプロジェクト構造の理解を進めました。以下の準備が整いました。

- Go開発環境のセットアップ
- Google Cloud（Firestore、Cloud Storage、Vertex AI）の設定
- `leveret` プロジェクトの取得と構造理解

`init` ブランチには最小限の骨組みが用意されています。明日以降、この骨組みに機能を追加していきます。まずはGemini APIとの統合から始め、アラート要約機能を実装します。

開発環境が整ったので、次回からは実際にコードを書いていきましょう。LLMとの対話、ツール呼び出し、ポリシー処理など、エージェントの中核機能を段階的に実装していきます。

