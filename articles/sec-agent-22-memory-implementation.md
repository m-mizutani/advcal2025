---
title: "Goで作るセキュリティ分析LLMエージェント(22): エージェントの記憶システム実装"
emoji: "💾"
type: "tech"
topics: ["ai", "go", "llm", "rag"]
published: true
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の22日目です。

今回のコードは https://github.com/m-mizutani/leveret の [day22-memory](https://github.com/m-mizutani/leveret/tree/day22-memory) ブランチに格納されていますので適宜参照してください。また今回は前日に解説した記憶機能の概要に基づいた実装となっているため、先にそちらの記事を閲覧されることをおすすめします。

# 記憶システムの実装方針

今回の記憶システムは、過去に実装したBigQueryサブエージェント内に組み込みます。サブエージェントに記憶を持たせる理由は主に2つあります。

第一に、BigQueryサブエージェントが実行するタスクは「BigQueryへのクエリと結果取得」という限られた領域に閉じています。このようにドメインが明確に区切られていると、記憶の管理や整理が容易になります。さらに作業が単発的に完結するため、前後関係や広範な文脈の情報をあまり必要としません。

第二に、このサブエージェントに入力されるクエリは、すでに文脈を理解した上で具体化された内容になっています。この点は記憶システムの設計において重要な意味を持ちます。セキュリティ分析においてメインのエージェントに投げかけられる質問は、アラートのデータやそれまでの会話履歴を意識したものです。そのため、ユーザの直接の入力から実際にやるべき内容を抽出し、それに対応する記憶を探すという処理は技術的に困難です。一方でBigQueryエージェントには「〜を探せ」「〜を検索せよ」といった、すでに具体化・単純化された入力しか入ってきません。このように具体化された入力であれば、Embeddingによって関連する過去の記憶を探すという処理が現実的に機能します。このように、ドメインの限定性と入力の具体性という2つの特性が相まって、BigQueryサブエージェントは記憶システムの導入に適した環境となっています。

前回の記事でも説明したとおり、セキュリティ分析におけるエージェントの記憶管理の最適解は現在も模索中の段階です。そのため今回実装するのはあくまで一例であり、エージェントの記憶管理がどのように機能するかをイメージしてもらうための実装と考えてください。

# 実装する記憶機能の流れ

記憶機能は初回実行時と2回目以降で異なる動作をします。ここではその全体的な流れを説明します。記憶機能の中核となるのが「内省（Introspection）」です。これはセッション完了後にLLM自身が実行内容を振り返り、将来役立ちそうな知見を抽出したり、提供された記憶の有用性を評価したりする処理です。この内省機能により、エージェントは経験から学習して自己改善していきます。

## 初回実行時の動作

初回の実行ではこれまでどおりのサブエージェントとしての機能を実行します。タスクの実行が完了した後、「内省」の機能を発動させます。内省フェーズではLLMが今回のセッションを分析し、セッション中に明らかになったテーブル構造やクエリのパターンなど次回以降の実行に役立ちそうな技術的知見を抽出します。抽出された情報は、サブエージェントへの入力クエリのEmbeddingとともにデータベースに格納されます。

## 2回目以降の実行時の動作

2回目以降の実行時には、タスクを実行する前にまず記憶を検索します。入力クエリのEmbeddingを生成し、Firestoreのベクトル検索を使って類似するクエリに関する過去の記憶を探します。検索する際はコサイン類似度による足切りを行い、関連性の低い記憶を除外します。さらにプロンプトが過度に長くなることを防ぐため、取得する記憶の件数に上限を設けます。検索で得られた記憶はシステムプロンプトに組み込まれ、その情報を活用してタスクを実行します。

タスク実行後の内省フェーズでは、新しい記憶になりそうな情報を抽出するだけでなく、提供された記憶の評価も行います。今回のセッションで役に立った記憶と、間違っていて有害だった記憶をLLMに申告させます。役に立った記憶にはスコアを加点し、間違っていた記憶にはスコアを減点します。この評価によって、忘れるべき記憶と保持し続けるべき記憶が選別されます。新たに抽出された記憶も同様にデータベースに保存されます。

このサイクルを繰り返すことによって、記憶は徐々に精錬されていきます。有用な記憶はスコアが上がって保持され続け、有害な記憶はスコアが下がって最終的に削除されます。これにより、エージェントは使い込むほど賢くなっていくという自己改善のメカニズムを実現します。

# 実装

## 記憶データモデルの設計

記憶を表現するデータモデルは `pkg/model/memory.go` に定義されています。

```go:pkg/model/memory.go
// Memory represents a stored knowledge claim from a BigQuery sub-agent session
type Memory struct {
	ID        MemoryID
	Claim     string
	QueryText string
	Embedding firestore.Vector32
	Score     float64
	CreatedAt time.Time
	UpdatedAt time.Time
}
```

この `Memory` 構造体の各フィールドには明確な役割があります。`ID` はメモリを一意に識別するための識別子で、今回はUUIDを使用して生成します。このIDはデータベース内のキーとして機能するだけでなく、内省フェーズでLLMが記憶を評価する際にも使用されます。`Claim` フィールドには抽出された知見の本体が格納され、たとえば「GCP監査ログテーブルでは `protopayload_auditlog.resourceName` フィールドを `LIKE` 演算子と組み合わせて使用することが効果的である」といった、具体的な技術的事実が入ります。`QueryText` は記憶を生成した元のクエリテキストで、デバッグやトレーサビリティを確保するために保持します。

`Embedding` フィールドには、GeminiのEmbedding APIを使って `QueryText` から生成した768次元のベクトルが格納されます。このベクトルはFirestoreのベクトル検索で類似記憶を探す際に使用します。ここで重要なのは、`firestore.Vector32` 型を直接使用している点です。この型を使わないとFirestoreがベクトルデータとして認識してくれないため、必ずこの型を使う必要があります。

`Score` フィールドは記憶の有用性を示す評価スコアです。初期値は `0.0` で、役立った場合は `+1.0`、有害だった場合は `-1.0` されます。このスコアによって記憶の品質が管理され、スコアが一定値を下回った記憶は自動的に削除されます。

## Embeddingベースの記憶検索

記憶システムの核心となるのが、Embeddingを使った類似記憶の検索機能です。なお、この検索機能を利用するには事前にFirestoreのベクトル検索インデックスを作成する必要があります（詳細は後述）。エージェントの `Execute` メソッドでは、入力クエリのEmbeddingを生成し、それを使って過去の記憶を検索します。

```go:pkg/agent/bigquery/agent.go
func (a *Agent) Execute(ctx context.Context, query string) (string, error) {
	// Reset session tracking
	a.sessionHistory = []*genai.Content{}

	// (1) Retrieve similar memories if repository is available
	var providedMemories []*model.Memory
	if a.repo != nil {
		// Generate embedding for the query
		embedding, err := a.gemini.Embedding(ctx, query, 768)
		if err != nil {
			if a.output != nil {
				fmt.Fprintf(a.output, "⚠️  Failed to generate embedding for memory search: %v\n", err)
			}
		} else {
			// Search for similar memories (cosine distance threshold 0.8: high similarity, limit 32)
			memories, err := a.repo.SearchMemories(ctx, embedding, 0.8, 32)
			if err != nil {
				if a.output != nil {
					fmt.Fprintf(a.output, "⚠️  Failed to search memories: %v\n", err)
				}
			} else {
				if a.output != nil {
					fmt.Fprintf(a.output, "🔍 Memory search completed: found %d memories (threshold: 0.8)\n", len(memories))
				}
				if len(memories) > 0 {
					providedMemories = memories
				}
			}
		}
	}

	// Build system prompt with context and memories
	systemPrompt := a.buildSystemPrompt(providedMemories)
	// ...
```

この処理は3つのステップで構成されています。まず入力クエリ（自然言語テキスト）をGemini APIで768次元のベクトルに変換します。次に `SearchMemories` メソッドを呼び出し、コサイン類似度0.8以上の記憶を最大32件取得します。コサイン類似度0.8という閾値は比較的高い類似性を要求する設定で、関連性の低い記憶を効果的に除外します。最後に検索結果を `buildSystemPrompt` に渡し、システムプロンプトに組み込みます。

Embeddingベースの検索がもたらす重要な利点は、**意味的に類似したクエリ**に対して過去の知見を活用できることです。たとえば「ログイン失敗を調査」と「認証エラーを確認」は表現が異なりますが、Embedding空間では近い位置に配置されます。そのため、どちらのクエリに対しても同じ記憶が検索され、活用されることになります。

:::message
Firestoreのベクトル検索を利用するには、事前にインデックスを作成する必要があります。以下のコマンドで作成できます。

```bash
gcloud firestore indexes composite create \
    --project=your-project \
    --database=your-database-id \
    --collection-group=memories \
    --query-scope=COLLECTION \
    --field-config=vector-config='{"dimension":"768","flat": "{}"}',field-path=Embedding
```

次元数768はGeminiの `text-embedding-004` モデルの出力次元に対応しています。
:::

## 記憶のスコアリングと削除

内省フェーズでは、記憶の評価結果に基づいてスコアを更新し、低評価の記憶を削除します。この処理は `runIntrospection` メソッド内で実行されます。

```go:pkg/agent/bigquery/agent.go
func (a *Agent) runIntrospection(ctx context.Context, queryText string, providedMemories []*model.Memory, sessionHistory []*genai.Content) error {
	// 内省を実行して知見と記憶評価を取得
	result, err := introspect(ctx, a.gemini, queryText, providedMemories, sessionHistory)
	if err != nil {
		return goerr.Wrap(err, "introspection failed")
	}

	// 新しい知見をEmbeddingと共に保存（省略）
	// ...

	// 役に立った記憶のスコアを +1.0 更新
	for _, memID := range result.HelpfulMemoryIDs {
		a.repo.UpdateMemoryScore(ctx, model.MemoryID(memID), 1.0)
	}

	// 有害だった記憶のスコアを -1.0 更新
	for _, memID := range result.HarmfulMemoryIDs {
		a.repo.UpdateMemoryScore(ctx, model.MemoryID(memID), -1.0)
	}

	// スコアが -3.0 を下回った記憶を削除
	a.repo.DeleteMemoriesBelowScore(ctx, -3.0)

	return nil
}
```

スコアリングの仕組みはシンプルです。記憶の作成時の初期値は `0.0` で、役立った記憶には `+1.0` が加算され、有害だった記憶には `-1.0` が減算されます。スコアが `-3.0` 未満になった記憶は自動的に削除されます。つまり、ある記憶が3回有害と評価されると、その記憶は忘れられることになります。このアルゴリズムはおおいに調整の余地がありますが、ひとまずは理解の促進のためシンプルなものを採用しています。このフィードバックループにより、有用な記憶は強化され続け、有害な記憶は自動的に削除されることが期待されます。これは人間の記憶の忘却曲線に似た仕組みと考えており、繰り返し役立つ情報は長期記憶として定着し、誤った情報は徐々に忘れられていきます。

## エージェントへの記憶統合

ここからは記憶機能を実際にエージェントに統合する方法を解説します。まず内省機能の実装から見ていきましょう。

### 内省機能の実装

内省機能は、セッションの実行内容を振り返って知見を抽出する機能です。この機能の中核はプロンプトの設計にかかっています。内省プロンプトは [pkg/agent/bigquery/prompt/introspect.md](https://github.com/m-mizutani/leveret/blob/day22-memory/pkg/agent/bigquery/prompt/introspect.md) に定義されています。プロンプトは詳細なため全文はリンク先を参照していただくとして、ここでは以下の重要な要素を解説します。

- **セッション情報の提示**: 提供された記憶一覧（Memory IDとContent）、元のクエリテキスト、セッション全体の履歴（ツール呼び出しと結果）をLLMに示します。これにより、LLMはセッション全体を俯瞰して知見を抽出できます。
- **抽出すべき知見の基準**: 抽出すべきものは、次回以降の分析で活用できる技術的知見です。たとえば「〇〇テーブルの××カラムを参照する」といった情報です。一方で抽出すべきでないものは、今回のクエリ結果の要約や今回の分析の結論、一時的な状態といった、再利用性のない情報です。
- **記憶の評価基準**: `helpful_memory_ids` には、実際に活用されて正しい結果を得るのに貢献した記憶のIDを含めます。`harmful_memory_ids` には、明らかに間違っておりエラーや余計な作業を発生させた記憶のIDを含めます。単に使われなかっただけの記憶は評価対象外とし、どちらのリストにも含めません。
- **Few-shot Examples**: 良い抽出例として、テーブル名、カラム名、データ型など再利用可能な技術情報を示します。悪い抽出例として、「検出されなかった」「見つからなかった」といった結果の要約を示します。これにより、LLMが適切な知見を抽出できるようにガイドします。

内省処理の実装は `pkg/agent/bigquery/introspect.go` にあります。まず内省の結果を格納する構造体を定義します。

```go:pkg/agent/bigquery/introspect.go
// introspectionResult contains the output of introspection analysis
type introspectionResult struct {
	Claims           []claim  `json:"claims"`
	HelpfulMemoryIDs []string `json:"helpful_memory_ids"`
	HarmfulMemoryIDs []string `json:"harmful_memory_ids"`
}

func introspect(ctx context.Context, gemini adapter.Gemini, queryText string, providedMemories []*model.Memory, sessionHistory []*genai.Content) (*introspectionResult, error) {
	// Build introspection contents: session history + introspection request
	introspectionContents := make([]*genai.Content, 0, len(sessionHistory)+1)

	// Add all session history (user queries, assistant responses, tool calls, tool results)
	introspectionContents = append(introspectionContents, sessionHistory...)

	// Add introspection request as final user message
	introspectionContents = append(introspectionContents, genai.NewContentFromText(
		"Please analyze the above session execution and extract learnings according to the instructions in the system prompt.",
		genai.RoleUser,
	))

	// Build config with JSON schema for structured output
	config := &genai.GenerateContentConfig{
		SystemInstruction: genai.NewContentFromText(systemPrompt.String(), ""),
		ResponseMIMEType:  "application/json",
		ResponseSchema: &genai.Schema{
			Type: genai.TypeObject,
			Properties: map[string]*genai.Schema{
				"claims": { /* ... */ },
				"helpful_memory_ids": { /* ... */ },
				"harmful_memory_ids": { /* ... */ },
			},
			Required: []string{"claims", "helpful_memory_ids", "harmful_memory_ids"},
		},
	}

	// Generate introspection
	resp, err := gemini.GenerateContent(ctx, introspectionContents, config)
	// ...
}
```

この実装のポイントはセッション履歴全体をLLMに渡すことです。ユーザーのクエリ、LLMの応答、ツール呼び出し、ツールの結果など、すべてのやり取りを含めます。部分的な情報だけでは、なぜそのツールを呼び出したのか、どのような試行錯誤があったのかといった文脈が失われ、正確な知見抽出や記憶評価ができません。全体像を把握することで、LLMは有用な知見を適切に抽出し、提供された記憶が実際に役立ったかどうかを正しく評価できます。

出力は構造化出力を使用します。`claims`（抽出された知見）、`helpful_memory_ids`（役立った記憶のID）、`harmful_memory_ids`（有害だった記憶のID）をJSON形式で取得します。これにより、結果を確実にパースして処理できます。

### BigQueryエージェントへの統合

BigQueryエージェント本体に記憶機能を統合します。実装は [pkg/agent/bigquery/agent.go](https://github.com/m-mizutani/leveret/blob/day22-memory/pkg/agent/bigquery/agent.go) の `Execute` メソッドにあります。`Execute` メソッドの冒頭で、入力クエリのEmbeddingを生成し、類似記憶を検索します。

```go:pkg/agent/bigquery/agent.go
func (a *Agent) Execute(ctx context.Context, query string) (string, error) {
	// Reset session tracking
	a.sessionHistory = []*genai.Content{}

	// (1) Retrieve similar memories if repository is available
	var providedMemories []*model.Memory
	if a.repo != nil {
		// Generate embedding for the query
		embedding, err := a.gemini.Embedding(ctx, query, 768)
		if err != nil {
			if a.output != nil {
				fmt.Fprintf(a.output, "⚠️  Failed to generate embedding for memory search: %v\n", err)
			}
		} else {
			// Search for similar memories (cosine distance threshold 0.8: high similarity, limit 32)
			memories, err := a.repo.SearchMemories(ctx, embedding, 0.8, 32)
			if err != nil {
				if a.output != nil {
					fmt.Fprintf(a.output, "⚠️  Failed to search memories: %v\n", err)
				}
			} else {
				if a.output != nil {
					fmt.Fprintf(a.output, "🔍 Memory search completed: found %d memories (threshold: 0.8)\n", len(memories))
				}
				if len(memories) > 0 {
					providedMemories = memories
				}
			}
		}
	}

	// Build system prompt with context and memories
	systemPrompt := a.buildSystemPrompt(providedMemories)
	// ... 以下、既存の処理
```

検索結果は `buildSystemPrompt` メソッドに渡され、システムプロンプトに組み込まれます。

```go:pkg/agent/bigquery/agent.go
func (a *Agent) buildSystemPrompt(memories []*model.Memory) string {
	// ... テンプレート処理

	// Append memories section if available
	if len(memories) > 0 {
		buf.WriteString("\n\n## Past Knowledge (Memories)\n\n")
		buf.WriteString("The following knowledge was learned from past sessions. Use this information to inform your analysis:\n\n")
		for _, mem := range memories {
			buf.WriteString(fmt.Sprintf("- **Memory ID**: %s\n  **Content**: %s\n\n", mem.ID, mem.Claim))
		}
	}

	return buf.String()
}
```

記憶はMarkdown形式でシステムプロンプトに追加されます。各記憶にはIDとコンテンツが明示されており、LLMが後でフィードバックする際にIDを参照できるようにしています。この設計により、LLMは「Memory ID: xxx が役立った」という形で具体的なフィードバックを返せます。内省プロンプトでは、LLMに `helpful_memory_ids` と `harmful_memory_ids` という配列フィールドでMemory IDを返すよう指示しており、これにより確実に評価対象を特定できます。タスク実行後、セッション履歴を保存して内省を実行します。

```go:pkg/agent/bigquery/agent.go
	// Store session history for introspection
	a.sessionHistory = contents

	// (2) Introspection phase (after execution)
	if a.repo != nil {
		if err := a.runIntrospection(ctx, query, providedMemories, a.sessionHistory); err != nil {
			if a.output != nil {
				fmt.Fprintf(a.output, "⚠️  Introspection failed: %v\n", err)
			}
			// Don't fail the whole execution if introspection fails
		}
	}

	return finalResponse, nil
}

func (a *Agent) runIntrospection(ctx context.Context, queryText string, providedMemories []*model.Memory, sessionHistory []*genai.Content) error {
	// Run introspection using session history
	result, err := introspect(ctx, a.gemini, queryText, providedMemories, sessionHistory)
	if err != nil {
		return goerr.Wrap(err, "introspection failed")
	}

	// Generate embedding for the query
	embedding, err := a.gemini.Embedding(ctx, queryText, 768)
	if err != nil {
		return goerr.Wrap(err, "failed to generate embedding for claims")
	}

	// Save new claims as memories
	if len(result.Claims) > 0 {
		for _, claim := range result.Claims {
			memory := &model.Memory{
				ID:        model.NewMemoryID(),
				Claim:     claim.Content,
				QueryText: queryText,
				Embedding: embedding,
				Score:     0.0,
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			}

			if err := a.repo.PutMemory(ctx, memory); err != nil {
				// エラーログを出力して継続
				continue
			}
		}
	}

	// Update scores for helpful memories
	for _, memID := range result.HelpfulMemoryIDs {
		a.repo.UpdateMemoryScore(ctx, model.MemoryID(memID), 1.0)
	}

	// Update scores for harmful memories
	for _, memID := range result.HarmfulMemoryIDs {
		a.repo.UpdateMemoryScore(ctx, model.MemoryID(memID), -1.0)
	}

	// Delete memories below threshold (-3.0)
	a.repo.DeleteMemoriesBelowScore(ctx, -3.0)

	return nil
}
```

セッション完了後、`runIntrospection` を呼び出して内省を実行します。ここで重要なのは、内省が失敗しても全体の処理は失敗させないという設計です。記憶の更新はベストエフォートで行い、本来のタスクの実行結果には影響を与えません。

内省結果に基づいて、以下の4つの処理を順に実行します。まず新たに抽出された知見（claims）を記憶としてデータベースに保存します。次に役立った記憶のスコアを `+1.0` 更新します。さらに有害だった記憶のスコアを `-1.0` 更新します。最後にスコアが `-3.0` を下回った記憶を削除します。

これにより、記憶の品質が自動的に管理されます。有用な知見はスコアが上がって強化され、有害な知見はスコアが下がって最終的に削除されます。このフィードバックループが、エージェントの自己改善メカニズムを形成します。

# 実践例：類似インシデント記憶の活用

実際に記憶システムがどのように動作するか、実行結果を見てみましょう。ここでは、Cryptominer（xmrig）プロセスの起動を検知したアラートに対して、影響範囲をBigQueryログから調査するというシナリオを例に説明します。このアラートには対象インスタンス（web-server-prod-01）、検出時刻、外部接続先IPアドレス（185.220.101.42）などの情報が含まれています。

以下は実際の出力からの抜粋です。

```
> このアラートの影響をログから調べて

⠼ evaluating...
📋 計画を生成中...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 ステップ 1/3 (完了: 0): step_1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
影響を受けたインスタンスweb-server-prod-01に対する、指定された期間内の全ての監査ログとシステムログをBigQueryから検索し、xmrigプロセスの起動に関するログ、および外部IPアドレス185.220.101.42への接続に関するログを確認する。

⠴ evaluating...🔍 Memory search completed: found 32 memories (threshold: 0.8)
```

最初のステップでBigQueryサブエージェントが呼び出されると、コサイン類似度0.8以上の閾値で**32件の類似記憶**が検索されています。これらは過去のセッションで蓄積された知見です。記憶が検索されることで、エージェントは過去の経験を活かしてタスクを実行できます。

セッション完了後の内省フェーズでは、以下のような出力が表示されます。

```
[BigQuery Agent] 🤔 振り返り中...
⠋ evaluating...
[BigQuery Agent] 💡 新たな知見を抽出 (5件):
  - [20fe7532...] cloudaudit_googleapis_com_system_eventテーブルでは、`textPayload`フィールドにプロセス起動やIPアドレス関連の情報が含まれる場合があるため、これに対して`LIKE`検索を行うことが有効である。
  - [cb98129d...] cloudaudit_googleapis_com_activityおよびcloudaudit_googleapis_com_data_accessテーブルでは、`jsonPayload`は直接検索できるフィールドではなく、構造化されたログデータとして格納されている。特定のキーワードを検索するには、`TO_JSON_STRING(protopayload_auditlog)`や`TO_JSON_STRING(httpRequest)`のように、関連する構造体全体を文字列に変換してから`LIKE`演算子を使用する必要がある。
  - [92d38bf3...] GCP監査ログテーブルでは、特定のCompute Engineインスタンス（例: `web-server-prod-01`）に対するログをフィルタリングするために、`protopayload_auditlog.resourceName`フィールドを`LIKE`演算子と組み合わせて使用することが効果的である。
  - ... (他2件)

[BigQuery Agent] 👍 役に立った記憶 (9件):
  - [4fa697e3...] 特定のプロセス（例: xmrig）のログエントリを検索する場合、textPayloadフィールドは、より広範な情報を含む可能性があり、jsonPayloadの特定の構造が不明な場合に有用な検索対象となる (スコア +1.0)
  - [95076c26...] BigQueryのcloudaudit_googleapis_com_system_eventテーブルの`textPayload`フィールドは、シリアルポートログの内容や特定のキーワード（'login', 'command', 'sudo', 'apt', 'yum', 'configure', 'changed configuration'）およびIPアドレス（'185.220.101.42'）を検索するのに適している。 (スコア +1.0)
  - [f2bf73bd...] 異なるスキーマを持つ複数のテーブルに対してUNION ALLを使用する場合、各SELECT句で同じ数のカラムと互換性のあるデータ型を返す必要がある。そうしないと、'Queries in UNION ALL have mismatched column count'エラーが発生する。 (スコア +1.0)
  ...

[BigQuery Agent] 👎 有害だった記憶 (1件):
  - [069f2b15...] BigQueryのcloudaudit_googleapis_com_system_eventテーブルには、`jsonPayload`カラムが存在しない。ログの内容を検索する際は`textPayload`を使用する。 (スコア -1.0)
```

この出力から、内省フェーズで3つの重要な処理が行われていることがわかります。まず**新たな知見を5件抽出**しています。GCP監査ログのクエリ方法に関する具体的なノウハウが記憶としてデータベースに保存されました。これらの知見は次回以降の類似タスクで活用されます。

次に**役立った記憶を9件評価**しています。過去の記憶のうち、今回のセッションで実際に役立ったものにスコア `+1.0` が付与されました。これにより、有用な記憶は強化されていきます。

最後に**有害だった記憶を1件評価**しています。誤った情報を含む記憶にスコア `-1.0` が付与されました。この記憶があと2回有害と評価されれば、スコアが `-3.0` を下回って自動削除されます。

このように、記憶システムは自己改善していく仕組みとなっています。セッションを重ねるごとに有用な知見が蓄積され、誤った知見は削除されます。これにより、エージェントは使い込むほど賢くなっていくことが期待されます。

# まとめ

今回は例としてサブエージェントの記憶システムを実装しました。しかしこれが最適なアプローチなのかは引き続き検証の余地があります。サブエージェントという限られたドメインのなかで記憶を取り回すことには、タスクが具体的で入力が単純化されているという点で一定の優位性があると筆者は考えていますが、他のアプローチとの比較検討はまだ十分ではありません。

記憶機能はユースケースと密接に結びついており、それに応じて記憶自体のデータモデル、内省プロンプト、検索と提供のワークフロー、そして評価および整理の管理システムの実装方法が大きく異なってきます。セキュリティ分析における記憶管理、開発支援における記憶管理、カスタマーサポートにおける記憶管理では、求められる記憶の粒度も評価基準も異なるでしょう。これは今後いろいろなドメインで模索されていくことが期待され、筆者自身も取り組んでいくつもりです。
