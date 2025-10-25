---
title: "会話履歴の管理基盤"
emoji: "💬"
type: "tech"
topics: ["LLM", "SQLite", "database", "conversation"]
published: false
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の7日目です。今回は生成AIエージェントで実現されている「会話」機能と、その履歴の管理方法について解説します。

# 生成AIにおける「会話」とは

- まずは生成AIにおいて会話とはなにか整理する
  - Gemini、ChatGPT、Claudeなどで対話的に処理をしている
  - これはどのように状態が管理されているのか
- GeminiのSDKをみてみる
  - Chatという構造体が用意されており、これをつかって簡単に会話が再現できる
  - では実際に何をやっているのか見てみよう
  - https://github.com/googleapis/go-genai/blob/v1.32.0/chats.go#L174-L181
  - ユーザ入力だけを受け取り、Sendというメソッドを呼び出している
  - Sendはこちらが実態 https://github.com/googleapis/go-genai/blob/v1.32.0/chats.go#L184-L204

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

まずユーザからの入力を `RoleUser` からの入力として `Content` へ変換

```go
	inputContent := &Content{Parts: parts, Role: RoleUser}
```

これをChat構造体の中に持っていた `history` とくっつける

```go
	contents := append(c.curatedHistory, inputContent)
```

でこれを使ってそのまま `GenerateContent` を呼び出すだけ

```go
	modelOutput, err := c.GenerateContent(ctx, c.model, contents, c.config)
```

あとはその結果をまたHistoryとして追加しているのみ

- つまりLLMにおける会話とは、履歴と最新の入力を全部くっつけて投げつけているだけ
  - これによって、都度それまでのやりとり、流れを読み込ませることで、「会話」を再現している
  - そもそもLLMは状態をもたない
- 注意点
  - 会話が継続するほど履歴が積み重なっていく。つまり入力するトークンも累積和となる
  - これによって課金も膨れ上がっていく（ほとんどの生成AIサービスは入力・出力のトークン量に対する従量課金）
  - またコンテキストウィンドウの限界に達しやすくなる
    - これはcompactionというテクニックで回避・緩和できる。詳しくは後日

# 会話履歴の管理

- geminiのChat構造体のようなものを使えば比較的容易に再現できるが、オンメモリにした状態をもたないのが問題
- 今回はCLIツールだがオンラインシステムだと難しい
  - 同じランタイムが常に応答するとは限らない
    - スケールアウト・並列化のようなアーキテクチャでどれにあたるかわからないとか
    - サーバレス構成でそもそもランタイム・インスタンスが切り替わってしまう可能性があるとか
  - 長時間メモリに保持しておくのはコストが高い
- そのためオンラインシステムの場合はどこかに履歴を退避させるのがよい

## データ構造

- geminiのデータ構造を見てみよう
- https://github.com/googleapis/go-genai/blob/v1.32.0/types.go#L1059-L1067

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

- データ構造自体はめちゃくちゃシンプル
- `Role` システムとユーザのどっちが言ったことか？ っていうのを示す情報
  - プロバイダによって異なるが、Geminiでは `user` or `model` (生成AI側)
- `Parts` は送受信されたデータの実体
  - テキストだけでなく、画像データや音声・動画データを扱える
  - またツール実行命令・結果を示すようなものも含まれる。これは後日説明する
- ということでこれを再現できるのであればどのような保存形式でも良い

## 会話履歴の保存戦略

- データ形式としては非常にシンプルだが問題はデータサイズ
- 例えばGemini 2.5では1,000,000トークンまでを許容する
- トークン数から正確なデータサイズを算出は難しい
  - トークン＝単語などなので、入力するものによって大きくブレる
  - それでも一般的には、例えば英語の文章だと1トークン平均4文字＝4バイト程度と言われる
- これを元に計算すると最大で数メガバイトのレコードを抱えることになる
  - しかもそれらの殆どは一時的で後から利用しない
- こういったユースケースを元にどうデータを保持するか

### スキーマ化してDBに保存する

- シンプルに全部RDBMSなどに突っ込む
  - 1レコード1Contentとする前提
- Pros
  - 構成がシンプルになる
  - 過去データから自由に会話履歴を再編しやすい
    - 例えば常に直近100件から会話履歴を生成みたいなことが（やろうと思えば）できる
- Cons
  - DBのストレージは比較的高価なのでもったいない
    - 特に殆どの会話履歴はあとから使わない
  - 会話履歴の再構成が若干複雑な処理になる
    - 例えば1つの会話を元に同時に複数の会話が走ったりすると難しいことになる
    - DB自体が状態を管理する箱になり考慮事項が多い

### データ全体をオブジェクトストレージなどに保存する

- 会話履歴をJSONなどの構造データにしてえいやでオブジェクトストレージへ保存
- 今回のアドベントカレンダーではこちらを採用している
- Pros
  - コストが安い
    - オブジェクトストレージ自体が安い
    - さらに古いデータの利用頻度が少なければオブジェクトストレージのクラスを変更してさらにコスト圧縮可能
    - これによってRDBに比べて数倍〜数十倍のコスト圧縮が見込める
  - 書き込み、読込自体はシンプル
    - marshal / unmarshalしたものを突っ込んで取り出してとすればいいだけなのでシンプル
- Cons
  - 構成はやや複雑
    - まじめにやるならDB側にメタデータを置く必要がある
    - 今の会話一覧とその会話がどのオブジェクトデータを指しているのかみたいな管理が必要
  - 細かい処理は難しい
    - 例えば検索とかはあまり期待できない
    - やるならDB側にそういうデータを持つ必要があるけどまあまあ大変

# 実装

## チャット機能

- まず、チャット機能を実装する
- わかりやすさのためChatを使わずにベタ書きで実装する
- まずはSessionの生成

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

- `repo`, `gemini`, `storage` は外部とのやりとりのためのインターフェース
- このツールはalertを分析するためのものなので、まず最初にrepository (DB) からアラートのデータを取得する
  - IDが `input` から最初に渡される
- これらのデータを元にしたSessionが生成される

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

- その後、ユーザーからの入力を送信して生成AIからの応答をもらう `Send` を実装する
- `pkg/cli/chat.go` に入力をループする機能があるのでそこで入力を繰り返す
  - ここは本質ではないあまり触れないけど、お好みでいろいろ変えてね
- geminiのSDKと同様に同じSessionを使い続ける限りHistoryがオンメモリに存在し、会話が維持される


例
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

## 会話履歴の保存

- このままだと終了した段階で会話履歴が失われる
- そのため永続ストレージに保存する。今回はCloud Storageを使う
  - ファイルシステムでいもいいが、firestoreに合わせてクラウドにした

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

- シンプルにcloud storageとfirestoreから読み書きするコード
  - 一貫性はないので、cloud storageにだけ書き込まれるという状況はありえる
    - がまあええやろ
- 一度の送信ごとに毎回異なるオブジェクトを生成する
  - debug目的ではまずこっちのほうがよい
    - ただし本番運用の場合は大量のオブジェクトが生成されるので注意
  - keyの設計もシンプルにしてある
    - ディレクトリからブラウズする可能性があるならalertIDをprefixに含めたり、日付を入れたりなどの工夫はある
    - このあたりは要件次第で
- さらに pkg/adapter/storage.go にデバッグ用のログを仕込んでおく

```go:pkg/adapter/storage.go
func (s *storageClient) Put(ctx context.Context, key string) (io.WriteCloser, error) {
    // 中略
	logging.From(ctx).Info("saving to Cloud Storage", "bucket", s.bucketName, "path", objectKey)
```

これで実行してみる

```shell
Chat session started. Type 'exit' to quit.

> こんにちは

⠦ thinking...11:48:59 INFO saving to Cloud Storage bucket="<your-bucket>" path="leveret-dev/histories/5d2f3a8b-5498-4a8e-9611-9a96f71379fd.json"
こんにちは！

AWS GuardDuty からのセキュリティアラートについてご質問がありますか？

提示されたデータは、EC2インスタンスがマルウェアによって盗まれた情報が保存されている既知のドメインにクエリを実行していることを示すものです。

具体的な質問があれば、お気軽にお尋ねください。
```

そうしたらデータを取得してみる

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

このとおり保存されていることがわかる。

## ヒストリ一覧の表示

- これだけだとhistory IDを覚えておかないといけないので一覧を表示する
- alertIDを指定すると、そのヒストリ一覧を表示するやつ

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

これによって

```shell
$ go run . history -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981
5d2f3a8b-5498-4a8e-9611-9a96f71379fd            2025-10-25 02:48:59     2025-10-25 02:48:59
b8a2a293-d92b-4803-b545-7e5ab0fd6130            2025-10-25 02:48:28     2025-10-25 02:48:28
```

- ただしこれだとどれがどんな履歴がわからない
- そこでタイトルを生成AIで自動的につけるようにする

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

こういう関数を用意して

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

こんな感じでタイトルをセットします。

```bash
$ go run . chat -i ea6cb2ef-5ba2-4243-87bf-5bf8d6217981                  13.5s  Sat Oct 25 12:08:31 2025

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

- という感じでタイトルが取れます
- 日本語にしたかったり、タイトルの長さをある程度制御したかったらプロンプトで指示するといいよ

# まとめ
