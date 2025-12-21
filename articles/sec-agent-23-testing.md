---
title: "Goで作るセキュリティ分析LLMエージェント(23): エージェントのテスト"
emoji: "🧪"
type: "tech"
topics: ["go", "test", "ai"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の23日目です。今回はLLMエージェントの品質保証をするためのテストについてです。LLMエージェントに関する品質保証はまだ発展途上の議論であり、筆者もまだ最適なアプローチを模索中です。

この記事が本アドベントカレンダーにおける最後の実装に関する解説になります。今回のコードは https://github.com/m-mizutani/leveret の [day23-test](https://github.com/m-mizutani/leveret/tree/day23-test) ブランチに格納されていますので適宜参照してください。


# 非決定的なLLMエージェントにおけるテストの課題

LLMはこれまでにないパラダイムをもたらしました。厳密にロジックを定義しなくても曖昧な条件でも処理できるようになり、ソフトウェアエンジニアリングにおいて実現できることの幅が一気に広がりました。これまでのベストプラクティスやバッドノウハウがひっくり返り、全く新しい発想のアプリケーションも可能になりつつあります。

しかし同時に、これまでのパラダイムが通用しない部分も出てきています。特にLLMエージェントのテストは従来のソフトウェアテストとは異なる課題に直面します。本セクションでは、LLMエージェントをテストする際に直面する主要な3つの課題について説明します。

## 問題1: 出力が非決定的である

これまでのソフトウェアエンジニアリングの多くは決定性のあるロジックを前提に考えられていました。特に業務系アプリケーションではこの傾向が顕著で、テスト駆動開発のようなベストプラクティスも決定的な動作を前提としています。機械学習系のシステムでは以前から非決定的な動作は存在していましたが、推論時のランダムシードや学習データを固定すれば、多くの場合は決定的な挙動を再現できました。しかしLLMではこの非決定性がさらに広がり、同じ入力に対しても毎回異なる出力が返される可能性があります。LLMは非決定的に動作するため、テストの結果にどのような値が返されるかの不確実性が大きくなります。そのため値の完全一致を検証するタイプのテストとは相性が悪くなっています。回答方法を指定しても遵守されない場合があります。たとえば `yes` または `no` で答えるよう指示しているにもかかわらず、`maybe yes` のような回答が返されることがあります。こうした問題はスキーマを指定すれば一定程度解決できますが、スキーマを使用しない機能では対応が難しくなります。

不確実性を軽減する方法として temperature を 0、top-pを1 に設定するという手法があります。temperature は出力される文章のランダム性の強さを制御するパラメータであり、top-pは候補の確率の累積しきい値を指定するパラメータです。temperature が0、top-pが1の場合、回答はほぼ固定されます。しかし実際の本番環境ではこうした設定を行わないことが多く、不確実性があることを想定したテストが必要になります。

## 問題2: 評価基準が曖昧である

テストとは「実行によって得られた結果が期待される結果に収まっているか」を検証するものです。しかし「LLMからの結果」というものをどのように表現するべきかが難しい問題となります。期待する結果がテキストの場合、様々な表現のぶれが生じ得ます。たとえば「雪の色は何？」という質問の回答は「白」という意味が期待されますが、実際には「白です」「それは白です」「It's white」のように意味的には正しいものの、値として多様性が生じます。また「赤、青、黄、白」から選択するよう指示しても `"白"` や `**白**` のような余分な装飾が付加されるケースもあります。これらの出力は人間が見れば意図した回答が得られているとわかりますが、プログラムで機械的に検証するのは容易ではありません。単純な文字列比較では成功するテストケースも失敗と判定されてしまう可能性があります。

## 問題3: 実行されるユースケースが幅広すぎる

LLMエージェントでは、様々な状況、様々なデータ入力やツール実行が想定されます。ユーザがどのような入力を行い、どのような出力を期待しているかが極めて多様であるという問題があります。入力される内容の幅が広いだけでなく、期待値もユーザ自身のメンタルモデルに左右されます。

そのため、ある入力に対して検証を行ったとしても、それが十分であるかを判断することは困難です。わずかに異なる質問をするだけで、まったく異なる動作をする可能性が十分に存在します。したがって、総合的な品質を事前のテストのみで保証することは現実的ではありません。

# LLMエージェントの品質保証アプローチ

前セクションで述べたような課題がある中で、LLMエージェントの品質をどのように保証すればよいのでしょうか。本セクションではセキュリティ分析エージェントに限らず考えられるアプローチを紹介します。網羅的ではない可能性がありますが、筆者は現状、以下の4つの分類で整理しています。

## アプローチ1: LLMを使ったテスト評価

テストによって生成された内容を、別のコンテキストのLLMで評価する方法です。これは前セクションで述べた「評価基準が曖昧である」という問題に対する解決策の一つとなります。表記にぶれがあったとしても、期待される意味が含まれているかを確認できます。長文の評価であればEmbeddingを利用する方法も考えられます。

LLMを使った検証では、単純な値の一致だけでなく、より柔軟な基準での検証も可能になります。たとえば「この回答は以下に示すルールに従った内容を出力しているか？」といった検証や、モニタリング観点でスコアリングさせることもできます。

LLMに判定させる部分では、どのような内容に対してもスキーマ出力を利用できます。単語でも文章でも構造化データでも、これまで実施してきたようにJSON出力を指定してスキーマを設定できるため、テスト自体の記述も容易になります。これによってLLMが期待される回答を返しているかを検証できます。

デメリットは主に2つあります。1つ目はLLMを多重に使用することになるため、テストのレイテンシとコストの悪化が懸念される点です。ただしほとんどの場合、検証すべき項目は小規模であるため、レイテンシやコストの悪化は許容範囲に収まります。2つ目は結果検証を行うLLMの判定自体が誤る可能性も当然存在する点です(ただし後述するようにtemperature=0などの設定で一定程度緩和できます)。そのため一般的なリグレッションテスト(既存機能の後退を検出するテスト)と同等の精度は期待できませんが、そもそもLLMの挙動自体が非決定的であるため、この点は受け入れる必要があります。

## アプローチ2: タスクの振る舞い検証

タスクの行動に対していくつかのチェックポイントを用意してそれを検証する方法です。たとえばあるツールの呼び出しが発生したか、ツール呼び出し時に適切な引数が指定されたかなどをテスト検証項目とします。また最終的な結果についても期待した値が含まれているかどうかをチェックします。最終結果の検証については前述のアプローチ1と組み合わせることもできます。

ツールをモックなどに置き換えることで、呼び出し状況をカウントしたり、意図した値を注入することができます。あるいは専用のツールを作成して処理させる方法もあります。エージェント全体の呼び出し（実装例ではchat処理）を検証するのか、内部ワークフローのみを検証するのかなど、目的に応じて選択します。

このアプローチは全体的な品質を保証するというよりは、おおむね期待されたフローで動作しているかを検証する意味合いが強くなります。LLMそのものの動作を保証するというより、Plan & Executeのような複雑な動作が開発者の想定通りに実行されているかを検証します。

Plan & Execute のような全体の実行フロー制御は頻繁に変更が必要となります。特にLLMへのプロンプトを調整することが多くなります。そのため、プロンプトや実行フローを更新した際に、これまでの動作に大きな後退が発生していないかを確認するのに有効です。

## アプローチ3: ベンチマーク

ベンチマークは、決まった入力と期待される答えがあらかじめいくつか用意されており、それらを一通り実行することでタスクの完了精度を測る方法です。様々なシステムやモデルで使えるように汎化されているのが特徴です。たとえば学術分野では様々なベンチマークが提案されており、論文 "[AgentReview: Exploring Peer Review Dynamics with LLM Agents](https://aclanthology.org/2024.emnlp-main.70/)" のようにエージェントの性能評価フレームワークが研究されています。このフレームワークでは実際の学会論文(ICLR 2020-2023)を入力データとし、レビュアー・著者・エリアチェアのエージェントによる査読プロセスのシミュレーションを通じて、エージェントの振る舞いを評価しています。

研究分野などで標準化されたベンチマークがあればそれを使用することができます。ただしその場合、タスクは一般化されたものになっており、セキュリティ分析のような特定の業務に特化したベンチマークは現状ではほぼ存在していないと考えられます。独自にベンチマークを構築することも可能ですが、データセットの準備やメンテナンスにコストがかかります。

またベンチマークは、入力と出力が非常に明確なタスク(たとえばある学術問題の回答を得るようなもの)では有効に機能します。ただし問題を解く過程が一定以上複雑でないと差が生じにくいという側面もあります。どちらかというとモデル自体の性能評価に用いられることが多いという認識です。

## アプローチ4: 本番での実行に基づく評価

実際に本番環境で動作させたデータをもとに検証する手法です。いくつかのパターンがあります。

1つ目はトレースを取得する方法です。LLM実行に関する実行ログを詳細に保存して評価する手法で、LangChain系列では[LangSmith](https://www.langchain.com/langsmith/observability)が代表的です。他にも[DeepEval](https://www.confident-ai.com/blog/definitive-ai-agent-evaluation-guide)のようなツールも存在します。これらのツールを使用することで、本番環境でのエージェントの動作を詳細に観察し、問題が発生した場合に原因を特定しやすくなります。

2つ目はA/Bテストです。2つの回答を提示してどちらがより良い回答かをユーザ自身に判断させる方法で、ChatGPTのWebユーザ向けインターフェースなどで採用されています。ユーザからのフィードバックをもとに随時改善されていくため、継続的な品質向上が期待できます。ただし、一定規模のユーザ数とフィードバック量が必要となるため、小規模なシステムでは適用が困難な場合があります。

# セキュリティ分析エージェントのテスト方針

前セクションで4つのアプローチを紹介しましたが、今回構築しているセキュリティ分析エージェントにはどのアプローチが適しているのでしょうか。本セクションでは、システムの特性を踏まえて適切なテスト方針を検討します。

## システムの特性

今回構築しているセキュリティ分析エージェントは小規模に運用するツールです。すなわち、大量のトラフィックが発生するようなサービスではありません。そのため大規模なフィードバックを収集する手法には適していません。つまりアプローチ4で紹介したトレースやA/Bテストのような品質保証方法はあまり適さないと考えられます。

また、多大なコストをかけて整備するシステムでもありません。組織内の特定の人物が使用するシステムであり、不特定多数に提供するサービスではないため、自動化されたテストよりも人間によるフィードバックのほうが効果的な場合もあります。

一方で、タスクやワークフローは一定程度複雑です。コードで構築したロジック(Plan & Executeのような仕組み)については、新しい機能を追加したことによる副作用や後退が発生していないかを確認する必要があります。特にプロンプトの調整など、頻繁に変更が入る部分については、既存の動作が損なわれていないことを確認する必要があります。

## 採用するアプローチ

これらの要件を考慮すると、アプローチ2のタスクの振る舞い検証をアプローチ1のLLMを使ったテスト評価と組み合わせて実施するのが妥当であると筆者は判断しています。各アプローチの特徴を整理すると以下の通りです：

- **✅ アプローチ1（LLMによる評価）**: 回答内容の妥当性検証に有効だが、コストとレイテンシがかかる
- **✅ アプローチ2（振る舞い検証）**: ツール呼び出しや処理フローの検証に有効
- **❌ アプローチ3（ベンチマーク）**: 汎用的な性能評価には有効だが、特定業務向けには準備コストが高い
- **❌ アプローチ4（本番評価）**: 継続的改善には有効だが、小規模システムでは適用困難

アプローチ3のベンチマークも選択肢として考えられますが、都度実行するにはLLM実行コストが相応にかかります。またセキュリティ分析というタスクの性質を考えると、それに適したベンチマークを独自に整備する必要があり、メンテナンスコストも高くなります。商用のシステムであれば検討の余地がありますが、組織内で使用するツールとしては過剰な品質要求となります。

次のセクションでは、実際にどのようにテストを実装するかを見ていきます。

# テスト実装

前セクションで述べた方針に基づき、実際にテストを実装していきます。今回はアプローチ2のタスクの振る舞い検証とアプローチ1のLLMを使ったテスト評価を組み合わせた実装例を紹介します。実装は[pkg/usecase/chat/session_test.go](https://github.com/m-mizutani/leveret/blob/day23-test/pkg/usecase/chat/session_test.go)にあります。

## テスト用ツールの準備

テスト用のツールは[pkg/usecase/chat/testtools](https://github.com/m-mizutani/leveret/tree/day23-test/pkg/usecase/chat/testtools)ディレクトリに実装されています。これらは実際の外部APIを呼び出す代わりに、決まったデータを返すことでテストの再現性と安定性を確保します。

このツールのポイントは、エージェントが正しく動作すれば必ず正解にたどり着けるようにテストデータを設計することです。つまり、必要なツールを適切な順序で呼び出し、適切な引数を渡せば、明確な答えが得られるようなデータセットを用意します。またテスト用ツールでは、呼び出された引数を記録しておくことで、エージェントが適切な引数でツールを呼び出したかを検証できます。

たとえば `get_user_alerts` ツールは以下のように実装されています。

```go:pkg/usecase/chat/testtools/user_alerts.go
type getUserAlertsTool struct {
	callCount int
	userIDs   []string
}

func (t *getUserAlertsTool) CalledUserIDs() []string {
	return t.userIDs
}

func (t *getUserAlertsTool) Execute(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error) {
	t.callCount++

	userID, ok := fc.Args["user_id"].(string)
	if !ok {
		return nil, goerr.New("user_id argument is required")
	}
	t.userIDs = append(t.userIDs, userID)

	// ユーザIDに応じたデータを返す
	// ...
}
```

`userIDs` スライスに呼び出された引数を記録し、`CalledUserIDs()` メソッドで取得できるようにしています。これにより、エージェントが全てのユーザ(user_a, user_b, user_c)に対してツールを呼び出したかを検証できます。このツールはユーザIDに応じて、アラートの件数や深刻度の合計値を含むデータを返します。

同様に、不正ログイン検知のシナリオでは、`get_auth_logs` ツールが複数のログソースから認証ログを返します。テストデータにはalice、bob、charlieの3人のユーザ情報が含まれており、bobのみが通常とは異なるIPアドレスからアクセスしているように設計されています。

```go:pkg/usecase/chat/testtools/auth_logs.go
func (t *getAuthLogsTool) Execute(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error) {
	t.callCount++

	source, ok := fc.Args["source"].(string)
	if !ok {
		return nil, goerr.New("source argument is required")
	}

	var logs []map[string]any

	switch source {
	case "web_server":
		logs = []map[string]any{
			{"user_id": "alice", "source_ip": "192.168.1.100", "status": "success"},
			{"user_id": "bob", "source_ip": "203.0.113.50", "status": "failed"},
			{"user_id": "bob", "source_ip": "203.0.113.50", "status": "failed"},
			// ... 多数のログ
		}
	case "vpn_server":
		logs = []map[string]any{
			{"user_id": "alice", "source_ip": "192.168.1.100", "status": "success"},
			{"user_id": "bob", "source_ip": "203.0.113.50", "status": "failed"},
			// ... 多数のログ
		}
	// ... 他のソース
	}

	return &genai.FunctionResponse{
		Name:     fc.Name,
		Response: map[string]any{"source": source, "logs": logs},
	}, nil
}
```

ログの中にbobというユーザが不審なIPアドレス(203.0.113.50)から複数回ログイン失敗しているパターンが含まれています。エージェントがこのパターンを検出できれば、次に `get_user_info` ツールでbobの通常のアクセスパターンを確認するはずです。

```go:pkg/usecase/chat/testtools/auth_logs.go
func (t *getUserInfoTool) Execute(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error) {
	t.callCount++

	userID, ok := fc.Args["user_id"].(string)
	if !ok {
		return nil, goerr.New("user_id argument is required")
	}

	var userInfo map[string]any
	switch userID {
	case "bob":
		userInfo = map[string]any{
			"user_id":          "bob",
			"normal_locations": []string{"Tokyo", "Osaka"},
			"last_known_ip":    "192.168.1.150", // 通常とは異なる
		}
	// ... 他のユーザ
	}

	return &genai.FunctionResponse{Name: fc.Name, Response: userInfo}, nil
}
```

bobの通常のIPアドレスは `192.168.1.150` ですが、ログに記録されているのは `203.0.113.50` です。エージェントはこの不一致を検出して不正ログインの疑いがあると判断できます。このようにテストデータを設計することで、エージェントの論理的推論能力を検証できます。

## ユーザリスク分析のテスト実装

それでは実際のテストケースを見ていきます。まずユーザリスク分析のテストです。

```go:pkg/usecase/chat/session_test.go
func TestChatSession_UserRiskAnalysis(t *testing.T) {
	ctx := context.Background()

	listUsers := testtools.NewListUsersTool()
	getUserAlerts := testtools.NewGetUserAlertsTool()

	helper := setupTestSession(ctx, t, []tool.Tool{listUsers, getUserAlerts})

	task := "Find out which user has the most critical alerts. Get all users, then for each user get their alert count and severity sum, and determine who has the highest risk score (count * average_severity)."
	resp, err := helper.Session.Send(ctx, task)
	gt.NoError(t, err)

	answerText := extractResponseText(resp)
```

テスト用ツールのインスタンスを作成し、`setupTestSession` でテストセッションを構築します。このヘルパー関数は実際のGemini APIクライアントを作成し、モックのリポジトリ・ストレージと組み合わせます。タスクでは全ユーザを取得し、各ユーザのアラート情報を取得してリスクスコアを計算するよう指示しています。

ツール呼び出しの検証は以下のように行います。

```go:pkg/usecase/chat/session_test.go
	gt.Number(t, listUsers.CallCount()).GreaterOrEqual(1).Describe("list_users should be called at least once")
	gt.Number(t, getUserAlerts.CallCount()).GreaterOrEqual(1).Describe("get_user_alerts should be called at least once")

	// 引数の検証 - getUserAlertsが全ユーザに対して呼び出されたか
	calledUsers := getUserAlerts.CalledUserIDs()
	userSet := make(map[string]bool)
	for _, u := range calledUsers {
		userSet[u] = true
	}
	gt.True(t, userSet["user_a"] && userSet["user_b"] && userSet["user_c"]).Describe("get_user_alerts should be called for all users (user_a, user_b, user_c)")
```

まず各ツールが少なくとも1回は呼び出されたことを検証します。さらに `CalledUserIDs()` で呼び出された引数を取得し、全てのユーザ(user_a, user_b, user_c)に対してツールが呼び出されたかを確認します。これにより、エージェントが正しい処理フローを辿ったことを検証できます。

## LLMを使った回答の検証

最終回答の検証では、別のLLMインスタンスを使って回答の妥当性を判定します。これがアプローチ1のLLMを使ったテスト評価です。まず検証のための構造体を定義します。

```go:pkg/usecase/chat/session_test.go
type answerValidationRequest struct {
	Question       string
	ExpectedAnswer string
	ActualAnswer   string
}

type answerValidationResponse struct {
	IsValid     bool   `json:"is_valid"`
	Explanation string `json:"explanation"`
}
```

`validateAnswer` 関数は以下のようにLLMに検証を依頼します。

```go:pkg/usecase/chat/session_test.go
func validateAnswer(ctx context.Context, gemini adapter.Gemini, req answerValidationRequest) (*answerValidationResponse, error) {
	prompt := `You are validating if an AI assistant's answer contains the expected information.

Original question: ` + req.Question + `
Expected answer should contain: ` + req.ExpectedAnswer + `
Actual answer: ` + req.ActualAnswer + `

Respond in JSON format with:
- is_valid (boolean): true if the actual answer contains the expected information
- explanation (string): brief explanation of your judgment`

	config := &genai.GenerateContentConfig{
		Temperature: ptrFloat32(0.0),
		ResponseMIMEType: "application/json",
		ResponseSchema: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"is_valid": {
					Type:        genai.TypeBoolean,
					Description: "true if the actual answer contains the expected information",
				},
				"explanation": {
					Type:        genai.TypeString,
					Description: "brief explanation of your judgment",
				},
			},
			Required: []string{"is_valid", "explanation"},
		},
	}
```

ここで重要なのは `Temperature` を 0 に設定している点です。これにより検証結果の一貫性を高めています。また `ResponseSchema` でJSON形式の出力を厳密に指定し、`is_valid` と `explanation` を確実に受け取れるようにしています。

テストコードでは以下のように使用します。

```go:pkg/usecase/chat/session_test.go
	validation, err := validateAnswer(ctx, helper.Gemini, answerValidationRequest{
		Question:       task,
		ExpectedAnswer: "user_b has the highest risk score",
		ActualAnswer:   answerText,
	})
	gt.NoError(t, err)
	gt.True(t, validation.IsValid).Describe("Answer validation failed: " + validation.Explanation)
```

この方法により、「user_bが最も高いリスクスコアを持つ」という意味が回答に含まれていれば、表記にぶれがあっても正しく検証できます。LLMが意味的な一致を判定するため、厳密な文字列比較では捉えられない正解も検出できます。

# まとめ

LLMエージェントのテストで重要なのは、システムの特性に応じた現実的なアプローチを選択することです。非決定性、評価基準の曖昧さ、ユースケースの幅広さという3つの本質的な困難があるため、従来のソフトウェアテストと同じ精度は期待できません。しかし今回実装したように、ツール呼び出しの検証とLLMを使った意味的な回答検証を組み合わせることで、プロンプト調整や機能追加による後退(既存機能が損なわれること)を一定程度検出できます。

今回の実装のポイントは、テストデータを「エージェントが正しく動作すれば必ず正解にたどり着ける」ように設計することと、検証用LLMの応答を安定させるためにtemperature=0でスキーマ出力を使うことです。またツール呼び出しの回数や引数を記録しておくことで、エージェントが期待される処理フローを辿ったかを検証することも有効です。テストで全てのケースをカバーすることは困難ですが、ある程度の品質を担保する仕組みを用意しておくことで、継続的な改善がやりやすくなります。