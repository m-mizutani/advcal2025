---
title: "Goで作るセキュリティ分析LLMエージェント(9): シンプルなツールの実装：脅威インテリジェンスツール"
emoji: "🔧"
type: "tech"
topics: ["ai", "go", "security", "api"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の9日目です。今回はFunction Callingを用いて外部サービスと連携する方法について説明します。

前回は、アラート検索ツールを実装してFunction Callingの基礎を学びました。今回はその基盤を拡張し、複数の外部ツールを統一的に管理できる仕組みを構築します。具体的には、セキュリティ分析において重要な「脅威インテリジェンス(Threat Intelligence)の取得」を実現します。アラートに含まれるIPアドレス、ドメイン、ファイルハッシュなどのIoC (Indicator of Compromise、侵害痕跡指標)[^ioc] について、外部の脅威インテリジェンスサービスから情報を取得し、LLMが自動的に分析できるようにします。

[^ioc]: IoCは、システムへの侵入や攻撃の証拠となる技術的な痕跡のこと。具体的にはIPアドレス、ドメイン名、URL、ファイルハッシュ、レジストリキー、Mutexなどが該当する。これらを脅威インテリジェンスと照合することで、既知の攻撃パターンとの一致を検出できる。

今回のコードは https://github.com/m-mizutani/leveret の [day09-tools](https://github.com/m-mizutani/leveret/tree/day09-tools) ブランチに格納されていますので適宜参照してください。

# ツール利用の抽象化

前回はアラート検索ツールを実装しました。今回はまず、この仕組みを拡張して複数のツールを統一的に管理できるようにします。

ツール管理を抽象化する理由は、新しいツールを追加する際の一貫性と保守性を確保するためです。個々のツールが独立して実装されていると、初期化の方法や設定の渡し方がツールごとに異なってしまい、メンテナンスが困難になります。共通のインターフェースを定義することで、新しいツールの追加が容易になり、既存のコードへの影響も最小限に抑えられます。

## Interfaceの定義

まず共通のインターフェースを定義します。このインターフェースには、前回実装した `Spec` と `Execute` に加えて、`Flags`、`Init`、`Prompt` という3つのメソッドを追加します。

`Spec` と `Execute` については、Gemini APIと直接連携するため `genai` パッケージの型をそのまま利用します。もし将来的にLLMプロバイダを切り替える必要が出てきた場合は、独自の型で抽象化する必要があります[^provider-switching]。ただし、プロバイダ切り替えは会話履歴の管理や応答の処理など、他の部分でも大幅な変更が必要になるため基本的にはおすすめしません。

[^provider-switching]: 複数プロバイダ対応のためのインターフェース設計については、LangChainなどのマルチプロバイダ対応フレームワークの設計が参考になります。ただし抽象化レイヤーが増えることでメンテナンスコストがかなり大きくなってしまう点に注意してください。Goでもいくつか実装例があります。実際に著者は[gollem](https://github.com/m-mizutani/gollem)というSDKを作って保守しています。

`Prompt` メソッドは、システムプロンプトに追加情報を書き加えるためのものです。Function Declarationの `description` だけでは説明しきれない情報を自由な文脈で追加できます。たとえば、ツールが扱うデータ構造が複雑な場合、その構造を詳しく説明したり、利用時の注意事項を記述したりできます。

`Flags` メソッドは、ツールに必要な設定値を受け取るためのインターフェースです。今回はCLIフレームワークとして [urfave/cli](https://github.com/urfave/cli) を使っているため、このメソッドで各ツールのCLIフラグを定義します。設定値の例としては、APIキーなどのクレデンシャル情報、検索クエリの上限値、タイムアウトといった、LLMからの指示によらず常に一定になるものが該当します。設定の管理方法については、設定ファイルを用意する選択肢もあります。しかし、Webアプリケーションのベストプラクティスをまとめた [The Twelve-Factor App](https://12factor.net/ja/)[^twelve-factor] では、設定値を環境変数で管理することが推奨されています。設定ファイルは構造化データを扱える利点がある一方、APIキーなどの秘匿値を管理する際には注意が必要です。このあたりは用途に応じて判断してください。なお、今後実装するツールの中には、設定ファイルのパスを指定するフラグを持つものも登場します。

[^twelve-factor]: The Twelve-Factor Appは、モダンなSaaS型アプリケーション開発のためのベストプラクティス集です。設定管理以外にも依存関係の明示、ビルド・リリース・実行の分離、ログのストリーム処理など12の原則を提唱しています。

`Init` メソッドは、`Flags` によってセットされた値を使ってツールを初期化します。必要ないツールもありますが、たとえばHTTPクライアントの作成や設定値の検証などを行います。また、必要な設定が揃っていない場合にツールを無効化する判定にも使われます。

```go:pkg/tool/interface.go
// Tool represents an external tool that can be called by the LLM
type Tool interface {
	// Flags returns CLI flags for this tool
	// Called first to register CLI flags
	// Returns nil if no flags are needed
	Flags() []cli.Flag

	// Init initializes the tool with the given context and client
	// Called after CLI flags are parsed and before the tool is used
	// Returns (enabled, error) where:
	//   - enabled: true if the tool should be registered and available for use
	//   - error: non-nil if initialization fails
	Init(ctx context.Context, client *Client) (bool, error)

	// Spec returns the tool specification for Gemini function calling
	// Called when building the tool list for LLM
	Spec() *genai.Tool

	// Prompt returns additional information to be added to the system prompt
	// Called when constructing the system prompt
	// Returns empty string if no additional prompt is needed
	Prompt(ctx context.Context) string

	// Execute runs the tool with the given function call and returns the response
	// Called when LLM requests to execute this tool
	Execute(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error)
}
```

## Registry の用意

インターフェースを定義したら、次は複数のツールを束ねて管理する仕組みを作ります。今回は `Registry` という構造体を用意して、ツールの登録と管理を行います。

`Registry` の `New` 関数では、任意の数のツールを受け入れます。ただし、`New` の時点ではまだCLIからの設定値が渡されていないため、実際の初期化は `Init` メソッドで行います。`Init` では設定値のチェックや、有効化するツールの選択を実施します。また、`Init` メソッドには複数のツールで共通して使う可能性があるリポジトリのインターフェースや生成AIクライアント、ストレージアクセスなどをまとめた `Client` を渡すようにしておくと便利です。

このようなRegistryパターンを採用することで、ツールの追加や削除が容易になり、依存関係の管理もシンプルになります。

```go:pkg/tool/registry.go
// Registry manages available tools for the LLM
type Registry struct {
	tools     map[string]Tool
	allTools  []Tool
	toolSpecs map[*genai.Tool]bool
}

// New creates a new tool registry with the given tools
// Tools are not registered until Init() is called
func New(tools ...Tool) *Registry {
	r := &Registry{
		tools:     make(map[string]Tool),
		allTools:  tools,
		toolSpecs: make(map[*genai.Tool]bool),
	}

	return r
}
```

`Init` メソッドはCLIのパース処理が完了した後に実行します。ここで重要なのは、ツール名（`FunctionDeclaration.Name`）の重複チェックです。複数のツールが同じ名前の関数を定義する可能性があるため、実行時に名前の重複があると、どのツールを呼び出すべきか判断できなくなったり、エラーが発生する可能性があります。個々のツール実装では他のツールの存在を把握できないため、`Registry` が責任を持って重複を検出します。

なお、ツール名には命名規則があるため注意が必要です[^function-naming]。Gemini APIの場合、以下のルールに従う必要があります。

- 名前は文字またはアンダースコア（`_`）で始める
- 続く文字には英大文字・英小文字（A-Z, a-z）、数字（0-9）、アンダースコア（`_`）、ドット（`.`）、ハイフン（`-`）が使用可能
- 最長で64文字まで許可

[^function-naming]: Gemini APIのFunction Calling仕様の詳細は[公式ドキュメント](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/function-calling)を参照してください。OpenAI APIやAnthropic Claude APIなど他のプロバイダでは異なる命名規則があります。

```go:pkg/tool/registry.go
// Init initializes all tools and registers enabled tools
func (r *Registry) Init(ctx context.Context, client *Client) error {
	for _, t := range r.allTools {
		// Initialize tool and check if enabled
		enabled, err := t.Init(ctx, client)
		if err != nil {
			return goerr.Wrap(err, "failed to initialize tool")
		}

		// Skip if not enabled
		if !enabled {
			continue
		}

		// Register enabled tool
		spec := t.Spec()
		if spec == nil || len(spec.FunctionDeclarations) == 0 {
			continue
		}

		// Register tool spec
		r.toolSpecs[spec] = true

		// Register function declarations with duplicate check
		for _, fd := range spec.FunctionDeclarations {
			if existing, exists := r.tools[fd.Name]; exists {
				// Check if it's the same tool (same pointer)
				if existing != t {
					return goerr.New("duplicate function name", goerr.V("name", fd.Name))
				}
				// Same tool, skip registration
				continue
			}
			r.tools[fd.Name] = t
		}
	}
	return nil
}
```

この他にも、登録されたツールの `Spec` や `Execute` をまとめて実行するためのメソッドが必要ですが、詳細は [ブランチのコード](https://github.com/m-mizutani/leveret/tree/day09-tools) を参照してください。

最後に、各ツールのフラグをCLIに組み込みます。`Registry` の `Flags` メソッドで全ツールのフラグを集約し、CLIの起動時に登録します。

```go:pkg/cli/chat.go
	// Create tool registry early to get flags
	registry := tool.New(
		alert.NewSearchAlerts(),
	)

    // 中略
	flags = append(flags, registry.Flags()...)
```

そして、`Init` で初期化した `Registry` をチャットセッションに引き渡します。

```go:pkg/cli/chat.go
// Initialize tools with client
if err := registry.Init(ctx, &tool.Client{
    Repo:    repo,
    Gemini:  gemini,
    Storage: storage,
}); err != nil {
    return goerr.Wrap(err, "failed to initialize tools")
}

// Create chat session
session, err := chat.New(ctx, chat.NewInput{
    Repo:     repo,
    Gemini:   gemini,
    Storage:  storage,
    Registry: registry,
    AlertID:  alertID,
})
```

これによって、chat usecaseの中でシステムプロンプトにツール固有の情報を追記できるようになります。

```go
// Add tool-specific prompts
if s.registry != nil {
	if toolPrompts := s.registry.Prompts(ctx); toolPrompts != "" {
		systemPrompt += "\n\n" + toolPrompts
	}
}
```

同様に、Function Declarationの設定も `Registry` から取得してLLMに渡せます。

```go
// Add tools from registry if available
if s.registry != nil {
	config.Tools = s.registry.Specs()
}
```

# Threat Intelligence Tool の実装

ツールを管理する拡張可能な仕組みができたところで、本題である脅威インテリジェンスツールの実装に入ります。今回は [AlienVault Open Threat Exchange (OTX)](https://otx.alienvault.com)[^otx] のAPIを使います。OTXは世界中のセキュリティ研究者が脅威情報を共有するコミュニティ駆動型のプラットフォームで、無料のAPIキーで膨大な脅威インテリジェンスデータにアクセスできます。

[^otx]: AlienVault OTXは世界中のセキュリティ研究者が脅威情報を共有するコミュニティ駆動型プラットフォームです。無料のAPIキーで膨大な脅威インテリジェンスデータにアクセスできます。詳細は[公式APIドキュメント](https://otx.alienvault.com/assets/static/external_api.html)を参照してください。

## ツール構造の定義

まず、OTXツールの構造体を定義します。今回はシンプルにAPIアクセスに必要なキーだけを保持します。

```go
type otx struct {
	apiKey string
}

// New creates a new OTX tool
func New() *otx {
	return &otx{}
}
```

`Flags` メソッドでは、`urfave/cli/v3` を使ってAPIキーを受け取るためのフラグを定義します。`Sources` に `EnvVars` を指定することで、コマンドライン引数だけでなく環境変数からも値を取得できます。APIキーのようなセンシティブな情報を安全に渡すため、環境変数経由での設定を推奨します。

```go
// Flags returns CLI flags for this tool
func (x *otx) Flags() []cli.Flag {
	return []cli.Flag{
		&cli.StringFlag{
			Name:        "otx-api-key",
			Sources:     cli.EnvVars("LEVERET_OTX_API_KEY"),
			Usage:       "OTX API key",
			Destination: &x.apiKey,
		},
	}
}
```

`Init` メソッドでは、APIキーの有無をチェックします。OTX APIはステートレスなシンプルな設計なので特別な初期化処理は不要ですが、APIキーが設定されていない場合は `false` を返してツールを無効化します。

```go
// Init initializes the tool
func (x *otx) Init(ctx context.Context, client *tool.Client) (bool, error) {
	// Only enable if API key is provided
	return x.apiKey != "", nil
}
```

`Prompt` メソッドでは、システムプロンプトに追加する情報を定義します。Function Declarationの中で十分な説明があればツールの存在は認識されますが、利用を強く促したい場合に効果的です。

```go
// Prompt returns additional information to be added to the system prompt
func (x *otx) Prompt(ctx context.Context) string {
	return `When analyzing security indicators (IP addresses, domains, file hashes, etc.), you can use the query_otx tool to get threat intelligence from AlienVault OTX.`
}
```

## Function Declarationの定義

`Spec` メソッドでは、Function Declarationを定義します。今回対象とするインジケータの種類は "IPv4", "IPv6", "domain", "hostname", "file" の5種類です。これらを個別のFunction Declarationに分けることもできますが、今回は1つにまとめました。ツールを細かく分割すると全体の複雑さが増し、LLMが混乱してしまう可能性があります。機能的に密接に関連する操作は1つのツールにまとめ、異なる責務を持つ操作は別のツールに分離するという方針が有効です。

Function Declarationで特に重要なのは、関数名（`Name`）と説明（`Description`）です。生成AIはこれらの情報からツールの用途を理解し、適切な場面で呼び出すかどうかを判断します。具体性や説明の詳細さが、LLMがツールの内容をどれだけ正確に想像できるかを左右します。命名では、独自の用語や略語を避け、一般的な用語を使うことが重要です。たとえば、`query_otx` という名前は動詞と対象が明確で理解しやすい一方、`otx_q` のような省略形はLLMが意図を推測しにくくなります。説明文も同様に、具体的かつわかりやすく記述することで、LLMが適切なタイミングでツールを使えるようになります。このような配慮がないと、実装したツールもLLMから利用されません。実際に、こうした命名の良し悪しは生成AIチャットなどを利用して壁打ちをするのがお勧めです。

パラメータの定義では、`Enum` で選択可能な値を明示し、`Required` で必須パラメータを指定します。こうした定義の精度が、LLMがどれだけ適切にツールを呼び出せるかに大きく影響します。

```go
// Spec returns the tool specification for Gemini function calling
func (x *otx) Spec() *genai.Tool {
	return &genai.Tool{
		FunctionDeclarations: []*genai.FunctionDeclaration{
			{
				Name:        "query_otx",
				Description: "Query AlienVault OTX for threat intelligence about IP addresses, domains, hostnames, or file hashes",
				Parameters: &genai.Schema{
					Type: genai.TypeObject,
					Properties: map[string]*genai.Schema{
						"indicator_type": {
							Type:        genai.TypeString,
							Description: "Type of indicator to query",
							Enum:        []string{"IPv4", "IPv6", "domain", "hostname", "file"},
						},
						"indicator": {
							Type:        genai.TypeString,
							Description: "The indicator value (IP address, domain, hostname, or file hash)",
						},
						"section": {
							Type:        genai.TypeString,
							Description: "Section of data to retrieve",
							Enum:        []string{"general", "reputation", "geo", "malware", "url_list", "passive_dns", "http_scans", "nids_list", "analysis", "whois"},
						},
					},
					Required: []string{"indicator_type", "indicator", "section"},
				},
			},
		},
	}
}
```

## ツールの実行処理

`Execute` メソッドでは、LLMからのツール呼び出しを実際に処理します。引数の処理、入力検証、API呼び出し、応答の返却という流れで実装します。

`FunctionCall` の `Args` は `map[string]any` 型で渡されます。今回はJSON経由でまとめて構造体に変換する方法を採用しました。型アサーションで1つずつ取り出す方法もありますが、一度JSONにマーシャルしてから定義した構造体にアンマーシャルすることで、コードがシンプルになり、フィールドの欠落も検出しやすくなります。

入力値の検証は必須です。Function Declarationで `Enum` や `Required` を指定していても、LLMが異なる値を返す可能性があります[^validation-importance]。特にファイルパスやコマンド実行のようなパラメータでは、検証を怠るとインジェクション攻撃などの脆弱性につながります。LLMからの入力も信頼できないデータとして扱い、必ず検証を実施してください。

[^validation-importance]: LLMからの入力も信頼できないデータとして扱うべきです。特にファイルパス、SQLクエリ、コマンド実行などのパラメータは厳密に検証しないとインジェクション攻撃のリスクがあります。

`queryAPI` メソッドは通常のHTTPリクエストでOTX APIを呼び出しているだけなので詳細は割愛します。実装の詳細は [GitHubのコード](https://github.com/m-mizutani/leveret/blob/day09-tools/pkg/tool/otx/otx.go) を参照してください。

応答は `FunctionResponse` に入れて返します。応答形式は `map[string]any` である必要がありますが、その中身は自由です。今回は一度JSON文字列に変換してから格納する方法を採用しました。生成AIは構造化されたJSONを理解しやすいため、この形式は実用的です。

```go
// Execute runs the tool with the given function call
func (x *otx) Execute(ctx context.Context, fc genai.FunctionCall) (*genai.FunctionResponse, error) {
	// Marshal function call arguments to JSON
	paramsJSON, err := json.Marshal(fc.Args)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to marshal function arguments")
	}

	var input queryOTXInput
	if err := json.Unmarshal(paramsJSON, &input); err != nil {
		return nil, goerr.Wrap(err, "failed to parse input parameters")
	}

	// Validate input
	if err := input.Validate(); err != nil {
		return nil, goerr.Wrap(err, "validation failed")
	}

	// Query OTX API
	result, err := x.queryAPI(ctx, input.IndicatorType, input.Indicator, input.Section)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to query OTX API")
	}

	// Convert result to JSON string for better readability
	resultJSON, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return nil, goerr.Wrap(err, "failed to marshal result")
	}

	return &genai.FunctionResponse{
		Name:     fc.Name,
		Response: map[string]any{"result": string(resultJSON)},
	}, nil
}
```


## 動作確認

実際に動かしてみましょう。以下の前提条件でテストを行います。examplesのデータを取り込み済み（アラートID: `baa7823c-7ea2-4352-a06b-bda92a53103a`）、Firestore・Cloud Storageなどの設定を完了、環境変数 `LEVERET_OTX_API_KEY` にOTX APIキーを設定した状態です。

今回の実装では、ツール呼び出しの途中経過を出力するようにしています。出力が多くてnoisyだという意見もありますが、ユーザーがエージェントの動作を理解できる利点を重視して採用しました。

以下の実行例では、ユーザーが「このアラートに出てきたIoCの情報を調べてみて」とだけ指示しています。生成AIはアラートから `3322.org` というドメインを自動的に抽出し、適切なパラメータ（`indicator_type: domain`, `section: general`）を選択してOTX APIを呼び出し、取得した大量のデータを分析して日本語で要約を作成します。

```bash
% go run . chat -i baa7823c-7ea2-4352-a06b-bda92a53103a
Enabled tools: [search_alerts query_otx]

Chat session started. Type 'exit' to quit.

> このアラートに出てきたIoCの情報を調べてみて

⠏ analyzing...
🔧 Calling tool: query_otx
   Args:
{
     "indicator": "3322.org",
     "indicator_type": "domain",
     "section": "general"
   }
⠼ analyzing...✅ Tool result:
{
  "alexa": "http://www.alexa.com/siteinfo/3322.org",
  "base_indicator": {
    "access_reason": "",
    "access_type": "public",
    "content": "",
    "description": "",
    "id": 2474025,
    "ind...

このアラートに関連するIoC「3322.org」についてAlienVault OTXで調査した結果、以下の情報が見つかりました。

**IoCの概要:**
ドメイン名「3322.org」は、複数の脅威インテリジェンスパルスに関連付けられており、様々なマルウェアファミリーや攻撃手法で使用されていることが示唆されています。

**関連するマルウェアファミリー:**
このドメインは、以下のような広範なマルウェアファミリーに関連しています。
*   Tsara Brashears, Tulach Malware, WebToolbar, TrojanSpy, Daisy Coleman, Twitter Malware, Zbot, Qakbot, CVE JAR, LockBit, TrickBot - S0266, Death Bitches, Bit RAT, Swisyn, Emotet, FormBook, Fusioncore, Quasar RAT, Maui Ransomware, Chaos, LolKek, GootLoader, Raccoon, Crack, Azorult, Apple Malware, FonePaw, Amazon AES, Facebook HT, Ransomexx, Artemis, Vidar, Agent Tesla - S0331, Networm, Dapato, Dark Power, DNSpionage, Trojan:Win32/Detplock, Remcos, PwndLocker.

**関連タグ:**
このドメインは、以下のようなタグで分類されています。
*   malware (マルウェア), malicious site (悪意のあるサイト), phishing (フィッシング), trojan (トロイの木馬), stealer (情報窃取マルウェア), ransomware (ランサムウェア), critical risk (重大なリスク), command and control (C2), botnet (ボットネット), password cracker (パスワードクラッカー) など。

**追加情報（パルスの説明より）:**
一部のパルスでは、「Extreme cyber attack (極端なサイバー攻撃)」、「highly malicious Malware (非常に悪質なマルウェア)」、「Massive online attack (大規模なオンライン攻撃)」、「Adversarial monitoring, harassment, Libel, cyber crime (敵対的監視、ハラスメント、名誉毀損、サイバー犯罪)」といった説明がされており、このドメインが悪質な活動に深く関与していることが示されています。

**検証情報:**
興味深いことに、一部のソース（Subdomain Insecure Validator, Majestic, Whitelist）では、「Whitelisted indicator 3322.org」または「Whitelisted domain 3322.org」として、このドメインがホワイトリストに登録されているという情報もあります。これは、このドメインが一部のセキュリティ対策では信頼できると誤って判断されている可能性、またはドメインの性質が時間とともに変化した可能性を示唆しています。

このドメインが悪質な活動に関連している可能性が非常に高いため、このIoCに遭遇した場合は注意が必要です。

> ^C

Chat session completed
```

# 他の脅威インテリジェンスツールとの連携

今回はAlienVault OTXの実装を詳しく解説しましたが、同じ `Tool` インターフェースを使えば他の脅威インテリジェンスサービスとも簡単に統合できます。

たとえば、**URLScan.io** はURLの解析結果、スクリーンショット、DOMツリーなどを取得できるサービスです。実装上の特徴として、検索APIとスキャン実行APIの2段階構成になっています。フィッシングURLの検証やリダイレクト先の調査などに活用できます。他にも**AbuseIPDB**というサービスがあります。これは、IPアドレスの不正利用報告とスコアリングを提供し、攻撃元IPの評価やボットネットの検出に役立ちます。

これらすべてが同じ `Tool` インターフェースを実装しているため、`Registry` に追加するだけで利用可能になります。詳細な実装は [leveretのブランチ](https://github.com/m-mizutani/leveret/tree/day09-tools) を参照してください。

# 実装上の考慮事項

## レート制限への対応

脅威インテリジェンスAPIの多くにはレート制限があります。無料プランでは特に制限が厳しいものが多く、短時間に大量のリクエストを送るとエラーが返されます。この問題への対応策は大きく分けて2つあります。

1つ目は、レート制限エラーをそのままLLMに返す方法です。この場合、生成AIはエラーを受け取ると、そのツールの使用を諦めて別の方法を模索します。タスクは進行しますが、本来取得したかった情報が得られない可能性があります。実装はシンプルですが、エージェントの能力が制限される点に注意が必要です。

2つ目は、ツール単位でキュー制御する仕組みを実装する方法です。Goの場合、起動時にworkerを作成し、そのworkerがレート制限を逸脱しないように呼び出しを制御できます。あるいは、API呼び出し箇所をsingletonパターンで実装して、レート制限を超えたらリクエストをブロックする仕組みも考えられます。いずれの方法でも応答時間が長くなるため、ツールの呼び出し頻度との兼ね合いを考慮する必要があります。また、実装が複雑化する点にも注意してください。

## エラー情報の伝達

レート制限に限らず、エラーはなるべくそのままLLMに返すようにするのが良いでしょう。エラー情報を受け取ることで、生成AIはパラメータを変更してリトライしたり、別のアプローチを試したりできるようになります。この観点から、エラーメッセージにはコンテキストを含めることが重要です。何が問題だったのか、エラーは復旧可能なのか、どのようにリクエストを修正すべきかといった情報を詳細に返すことで、LLMがより適切な対応を取れるようになります。たとえば、単に「リクエストが失敗しました」と返すよりも、「パラメータ `indicator_type` に不正な値 'ipv4' が指定されています。有効な値は IPv4, IPv6, domain, hostname, file です」と返すほうが、LLMが次のアクションを判断しやすくなります。

# まとめ

今回実装した `Tool` インターフェースと `Registry` の仕組みが、エージェントの拡張性を支える基盤となります。新しいツールは `Registry` に登録するだけで利用可能になり、既存コードへの影響はありません。

実装時に注意すべき点は3つあります。1つ目は、Function Declarationの命名と説明です。一般的な用語を使い、具体的でわかりやすい説明を書くことで、LLMが適切なタイミングでツールを呼び出せるようになります。2つ目は、`Enum` や `Required` によるパラメータ定義の精度です。選択肢と必須項目を明示することで、LLMが正しいパラメータでツールを実行できます。3つ目は、入力検証です。Function Declarationで制約を定義していても、実装側で必ず検証を行ってください。検証を怠ると動作不良を起こすだけでなく、インジェクション攻撃などのリスクがありえます。

この仕組みを使えば、SIEM APIへのクエリ、チケット管理システムへの登録、Slackへの通知など、セキュリティ運用で必要な操作を次々と統合できます。今回のOTXツールをテンプレートとして、自分の環境に必要なツールを追加してみてもらえるとよいかと思います。
