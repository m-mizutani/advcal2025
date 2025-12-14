---
title: "Goで作るセキュリティ分析LLMエージェント(22): エージェントの記憶システム実装"
emoji: "💾"
type: "tech"
topics: ["ai", "go", "llm", "rag"]
published: false
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の22日目です。

今回のコードは https://github.com/m-mizutani/leveret の [day22-memory](https://github.com/m-mizutani/leveret/tree/day22-memory) ブランチに格納されていますので適宜参照してください。また今回は前日に解説した記憶機能の概要に基づいた実装となっているため、先にそちらの記事を閲覧されることをおすすめします。

# 記憶システムの実装方針

- 今回の記憶システムは過去に実装したBigQueryサブエージェント内に実装する
- サブエージェント内に記憶を持つ理由
  - 実行するのが「BigQueryへのクエリと結果取得」という限られたタスクであるため、ドメインも閉じられており管理や整理がしやすい
  - 作業が単発的に完結するため前後関係や文脈の情報もあまり必要ない
  - 入力されるクエリが文脈を解した内容になっている。これがかなり重要
    - セキュリティ分析だとメインのエージェントに投げかけられる問はアラートのデータやそれまでの会話履歴を意識したものになっている
    - そのためユーザの直接の入力から実際にやるべき内容の抽出と、それに対応する記憶を探すというのはかなり難しい
    - 一方でBigQueryエージェントには「〜を探せ」のようなかなり具体化・単純化された入力しか入ってこない
    - そこまで具体化・単純化されたものだとEmbeddingによって関連する情報を探すというのがかなり現実的になる（と筆者は考えた）
- 前回も説明した通り、筆者もセキュリティ分析におけるエージェントの記憶管理の最適解は模索している最中である
  - そのため今回実装するのはあくまで一例であり、エージェントの記憶管理をイメージしてもらうためと考えてほしい

# 実装する記憶機能の大まかなながれ

- 初回の実行ではこれまでどおりのサブエージェントとしての機能を実行する
  - 最後に「内省」の機能を発動させる
  - ここで次回以降の実行に役立ちそうな情報を抽出する
  - 抽出した情報はEmbeddingされたサブエージェントへの入力とともにDBに格納される
- 2回目以降の実行時にはその記憶を検索して利用する
  - Embeddingで類似するクエリに関する記憶を検索する
  - 検索する際は類似度（コサイン類似度）をつかい足切りをする
  - さらにプロンプトの溢れを防ぐため、件数の上限を定めておく
  - この記憶をシステムプロンプトに組み込んでタスクを実行する
- 2回目以降では「内省」時に新しい記憶になりそうな情報を抽出するだけでなく、記憶の評価をする
  - 役に立った記憶と役に立たなかった間違った記憶を申告させる
  - 役に立ったら加点、間違っていたら減点をする
  - これによって忘れるべき記憶と保持し続けるべき記憶の選別をする
  - 新しい記憶も合わせて保存をする
- これを繰り返すことによって記憶を精錬させていくというモデル

# 記憶データモデルの設計

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

この構造体の各フィールドには明確な役割があります。

- `ID`: 一意な識別子。なんでもいいが、今回はUUIDで作成。DB内のキーだけでなくフィードバック時にLLMに指定するためにも利用する
- `Claim`: 抽出された知見の本体。「GCP監査ログテーブルでは`protopayload_auditlog.resourceName`フィールドを`LIKE`演算子と組み合わせて使用することが効果的である」といった具体的な事実が格納されます
- `QueryText`: 記憶を生成した元のクエリテキストです。デバッグやトレーサビリティに使用します
- `Embedding`: GeminiのEmbedding APIで `QueryText` から生成した768次元のベクトル。Firestoreのベクトル検索で類似記憶を探す際に使用します
- `Score`: 記憶の有用性を示す評価スコアです。初期値は0.0で、役立った場合は+1.0、有害だった場合は-1.0されます

- ポイントは、`Embedding` フィールドに `firestore.Vector32` 型を直接使用していること
- Embeddingのときにも説明したが、この型をつかわないとfirestoreがvectorデータであると認識してくれない



# Embeddingベースの記憶検索

記憶システムの核心となるのが、Embeddingを使った類似記憶の検索です。エージェントの `Execute` メソッドでは、入力クエリのEmbeddingを生成し、それを使って過去の記憶を検索します。

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
			// Search for similar memories (cosine distance threshold 0.8, limit 32)
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

この処理の流れは以下の通りです。

1. **Embeddingの生成**: 入力クエリ（自然言語テキスト）をGemini APIで768次元のベクトルに変換します
2. **類似記憶の検索**: `SearchMemories` を呼び出し、コサイン類似度0.8以上の記憶を最大32件取得します
3. **プロンプトへの組み込み**: 検索結果は `buildSystemPrompt` に渡され、system promptに追加されます

重要なのは、Embeddingベースの検索により**意味的に類似したクエリ**に対して過去の知見を活用できる点です。たとえば「ログイン失敗を調査」と「認証エラーを確認」は表現が異なりますが、Embedding空間では近い位置に配置されるため、同じ記憶が検索されます。

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

# 記憶のスコアリングと削除

内省フェーズでは、記憶の評価結果に基づいてスコアを更新し、低評価の記憶を削除します。この処理は `runIntrospection` 内で実行されます。

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

スコアリングの仕組み:

- **初期値**: 記憶の作成時は `0.0`
- **加点**: 役立った記憶は `+1.0`
- **減点**: 有害だった記憶は `-1.0`
- **削除**: スコアが `-3.0` 未満になった記憶は自動削除（3回有害と評価されたら削除）

このフィードバックループにより、有用な記憶は強化され、有害な記憶は自動的に削除されることが期待される

# セキュリティ分析における記憶の活用

## 内省機能の実装

### 内省プロンプトの設計

内省プロンプト（[pkg/agent/bigquery/prompt/introspect.md](https://github.com/m-mizutani/leveret/blob/day22-memory/pkg/agent/bigquery/prompt/introspect.md)）の重要な要素:

- **セッション情報の提示**
  - 提供された記憶一覧（Memory IDとContent）
  - 元のクエリテキスト
  - セッション全体の履歴（ツール呼び出しと結果）

- **抽出すべき知見の基準**
  - ✅ 抽出すべき: 次回以降の分析で活用できる技術的知見（例: 「〇〇テーブルの××カラムを参照する」）
  - ❌ 抽出すべきでない: 今回のクエリ結果の要約、今回の分析の結論、一時的な状態

- **記憶の評価基準**
  - `helpful_memory_ids`: 実際に活用され、正しい結果を得るのに貢献した記憶
  - `harmful_memory_ids`: 明らかに間違っており、エラーや余計な作業を発生させた記憶
  - 評価対象外: 単に使われなかっただけの記憶

- **Few-shot Examples**
  - 良い抽出例: テーブル名、カラム名、データ型など再利用可能な技術情報
  - 悪い抽出例: 「検出されなかった」「見つからなかった」といった結果の要約

### 内省処理の実装

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

実装のポイント:

- **セッション履歴全体をLLMに渡す**: ユーザーのクエリ、LLMの応答、ツール呼び出し、ツールの結果など、すべてのやり取りを含める
- **構造化出力**: `claims`（抽出された知見）、`helpful_memory_ids`（役立った記憶のID）、`harmful_memory_ids`（有害だった記憶のID）をJSON形式で取得
- **プロンプトテンプレート**: 提供された記憶とクエリテキストを動的に埋め込む

## エージェントへの記憶統合

BigQueryエージェント本体に記憶機能を統合します。[pkg/agent/bigquery/agent.go](https://github.com/m-mizutani/leveret/blob/day22-memory/pkg/agent/bigquery/agent.go) の `Execute` メソッドを修正します。

### 記憶の検索と活用

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
			// Search for similar memories (cosine distance threshold 0.8, limit 32)
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

`Execute` メソッドの冒頭で、入力クエリのEmbeddingを生成し、類似記憶を検索します。検索結果は `buildSystemPrompt` に渡され、system promptに組み込まれます。

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

記憶はMarkdown形式でsystem promptに追加されます。各記憶にはIDとコンテンツが明示され、LLMが後でフィードバックする際にIDを参照できるようにしています。

### 内省の実行とフィードバック

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

セッション完了後、`runIntrospection` を呼び出して内省を実行します。内省が失敗しても全体の処理は失敗させないという設計になっています。内省結果に基づいて以下の処理を実行します。

1. 新たに抽出された知見（claims）を記憶として保存
2. 役立った記憶のスコアを+1.0更新
3. 有害だった記憶のスコアを-1.0更新
4. スコアが-3.0を下回った記憶を削除

これにより、記憶の品質が自動的に管理され、有用な知見は強化され、有害な知見は削除されるフィードバックループが形成されます。

# 実践例：類似インシデント記憶の活用

実際に記憶システムがどのように動作するか、実行結果を見てみましょう。以下は実際の出力からの抜粋です。

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

最初のステップでBigQueryサブエージェントが呼び出されると、**32件の類似記憶**が検索されています。これらは過去のセッションで蓄積された知見です。

```
[BigQuery Agent] 🤔 振り返り中...
⠋ evaluating...
[BigQuery Agent] 💡 新たな知見を抽出 (5件):
  - [20fe7532...] cloudaudit_googleapis_com_system_eventテーブルでは、`textPayload`フィールドにプロセス起動やIPアドレス関連の情報が含まれる場合があるため、これに対して`LIKE`検索を行うことが有効である。
  - [cb98129d...] cloudaudit_googleapis_com_activityおよびcloudaudit_googleapis_com_data_accessテーブルでは、`jsonPayload`は直接検索できるフィールドではなく、構造化されたログデータとして格納されている。特定のキーワードを検索するには、`TO_JSON_STRING(protopayload_auditlog)`や`TO_JSON_STRING(httpRequest)`のように、関連する構造体全体を文字列に変換してから`LIKE`演算子を使用する必要がある。
  - [41adcd89...] 複数の監査ログテーブル（cloudaudit_googleapis_com_system_event, cloudaudit_googleapis_com_activity, cloudaudit_googleapis_com_data_access）を`UNION ALL`で結合する際、各`SELECT`ステートメントで同じカラム名と互換性のあるデータ型を返す必要がある。存在しないカラムは`CAST(NULL AS STRING)`などで補完する必要がある。
  - [92d38bf3...] GCP監査ログテーブルでは、特定のCompute Engineインスタンス（例: `web-server-prod-01`）に対するログをフィルタリングするために、`protopayload_auditlog.resourceName`フィールドを`LIKE`演算子と組み合わせて使用することが効果的である。
  - [38761c52...] 過去24時間以内のログを検索するには、`timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)`という条件を使用する。

[BigQuery Agent] 👍 役に立った記憶 (9件):
  - [4fa697e3...] 特定のプロセス（例: xmrig）のログエントリを検索する場合、textPayloadフィールドは、より広範な情報を含む可能性があり、jsonPayloadの特定の構造が不明な場合に有用な検索対象となる (スコア +1.0)
  - [95076c26...] BigQueryのcloudaudit_googleapis_com_system_eventテーブルの`textPayload`フィールドは、シリアルポートログの内容や特定のキーワード（'login', 'command', 'sudo', 'apt', 'yum', 'configure', 'changed configuration'）およびIPアドレス（'185.220.101.42'）を検索するのに適している。 (スコア +1.0)
  - [f2bf73bd...] 異なるスキーマを持つ複数のテーブルに対してUNION ALLを使用する場合、各SELECT句で同じ数のカラムと互換性のあるデータ型を返す必要がある。そうしないと、'Queries in UNION ALL have mismatched column count'エラーが発生する。 (スコア +1.0)
  ...

[BigQuery Agent] 👎 有害だった記憶 (1件):
  - [069f2b15...] BigQueryのcloudaudit_googleapis_com_system_eventテーブルには、`jsonPayload`カラムが存在しない。ログの内容を検索する際は`textPayload`を使用する。 (スコア -1.0)
```

セッション完了後、内省フェーズで以下が実行されています。

- **新たな知見を5件抽出**: GCP監査ログのクエリ方法に関する具体的なノウハウが記憶として保存されました
- **役立った記憶を9件評価**: 過去の記憶のうち、今回のセッションで実際に役立ったものにスコア+1.0が付与されました
- **有害だった記憶を1件評価**: 誤った情報を含む記憶にスコア-1.0が付与され、3回有害と評価されれば自動削除されます

このように、記憶システムは自己改善していく仕組みとなっています。セッションを重ねるごとに有用な知見が蓄積され、エージェントの性能が向上します。

# まとめ

本日はBigQueryサブエージェントに記憶システムを実装しました。

記憶システムは以下の要素で構成されています。

- **記憶データモデル**: ID、知見、Embedding、スコアを持つ構造体
- **永続化層**: Firestoreを使用した保存・ベクトル検索・スコア管理
- **内省機能**: セッション履歴全体を分析して知見を抽出
- **エージェント統合**: 記憶の検索・活用・フィードバックのループ

実装のポイントは、**LLMが記憶の有用性を評価し、スコアとして反映する**ことで、記憶の品質が自動的に管理される点です。有用な記憶は強化され、有害な記憶は削除されるため、使い込むほど賢くなるエージェントが実現できます。

また、Firestoreのベクトル検索により、入力クエリと意味的に類似した過去の知見を効率的に取得できるため、スケールしても性能を維持できます。

次回は、このような高度なエージェント機能をテストする方法について解説します。
