---
title: "Function Callingで外部ツールと連携"
emoji: "🔧"
type: "tech"
topics: ["LLM", "FunctionCalling", "API", "tools"]
published: false
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の9日目です。今回はFunction Callingを用いて外部サービスと連携する方法について説明します。今回はセキュリティ分析においてアラート内に発生したIPアドレスに対して「IoC (Indicator of Compromise、影響発生を示す痕跡) を取得する」というユースケースを実装してみます。今回のコードは https://github.com/m-mizutani/leveret の [day09-tools](https://github.com/m-mizutani/leveret/tree/day09-tools) ブランチに格納されていますので適宜参照してください。

# ツール利用の抽象化

- 前日にalertを検索するためのToolを作った
- まずはこれを複数ツールを登録できるように拡張する

## Interfaceの定義

- 最初にInterfaceを作成する
- Spec、Executeはそのままgenaiに接続するために、 `genai` の型をそのまま利用する
  - もし生成AIプロバイダを切り替えたい、みたいな話になるとここは専用の型を使わずに独自の型で抽象化する必要がある
  - プロバイダ切り替えはこの他にもヒストリの管理や応答管理などなどで結構大変。基本おすすめしない
- 今回はPrompt, Flagsという2つのメソッドも追加する
- Promptはsystem promptに必要事項を書き加えるためのインターフェース
  - これはdescriptionだけでは説明しきれない情報を自由文脈で追加するためのもの
  - 例えばデータ構造が複雑な場合などに構造化して説明したかったりする場合
- Flagsは設定値を伝えるためのインターフェース
  - 今回はCLIの引数制御に使っている [https://github.com/urfave/cli](https://github.com/urfave/cli) で設定値を渡すようにする
  - 設定値の例としてはAPIキーなどのcredential、検索クエリの上限値、タイムアウトのような、生成AIからの命令によらず常に一定になるものを対象とする
  - もちろん設定ファイルのようなものを用意してもよいが、例えばWebアプリケーションのベストプラクティスを書いた[twelve factors](https://12factor.net/ja/)では設定値を環境変数で管理するのが良いとされている
  - 設定ファイルのほうが構造データを設定値として利用できる反面、秘匿値と相性がわるい。このあたりはケースバイケースで考えてくれ
  - 後日実装するものの中にはconfig fileを指定するFlagも用意する
- InitはFlagsによってセットされた値をつかった初期化
  - 必要ないツールもあるが、例えばclientを作成したり設定値の検証をしたりとか
  - あと設定がない場合スキップするための確認にもなる

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

- Toolのインターフェースを決めたら今度は複数のツールを束ねる入れ物をつくる
- 今回は `Registry` とする
- `New` 時に任意の数のtoolsを受け入れる
- `New` の時点では設定値がCLIから渡されないので `Init` で設定値のチェックや有効化するツールを選択する
- `Init` は共通で使いうるrepositoryのインターフェイスなどをまとめた `Client` を受け取るようにしておくと便利

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

- InitはCLIのパースなどが行われた後に実行する
- Initで重要なのは tool name (今回は `FunctionDeclaration.Name` ) の重複チェック。実行時に重複があると混乱のもとになったりエラーになる場合もあるので、そこだけはTool外で責任を持って確認
  - ちなみに命名規則がちゃんとあるので注意
  - geminiの場合は
    - name は 文字またはアンダースコア（_）で始める 必要があります。
    - 続く文字には、英大文字・英小文字（A-Z, a-z）、数字（0-9）、アンダースコア（_）、ドット（.）、ハイフン（‐／dash） が使用可能です。
    - 最長で 64文字 まで許可されています。
  - 詳細は[ここ](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/function-calling)

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

- この他に登録されたツールのSpec、Executeなどをまとめて返すようなメソッドも必要（適宜branch見てね）
- 最後にFlagsを組み込む

```go:pkg/cli/chat.go
	// Create tool registry early to get flags
	registry := tool.New(
		alert.NewSearchAlerts(),
	)

    // 中略
	flags = append(flags, registry.Flags()...)
```

- 仕上げにInitで初期化したものをchatに引き渡す

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

これによって、chat usecase内でシステムプロンプトに追記をしたり

```go
	// Add tool-specific prompts
	if s.registry != nil {
		if toolPrompts := s.registry.Prompts(ctx); toolPrompts != "" {
			systemPrompt += "\n\n" + toolPrompts
		}
	}
```

Toolの設定（Function Declaration）を入力したりができるようになる

```go
	// Add tools from registry if available
	if s.registry != nil {
		config.Tools = s.registry.Specs()
	}
```

# Threat Intelligence Tool の追加

- 拡張可能な仕組みができたところで本題に入っていく
- 今回は [Open Threat Exchange](https://otx.alienvault.com) のAPIを叩く
- API docsはこれ https://otx.alienvault.com/api
- この機能を追加したcommitが[これ](https://github.com/m-mizutani/leveret/blob/day09-tools/pkg/tool/otx/otx.go)

## 構造体定義と `New`

- APIアクセスに必要なキーだけもたせる
- もしmockテストなどしたいならhttp.Client相当のインターフェースを作って差し替え可能にするなどもあり
- 今回はそこまでしないよ

```go
type otx struct {
	apiKey string
}

// New creates a new OTX tool
func New() *otx {
	return &otx{}
}
```

## `Flags`

- `urfave/cli/v3` 経由でAPIキーを取得する
  - 環境変数経由でセキュアに渡すことも可能
- ツール名と同様にCLIオプションでも他のツールなどと名前が衝突しないようにだけ注意
- これで値がセットされていれば `x.apiKey` にAPIキーが保持される

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

## `Init`

- OTXはステートレスなシンプルAPIなので特に初期化の必要なし
- ただしapiKeyがなかったら無効化するので、そのチェックだけ入れる

```go
// Init initializes the tool
func (x *otx) Init(ctx context.Context, client *tool.Client) (bool, error) {
	// Only enable if API key is provided
	return x.apiKey != "", nil
}
```

## `Prompt`

- OTXの場合入れなくてもいいんだけど、まあ入れるならこんな感じ
- Function Declaration に設定が入るのでこれがなくても認知はされる
- Systemプロンプトと組み合わせてツールの利用を強く促したい場合などに使うと効果的

```go
// Prompt returns additional information to be added to the system prompt
func (x *otx) Prompt(ctx context.Context) string {
	return `When analyzing security indicators (IP addresses, domains, file hashes, etc.), you can use the query_otx tool to get threat intelligence from AlienVault OTX.`
}
```

## `Spec`

- 今回、対象としたのは "IPv4", "IPv6", "domain", "hostname", "file" のいずれか
- これは FunctionDeclaration を分けるという手もあるが、今回は1つにまとめた
  - どっちがいいのかはよくわからんが、ツールの多さは複雑さにつながる場合が多い印象がある
  - 複雑性が高いと普通に生成AIは混乱するため、わかりにくくない範囲でまとめたほうがおそらくよい
- Enumなどで値を指定できるものについてはちゃんと指定する
- Requiredもちゃんと示す
- このあたりの定義が以下にしっかりしているかでツールの実行精度（命令の出し方）が結構かわる

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

## `Execute`

- `Args` は `map[string]any` なので1つずつ検証してもいいし、marshal → unmarshal で一括で取り出すのも手ではある
  - 今回は後者
- `Validate()` でEnumとかrequiredとかの条件がマッチしているか検証する
  - declaration で指定しても違う値が返ってくることはありえるのでちゃんと検証する
  - コレを怠ると脆弱性になる場合がある（アクセス範囲の指定とかだったりすると特に）
- queryAPIは普通にHTTPでAPI叩いているだけなので割愛
- 最後に `FunctionResponse` に入れて返す
  - 応答形式は自由なのだが、 `map[string]any` である必要がある
  - APIの応答がmap形式と確定しているときはいいが、そうでない場合を考えて JSON in JSON にしてしまう今回のような手も駄目ではない

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


## 実行例

- 最後に実行例。
- 前提として
  - examplesのデータを入れた (ID: `baa7823c-7ea2-4352-a06b-bda92a53103a` )
  - firestore, cloud storageなどの設定に加えて `LEVERET_OTX_API_KEY` を指定している
- 途中経過を出力するようにしている
  - これはnoisyであるという説と途中経過が分かったほうが便利という意見がある
  - 今回は後者をとった
- 例のように特に指定しなくてもIoCらしきドメインを特定し、ツールを呼び出してデータを収集し、それについて解説する、というタスクをこなしている

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

# まとめ