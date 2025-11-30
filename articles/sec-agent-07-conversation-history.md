---
title: "Goで作るセキュリティ分析LLMエージェント(7): 会話と履歴の管理"
emoji: "💬"
type: "tech"
topics: ["ai", "go", "llm"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の7日目です。今回はLLMエージェントで実現されている「会話」機能と、その履歴の管理方法について解説します。今回のコードは https://github.com/m-mizutani/leveret の [day07-conversation-history](https://github.com/m-mizutani/leveret/tree/day07-conversation-history) ブランチに格納されていますので適宜参照してください。

# LLMにおける「会話」とは

ChatGPT、Claude、GeminiといったWebベースのLLMサービスを利用する際、ユーザは対話的にやりとりしながら目的の情報を引き出していきます。人間同士の会話のように、前の質問への回答を踏まえた上で次の質問ができます。しかし、生成AI自体は本質的にステートレスであり、入力されたテキストに対して応答を返すだけの仕組みです。では、この「会話」という機能はどのように実現されているのでしょうか。

仕組みを理解するため、[Gemini SDKの実装](https://github.com/googleapis/go-genai/blob/v1.32.0/chats.go#L174-L181)を見てみます。Gemini SDKには `Chat` という構造体が用意されており、この構造体を利用することで簡単に会話を再現できます。ユーザからの入力を受け取って `Send` メソッドを呼び出すだけで、前のやりとりを踏まえた応答が得られます。では、この `Send` メソッドは内部でどのような処理を行っているのでしょうか。[実装](https://github.com/googleapis/go-genai/blob/v1.32.0/chats.go#L184-L204)を確認してみましょう。

```go
func (c *Chat) Send(ctx context.Context, parts ...*Part) (*GenerateContentResponse, error) {
	inputContent := &Content{Parts: parts, Role: RoleUser}

	// Combine history with input content to send to model
	contents := append(c.curatedHistory, inputContent)

	// Generate Content
	modelOutput, err := c.GenerateContent(ctx, c.model, contents, c.config)
	if err != nil {
		return nil, err
	}

	// Record history. By default, use the first candidate for history.
	var outputContents []*Content
	if len(modelOutput.Candidates) > 0 && modelOutput.Candidates[0].Content != nil {
		outputContents = append(outputContents, modelOutput.Candidates[0].Content)
	}
	c.recordHistory(ctx, inputContent, outputContents, validateResponse(modelOutput))

	return modelOutput, err
}
```

このコードを順に見ていきます。まず、ユーザからの入力を `RoleUser` として `Content` に変換します。次に、Chat構造体が保持している会話履歴 `curatedHistory` と、今回の入力をまとめます。そして、この履歴と入力を含めた全てのコンテンツを使って `GenerateContent` を呼び出します。最後に、生成された応答を会話履歴に追加して次回以降の呼び出しに備えます。

つまり、LLMにおける会話とは、過去の履歴と最新の入力を全て結合してLLMに投げているだけです。これによって、都度それまでのやりとりの流れを読み込ませることで「会話」を再現しています。そもそもLLM自体は状態を持たないため、このような仕組みが必要になります。

具体的な例で説明すると、たとえば以下のような会話を想定します。

- ユーザ: 「フランスの首都は？」
- AI: 「パリです」
- ユーザ: 「その人口は？」

この3回目の質問「その人口は？」だけを見ると、「その」が何を指しているのか分かりません。しかし、過去の履歴を含めて送信することで、生成AIは「その」がパリを指していることを理解できます。実際には以下のようなデータが送信されます。

```json
[
  {"role": "user", "parts": [{"text": "フランスの首都は？"}]},
  {"role": "model", "parts": [{"text": "パリです"}]},
  {"role": "user", "parts": [{"text": "その人口は？"}]}
]
```

このように、全ての会話履歴を含めることで、生成AIは文脈を理解した応答を返せます。

ただし、この仕組みにはいくつか注意点があります。まず、会話が継続するほど履歴が積み重なっていくため、入力するトークン数も累積和として増加します。ほとんどのLLMサービスは入力・出力のトークン量に対する従量課金であるため、会話が長くなるほど課金額も膨れ上がります。

また、コンテキストウィンドウの限界に達しやすくなるという問題もあります。コンテキストウィンドウとは、LLMが一度に処理できるトークン数の上限のことです。たとえばGemini 2.5 Flashでは1,000,000トークンというコンテキストウィンドウを持ちますが、これは入力と出力の合計です。会話が長くなるほど入力トークン数が増え、この上限に達しやすくなります。上限を超えると、古い履歴を削除するか、会話を分割する必要があります。これらの問題はcompactionというテクニックで回避・緩和できますが、詳しくは後日解説します。

# 会話履歴の管理

GeminiのChat構造体のような仕組みを使えば、会話機能は比較的容易に再現できます。しかし、オンメモリで状態を保持する方式には問題があります。

今回実装しているツールはCLIアプリケーションですが、学習目的でオンラインシステムとしての実装を想定して考えてみましょう。オンラインシステムでは、同じランタイムが常に応答するとは限りません。オンメモリで状態を保持する方式には以下のような問題があります。

- **スケールアウト・並列化**: リクエストごとにどのインスタンスが処理するか分からないため、メモリ上の状態を共有できません
- **サーバレス構成**: ランタイムやインスタンス自体が切り替わってしまう可能性があります
- **リソースコスト**: 長時間メモリに保持しておくのはリソース的にもコストが高くなります

そのため、会話履歴をどこかに永続化して退避させる仕組みが必要です。

## データ構造

まず、会話履歴として保存すべきデータの構造を確認します。[Geminiのデータ構造](https://github.com/googleapis/go-genai/blob/v1.32.0/types.go#L1059-L1067)を見てみます。

```go
type Content struct {
	// Optional. List of parts that constitute a single message. Each part may have
	// a different IANA MIME type.
	Parts []*Part `json:"parts,omitempty"`
	// Optional. The producer of the content. Must be either 'user' or
	// 'model'. Useful to set for multi-turn conversations, otherwise can be
	// empty. If role is not specified, SDK will determine the role.
	Role string `json:"role,omitempty"`
}
```

データ構造自体は非常にシンプルです。`Role` フィールドは、コンテンツの発信者がシステムとユーザのどちらなのかを示す情報です。プロバイダによって異なりますが、Geminiでは `user` または `model`（生成AI側）のいずれかを指定します。

`Parts` フィールドは送受信されたデータの実体を保持します。テキストだけでなく、画像データや音声・動画データも扱えます。また、ツール実行命令や結果を示すデータも含まれますが、これらについては後日説明します。

このように、会話履歴のデータ構造は非常にシンプルです。この構造を再現できるのであれば、どのような保存形式でも対応可能です。

## 会話履歴の保存戦略

データ形式としては非常にシンプルですが、問題はデータサイズです。たとえばGemini 2.5では最大1,000,000トークンまでを許容します。トークン数から正確なデータサイズを算出するのは難しいのですが、トークンは単語などの単位であり、入力するものによって大きくブレます。それでも一般的には、英語の文章であれば1トークンあたり平均4文字程度、バイト数にすると英語のASCII文字であれば4バイト程度と言われています。

これを元に計算すると、最大で数メガバイトのレコードを抱えることになります。しかもこれらのデータの大部分は一時的なもので、後から利用されることはありません。このようなユースケースを考慮して、会話履歴をどのように保持するかを検討する必要があります。

### スキーマ化してDBに保存する

1つ目の選択肢は、会話履歴をRDBMSなどのデータベースに保存する方法です。1レコード1Contentとして管理します。

この方法の利点は、構成がシンプルになることです。また、過去データから自由に会話履歴を再編しやすくなります。たとえば、常に直近100件から会話履歴を生成するといった柔軟な運用も可能です。

一方で、欠点もあります。データベースのストレージは比較的高価であり、特に大部分の会話履歴が後から使われないことを考えるともったいないと言えます。また、会話履歴の再構成が若干複雑な処理になります。たとえば1つの会話を元に同時に複数の会話が走ったりすると、管理が難しくなります。データベース自体が状態を管理する箱となり、考慮事項が増えてしまいます。

### データ全体をオブジェクトストレージなどに保存する

2つ目の選択肢は、会話履歴をJSONなどの構造化データにしてオブジェクトストレージへ保存する方法です。今回のアドベントカレンダーではこちらを採用しています。

この方法では、会話履歴を2つに分けて管理します。会話のメタデータ（ID、タイトル、作成日時、更新日時など）はデータベースに保存し、実際の会話内容（`Content` の配列）はオブジェクトストレージに保存します。データベースには軽量なメタデータのみを保持し、サイズの大きい会話内容は安価なオブジェクトストレージに退避させることで、コストと検索性のバランスを取ります。

この方法の利点は、コストが安いことです。オブジェクトストレージ自体が安価であり、さらに古いデータの利用頻度が少なければストレージクラスを変更することでさらにコスト圧縮が可能です。これによって、RDBに比べて数倍から数十倍のコスト削減が見込めます。また、書き込みと読み込み自体はシンプルです。JSONにエンコード・デコードしたものを保存・取り出しするだけで済みます。

一方で、欠点もあります。構成はやや複雑になります。データベース側のメタデータとオブジェクトストレージ側の実データを同期させる必要があり、両方の整合性を保つ仕組みが必要です。また、会話内容に対する細かい処理は難しくなります。たとえば会話内容の全文検索などはあまり期待できません。検索を実現するならデータベース側にそういったデータを持つ必要がありますが、実装はそれなりに大変です。このあたりは要件に応じて検討をする必要があります。今回はAlertIDでのみ検索することを想定します。

# 実装

## チャット機能

まず、チャット機能を実装します。わかりやすさのため、Gemini SDKの `Chat` 構造体を使わずにベタ書きで実装していきます。

最初に、チャットセッションを表す `Session` 構造体を生成します。

```go:pkg/usecase/chat/session.go
type Session struct {
	repo    repository.Repository
	gemini  adapter.Gemini
	storage adapter.Storage

	alertID model.AlertID
	alert   *model.Alert
	history *model.History
}

func New(ctx context.Context, input NewInput) (*Session, error) {
	alert, err := input.Repo.GetAlert(ctx, input.AlertID)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to get alert")
	}

	return &Session{
		repo:    input.Repo,
		gemini:  input.Gemini,
		storage: input.Storage,

		alertID: input.AlertID,
		alert:   alert,
		history: &model.History{},
	}, nil
}
```

`repo`、`gemini`、`storage` は外部とのやりとりのためのインターフェースです。このツールはアラートを分析するためのものなので、まず最初にリポジトリ（データベース）からアラートのデータを取得します。アラートのIDは `input` から渡されます。これらのデータを元にしてSessionが生成されます。なお、`history` フィールドには空の `model.History` を設定しています。これは新規の会話を開始する場合です。既存の会話を継続する場合は、後述する `loadHistory` 関数で履歴を読み込んで設定します。

```go
func New(ctx context.Context, input NewInput) (*Session, error) {
	alert, err := input.Repo.GetAlert(ctx, input.AlertID)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to get alert")
	}

	var history *model.History
	if input.HistoryID != nil {
		// Load existing history
		history, err = loadHistory(ctx, input.Repo, input.Storage, *input.HistoryID)
		if err != nil {
			return nil, goerr.Wrap(err, "failed to load history")
		}
	} else {
		// Create new history
		history = &model.History{}
	}
```

次に、ユーザからの入力を送信してLLMからの応答をもらう `Send` メソッドを実装します。

```go
func (s *Session) Send(ctx context.Context, message string) (*genai.GenerateContentResponse, error) {
	// Build system prompt with alert data
	alertData, err := json.MarshalIndent(s.alert.Data, "", "  ")
	if err != nil {
		return nil, goerr.Wrap(err, "failed to marshal alert data")
	}

	systemPrompt := "You are a helpful assistant. When asked about the alert, refer to the following data:\n\nAlert Data:\n" + string(alertData)

	// Add user message to history
	userContent := genai.NewContentFromText(message, genai.RoleUser)
	s.history.Contents = append(s.history.Contents, userContent)

	// Generate response
	config := &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText(systemPrompt, ""),
	}

	resp, err := s.gemini.GenerateContent(ctx, s.history.Contents, config)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to generate content")
	}

	// Add assistant response to history
	if len(resp.Candidates) > 0 && resp.Candidates[0].Content != nil {
		s.history.Contents = append(s.history.Contents, resp.Candidates[0].Content)
	}

	return resp, nil
}
```

この `Send` メソッドでは、いくつか重要な処理を行っています。

まず、システムプロンプトを構築します。システムプロンプト（`SystemInstruction`）は、LLMに対して全体的な指示や文脈を与えるためのもので、会話全体を通じて一貫して参照されます。ここではアラートデータをJSON形式で含めることで、LLMがアラートに関する質問に答えられるようにしています。

次に、ユーザからのメッセージを `RoleUser` として会話履歴に追加します。そして、会話履歴全体を `GenerateContent` に渡して応答を生成します。最後に、生成された応答を会話履歴に追加します。このサイクルを繰り返すことで、会話が維持されます。

[pkg/cli/chat.go](https://github.com/m-mizutani/leveret/blob/main/pkg/cli/chat.go)には入力をループする機能があり、そこでユーザからの入力を繰り返し受け付けます。この部分は本質ではないため詳しく触れませんが、お好みで変更可能です。

Gemini SDKと同様に、同じSessionを使い続ける限り、Historyがオンメモリに存在し、会話が維持されます。

実際に動かしてみます。以下は、GuardDutyのアラートについて会話する例です。
```shell
$ go run . chat -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981

Chat session started. Type 'exit' to quit.

> こんにちは

こんにちは！何かお手伝いできることはありますか？

AWS GuardDutyのアラートについて、何かご質問がありましたらお気軽にお尋ねください。

> 端的に説明して

はい、承知いたしました。

このアラートは、あなたのAWSアカウント `783957204773` で稼働している **EC2インスタンス `i-11111111` が、マルウェアによって認証情報などの盗まれたデータを収集・保管するために使わ
れる既知の不正ドメイン (`3322.org`) にDNSクエリを発行した**ことを示しています。

これは**深刻度が高い（8/10）脅威**であり、EC2インスタンスがマルウェアに感染している可能性や、機密情報が流出している可能性を強く示唆しています。

**要するに：** あなたのEC2インスタンスが、マルウェアの「情報収集拠点」と通信している可能性があり、早急な調査と対処が必要です。
```

この例では、2回目の質問「端的に説明して」が1回目の会話の文脈を踏まえて解釈されています。もし会話履歴がなければ、「何を端的に説明するのか」が分からないはずですが、履歴を含めることで生成AIは1回目の挨拶から続く会話の流れを理解し、アラートについての説明を求められていると解釈しています。なお、1回目の「こんにちは」という挨拶に対してアラートに関する応答が返されているのは、システムプロンプトにアラートデータが含まれているためです。

## 会話履歴の保存

前述のオンラインシステムでの要件を満たすため、会話履歴を永続ストレージに保存する必要があります。今回はCloud Storageを使用します。ファイルシステムでも良いのですが、メタデータ管理用のFirestoreに合わせてクラウドストレージを選択しました。

会話履歴の読み込みと保存を行う関数を実装します。

```go:pkg/usecase/chat/history.go
// loadHistory loads conversation history from Cloud Storage and repository
func loadHistory(ctx context.Context, repo repository.Repository, storage adapter.Storage, historyID model.HistoryID) (*model.History, error) {
	// Get history metadata from repository
	history, err := repo.GetHistory(ctx, historyID)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to get history from repository")
	}

	// Load conversation contents from Cloud Storage
	reader, err := storage.Get(ctx, "histories/"+string(historyID)+".json")
	if err != nil {
		return nil, goerr.Wrap(err, "failed to get history from storage")
	}
	defer reader.Close()

	data, err := io.ReadAll(reader)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to read history data")
	}

	var contents []*genai.Content
	if err := json.Unmarshal(data, &contents); err != nil {
		return nil, goerr.Wrap(err, "failed to unmarshal history contents")
	}

	history.Contents = contents
	return history, nil
}

// saveHistory saves conversation history to Cloud Storage and repository
func saveHistory(ctx context.Context, repo repository.Repository, storage adapter.Storage, alertID model.AlertID, history *model.History) error {
	// Generate new history ID if not exists
	if history.ID == "" {
		history.ID = model.NewHistoryID()
		history.AlertID = alertID
		history.CreatedAt = time.Now()
	}
	history.UpdatedAt = time.Now()

	// Save contents to Cloud Storage
	writer, err := storage.Put(ctx, "histories/"+string(history.ID)+".json")
	if err != nil {
		return goerr.Wrap(err, "failed to create storage writer")
	}
	defer writer.Close()

	data, err := json.Marshal(history.Contents)
	if err != nil {
		return goerr.Wrap(err, "failed to marshal history contents")
	}

	if _, err := writer.Write(data); err != nil {
		return goerr.Wrap(err, "failed to write history to storage")
	}

	if err := writer.Close(); err != nil {
		return goerr.Wrap(err, "failed to close storage writer")
	}

	// Save metadata to repository
	if err := repo.PutHistory(ctx, history); err != nil {
		return goerr.Wrap(err, "failed to put history to repository")
	}

	return nil
}
```

この実装では、先ほど説明したメタデータとコンテンツの分離戦略を採用しています。`loadHistory` では、まずリポジトリ（Firestore）からメタデータを取得し、次にCloud Storageから会話内容を取得して結合します。`saveHistory` では逆に、Cloud Storageへ会話内容を保存してから、リポジトリへメタデータを保存します。

厳密なトランザクション処理は行っていないため、Cloud Storageにだけ書き込まれてFirestoreへの書き込みが失敗するという状況もありえますが、今回は許容することとします。実際の開発では、両方の書き込みが成功したことを確認する仕組みや、失敗時のリトライ処理を追加することも検討するのがよいでしょう。

一度の送信ごとに、同じ会話IDのオブジェクトを上書きします。つまり、会話履歴は常に最新の状態のみが保存されます。この方式はシンプルで管理しやすい反面、過去のバージョンを参照できないというトレードオフがあります。もし会話の変遷を追跡したい場合は、オブジェクトストレージのバージョニング機能を有効化するか、オブジェクトキーにタイムスタンプを含める設計に変更することを検討してください。

オブジェクトキーの設計もシンプルにしています。ディレクトリからブラウズする可能性があるならアラートIDをプレフィックスに含めたり、日付を入れたりといった工夫が考えられますが、このあたりは要件次第です。

さらに、[pkg/adapter/storage.go](https://github.com/m-mizutani/leveret/blob/main/pkg/adapter/storage.go)にデバッグ用のログを追加します。

```go:pkg/adapter/storage.go
func (s *storageClient) Put(ctx context.Context, key string) (io.WriteCloser, error) {
    // 中略
	logging.From(ctx).Info("saving to Cloud Storage", "bucket", s.bucketName, "path", objectKey)
```

これで実行してみます。

```shell
Chat session started. Type 'exit' to quit.

> こんにちは

⠦ thinking...11:48:59 INFO saving to Cloud Storage bucket="<your-bucket>" path="leveret-dev/histories/5d2f3a8b-5498-4a8e-9611-9a96f71379fd.json"
こんにちは！

AWS GuardDuty からのセキュリティアラートについてご質問がありますか？

提示されたデータは、EC2インスタンスがマルウェアによって盗まれた情報が保存されている既知のドメインにクエリを実行していることを示すものです。

具体的な質問があれば、お気軽にお尋ねください。
```

ログにCloud Storageへの保存が記録されていることが確認できます。次に、実際に保存されたデータを取得してみます。

```shell
gcloud storage cat gs://<your-bucket>/leveret-dev/histories/5d2f3a8b-5498-4a8e-9611-9a96f71379fd.json | jq
[
  {
    "parts": [
      {
        "text": "こんにちは"
      }
    ],
    "role": "user"
  },
  {
    "parts": [
      {
        "text": "こんにちは！\n\nAWS GuardDuty からのセキュリティアラートについてご質問がありますか？\n\n提示されたデータは、EC2インスタンスがマルウェアによって盗まれた情報が保
存されている既知のドメインにクエリを実行していることを示すものです。\n\n具体的な質問があれば、お気軽にお尋ねください。"
      }
    ],
    "role": "model"
  }
]
```

このとおり、会話履歴が正しく保存されていることが確認できます。保存されたJSONは、ユーザの入力とモデルの応答が交互に配列として格納されています。`role` フィールドで発信者を識別し、`parts` フィールドに実際のテキストが含まれています。このシンプルな構造によって、会話の流れを完全に再現できます。

## ヒストリ一覧の表示

会話履歴を再開する際にhistory IDを毎回覚えておくのは不便なため、一覧を表示する機能を実装します。アラートIDを指定すると、そのアラートに関連する会話履歴の一覧を表示します。

```go:pkg/cli/history.go
// List histories
histories, err := repo.ListHistoryByAlert(ctx, model.AlertID(alertID))
if err != nil {
    return goerr.Wrap(err, "failed to list histories")
}

// Display histories
if len(histories) == 0 {
    fmt.Fprintf(c.Root().Writer, "No conversation histories found for alert %s\n", alertID)
    return nil
}

for _, h := range histories {
    fmt.Fprintf(c.Root().Writer, "%s\t%s\t%s\t%s\n",
        h.ID,
        h.Title,
        h.CreatedAt.Format("2006-01-02 15:04:05"),
        h.UpdatedAt.Format("2006-01-02 15:04:05"),
    )
}
```

これによって、以下のように会話履歴の一覧を表示できます。

```shell
$ go run . history -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981
5d2f3a8b-5498-4a8e-9611-9a96f71379fd            2025-10-25 02:48:59     2025-10-25 02:48:59
b8a2a293-d92b-4803-b545-7e5ab0fd6130            2025-10-25 02:48:28     2025-10-25 02:48:28
```

ただし、IDと日時だけでは、過去の会話を探すときに不便です。そこで、タイトルを生成AIで自動的につけるようにします。会話の最初のユーザ入力からタイトルを生成することで、会話の内容を一目で把握できるようにします。

```go:pkg/usecase/chat/history.go
// generateTitle generates a short title from the first user message
func generateTitle(ctx context.Context, gemini adapter.Gemini, message string) (string, error) {
	prompt := "Generate a short title (max 50 characters) that summarizes the following question or topic. Return only the title, nothing else:\n\n" + message

	contents := []*genai.Content{
		genai.NewContentFromText(prompt, genai.RoleUser),
	}

	resp, err := gemini.GenerateContent(ctx, contents, nil)
	if err != nil {
		return "", goerr.Wrap(err, "failed to generate title")
	}

	if len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
		return "", goerr.New("no response from LLM")
	}

	var title strings.Builder
	for _, part := range resp.Candidates[0].Content.Parts {
		if part.Text != "" {
			title.WriteString(part.Text)
		}
	}

	// Trim whitespace and limit length
	return strings.TrimSpace(title.String()), nil
}
```

`generateTitle` 関数は、ユーザの最初のメッセージを受け取り、それを要約した短いタイトルをLLMに生成させます。プロンプトでは50文字以内という制約を与えていますが、確実に守られるとは限らないため、必要に応じて後処理でトリミングしています。

この関数を `Send` メソッド内で呼び出して、最初のユーザ入力からタイトルを生成します。

```go:pkg/usecase/chat/session.go
func (s *Session) Send(ctx context.Context, message string) (*genai.GenerateContentResponse, error) {
	// Generate title from first user input if this is a new history
	if len(s.history.Contents) == 0 {
		title, err := generateTitle(ctx, s.gemini, message)
		if err != nil {
			return nil, goerr.Wrap(err, "failed to generate title")
		}
		s.history.Title = title
	}
```

このように、会話の最初の入力からタイトルを自動生成してセットします。

```bash
$ go run . chat -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981

Chat session started. Type 'exit' to quit.

> このアラートのリスクについて簡単に説明して
# 以下略
```

```bash
$ go run . history -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981
6e6f461a-4630-4458-a943-8e1be9bbf60e    Alert Risk Summary      2025-10-25 03:09:17     2025-10-25 03:09:17
5d2f3a8b-5498-4a8e-9611-9a96f71379fd            2025-10-25 02:48:59     2025-10-25 02:48:59
b8a2a293-d92b-4803-b545-7e5ab0fd6130            2025-10-25 02:48:28     2025-10-25 02:48:28
```

このように、会話履歴にタイトルが付けられていることが確認できます。「Alert Risk Summary」というタイトルが自動生成され、会話の内容が一目で分かるようになっています。タイトルを日本語にしたり、長さをある程度制御したい場合は、プロンプトで指示することで調整できます。

なお、タイトル生成には追加のAPI呼び出しが発生するため、コストとレイテンシが増加します。トレードオフを考慮して、必要に応じてこの機能を無効化することも検討してください。

# まとめ

生成AIの会話は「履歴を全て含めて毎回送信する」という仕組みです。この仕組みを理解すれば、自分のシステムで会話をどこで区切るべきか、どの情報を履歴に含めるべきかが判断できるようになります。コストとコンテキストウィンドウの制約は会話の長さに対して累積的に効いてくるため、運用設計の段階から考慮する必要があります。また、履歴の管理はコンテキストウィンドウの調整観点でも重要な概念となるため、覚えておくと便利でしょう。

今回示したメタデータとコンテンツの分離や、Systemプロンプトの活用は、今後も利用する実用的なパターンです。会話履歴をどう管理するかは、エージェントの性能とコストを左右する設計判断であり、要件に応じて適切な戦略を選択することが重要です。
