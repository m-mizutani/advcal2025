---
title: "会話コンテキストの圧縮戦略"
emoji: "💬"
type: "tech"
topics: ["LLM", "Agent"]
published: false
---

この記事はアドベントカレンダー「Goで作るセキュリティ分析生成AIエージェント」の13日目です。

# トークン制限の課題

- これまで散々述べてきたが、生成AIエージェントで必ず起きる問題がコンテキストウィンドウ（トークン限界）の超過

## 生成AIにおけるトークンに関する基礎知識
- ここでいうトークンは生成AI（特にLarge Language Model）の処理用に分割された文字列
- 1単語＝1トークンとなることが多いが、必ずしもそうではない
- 記号なども1トークンとして表される
- トークンは原則としてサービスに問い合わせないとわからない
- Geminiの場合、トークン数取得は無料

```go:
client, err := genai.NewClient(ctx, &genai.ClientConfig{
    Project:  os.Getenv("GEMINI_PROJECT"),
    Location: location,
    Backend:  genai.BackendVertexAI,
})
if err != nil {
    return goerr.Wrap(err, "failed to create genai client")
}

// Count tokens
contents := genai.Text(text)
resp, err := client.Models.CountTokens(ctx, model, contents, nil)
if err != nil {
    return goerr.Wrap(err, "failed to count tokens")
}

fmt.Printf("Token count: %d tokens\n", resp.TotalTokens)
```

実行してみるとこうなる

```bash
$ cd examples/count-token
$ env GEMINI_PROJECT=your-project go run . "hello world"
Token count: 2 tokens
$ go run . '{"hello":"world"}'
Token count: 5 tokens
% zenv go run . 'こんにちは'
Token count: 1 tokens
% go run . '寿限無寿限無五劫の擦り切れ'
Token count: 12 tokens
```

## 生成AIエージェント利用時のトークン制限問題

- モデルごとのトークン限界は徐々に増えているが、それでも有限
- 例えばgeminiは100万トークン（正確には 1,048,576 トークン）が限界
  - これは非常に長い（テキスト換算でおよそ4MB程度）が、それでも有限
- 生成AIエージェントでトークン制限が問題になるのは大きく分けると2つのケースがある

### (1) 会話が続くことで履歴が長くなる
- すでに実装した通り生成AIエージェントとの「会話」の実態は「都度会話の履歴を全部投げつける」ということ
- そのため会話が続くと自ずと履歴が長くなり、個々のメッセージが短くても全体でトークン限界を超過するようになってしまう

### (2) 一度に長いメッセージが投入される場合
- ユーザから入力される場合、例えばでかいファイルやログデータのようなものを入れようとすると起こりがち
- ツール実行で起こる場合、ツールの実行結果が非常に大きい（例えばこちらもログなど）

# 会話履歴の要約と戦略

- 会話履歴が限界を超えた場合に削る(削除する)ことはできる
- しかしそれだと過去に会話した内容を「忘れて」しまうことになる
- 最初に重要な指示があった場合、それを取りこぼしてしまうのは問題
- ではどうするかというと、会話を要約するすることでサイズを圧縮する
- 情報量を保った単なる圧縮ではなく要約をすることで要点だけを残す
  - 例えば途中のクエリを投げた際のリクエスト・レスポンスや、知見を得る前の生ログは、のちの処理にはあまり意味がない
  - 単純な可逆圧縮のようなものではなく、重要度の高い情報を残すということができる
    - ただしもちろん情報の欠落は一定起きるので、やらないに越したことはない

## 要約の具体的方法

- 大容量のデータを要約する方法もいくつかある
- 今回はシンプルに要約をLLMにクエリする
  - もともとトークン限界に収まっていたデータのサイズを圧縮したいだけだから
  - 必要な履歴データをそのままつっこむ
  - より高度な要約方法（例えば分割して断片の要約を作成してそれらを統合する手法）もあるが、今回は扱わないので自分で調べてね

## 要約の方針

- 単に「要約して」だけだとバクっとしたまとめになったり、重要な情報が欠如する
- そのためどういう情報を残すべきかをちゃんとプロンプトエンジニアリングで指示してあげる必要がある
- これはタスクによって方針が結構変わってくる
  - そのためエージェントごとに調整しうる部分
- セキュリティ分析を主にするときに重要そうなこと
  - ユーザからの指示、質問および何をゴールにしているか
  - 分析の過程で得られた重要な知見や攻撃に関する情報
  - IOC
  - 重要度・影響度の判定に利用できそうな証跡・痕跡
  - 調査作業の進行状況や文脈
  - 次以降の調査に必要そうな手がかり
  - ネクストステップ
- 逆にいらなさそうなもの
  - ツール呼び出しの詳細や、その結果の丸ごとのデータ。ツール利用失敗の履歴など
  - 調査の過程で得られた冗長な情報
  - 調査の過程そのもの。手続自体の詳細
- こういった指示をもとに圧縮させる

## 要約の範囲

- 現状の会話履歴を全部要約するという手もあるが必ずしもその限りでなくてもよい
- 新しい会話は残すとか
  - 例えば要約対象は古い方の70％ぐらいにしておく
  - 新しい30％を残すと直近の文脈は失われにくくなる
- このあたりの勘所もタスクによって多少変わってくる

## いつ要約するか

- トークンサイズを監視しながらある一定値を超えたら圧縮というのもできる
  - ただし例えばGeminiは（無料ではあるものの）正確なtoken countはAPIを呼び出すしかない
  - 無料ではあるが毎回チェックしていると応答時間が劣化する
- なのでトークン超過エラーが起きたら発火するでもいい
- 例えばGeminiの場合のエラーは `examples/too-large-request/main.go` を使うと確認できる
- ただし注意点としてAPI側の挙動が変わる（メッセージが変更される）場合などに影響を受けるので注意
  - AI関連のツールやサービスはこういう仕様の更新が早い＝不安定になる

```bash
% cd examples/too-large-request
% env GEMINI_PROJECT=your-project go run .
APIError - Code:400 Status:INVALID_ARGUMENT Message:The input token count (2500030) exceeds the maximum number of tokens allowed (1048576). Details:[]
```

# 実装例

```go:pkg/usecase/chat/session.go
resp, err := s.gemini.GenerateContent(ctx, s.history.Contents, config)
if err != nil {
    // Check if error is due to token limit exceeded
    if isTokenLimitError(err) {
        // Attempt compression
        fmt.Println("\n📦 Token limit exceeded. Compressing conversation history...")

        compressedContents, compressErr := compressHistory(ctx, s.gemini, s.history.Contents)
        if compressErr != nil {
            return nil, goerr.Wrap(compressErr, "failed to compress history")
        }

        // Update history with compressed contents
        s.history.Contents = compressedContents

        // Save compressed history immediately
        if saveErr := saveHistory(ctx, s.repo, s.storage, s.alertID, s.history); saveErr != nil {
            fmt.Printf("⚠️  Warning: failed to save compressed history: %v\n", saveErr)
        }

        fmt.Println("✅ Conversation history compressed successfully. Retrying...")
        continue // Retry with compressed history
    }
    return nil, goerr.Wrap(err, "failed to generate content")
}
```

- （先述した通り）シンプルにエラーがおきたときに要約を試みる
- 要約されたhistoryを差し替えるようにしてリトライする
- トークン超過エラーじゃなければそのままエラーを帰す

```go
	// Calculate byte size for each content
	totalBytes := 0
	byteSizes := make([]int, len(contents))
	for i, content := range contents {
		size := contentSize(content)
		byteSizes[i] = size
		totalBytes += size
	}

	// Calculate compression threshold (70% of total bytes)
	compressThreshold := int(float64(totalBytes) * compressionRatio)

	// Find the index where we cross the 70% threshold
	cumulativeBytes := 0
	compressIndex := 0
	for i, size := range byteSizes {
		cumulativeBytes += size
		if cumulativeBytes >= compressThreshold {
			compressIndex = i + 1 // Include this message in compression
			break
		}
	}

	// If compression index is 0 or at the end, nothing to compress
	if compressIndex == 0 || compressIndex >= len(contents) {
		return nil, goerr.New("insufficient content to compress")
	}
```

- `compressHistory` ではまずターゲットとなる履歴部分を抽出する
- ここでは対象をバイト数で計算している
  - 本来はトークン数と誤差があるが都度APIでトークン数問い合わせしていると遅延がすごくなる
  - あとレートリミットに引っかかる恐れもある
  - ということで多少粗くともローカルで計算しちゃう

```go
	// Extract contents to compress and to keep
	toCompress := contents[:compressIndex]
	toKeep := contents[compressIndex:]

	// Generate summary of compressed contents
	summary, err := summarizeContents(ctx, gemini, toCompress)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to summarize contents")
	}

	// Create summary content as user message
	summaryContent := &genai.Content{
		Role: genai.RoleUser,
		Parts: []*genai.Part{
			{Text: "=== Previous Conversation Summary ===\n\n" + summary},
		},
	}

	// Return new history: summary + kept contents
	newContents := append([]*genai.Content{summaryContent}, toKeep...)
	return newContents, nil
}
```

- 要約対象の履歴はまとめる
- その結果と、要約非対称の履歴をくっつけて返す

```markdown
You are an assistant for security alert analysis.

## Context and Purpose

The conversation history has exceeded the token limit. Create a summary that will replace the older parts of the conversation, preserving all critical information needed to continue the security investigation.

This summary will be inserted at the beginning of the conversation history. Focus on what matters for ongoing analysis, not the investigation process itself.

## What to Preserve (Highest Priority)

**1. User's Intent and Goals (MOST CRITICAL)**
- User's questions and what they want to know
- Investigation goals and what conclusion the user seeks
- Explicit instructions or constraints the user has given
- User's concerns or areas of focus

**2. Attack and Security Intelligence**
- Key findings about the incident (malicious/benign/false positive)
- Attack patterns, techniques, TTPs identified
- IOCs: IP addresses, domains, file hashes, URLs, email addresses, usernames
- Evidence supporting severity/impact assessment
- Timeline of the attack or suspicious activities

**3. Investigation Progress and Context**
- Current state of the investigation
- Important insights or discoveries from the analysis
- Clues or leads for next steps
- What has been verified vs. what remains uncertain

**4. Next Steps and Actions**
- Recommended next steps in the investigation
- Decisions requiring user input
- Outstanding questions that need answers

## What to Deprioritize or Omit (Lowest Priority)

**Do NOT include:**
- Tool call details (function names, parameters, how they were invoked)
- Full tool output or raw data dumps
- Failed tool calls or error messages
- Exploratory queries that yielded no useful information
- The investigation process itself (step-by-step procedures)
- Redundant or repeated information
- Assistant's internal reasoning or thought process

**Remember:** Summarize RESULTS and FINDINGS, not the PROCESS of obtaining them.

## Output Format

Format the summary in markdown:

- **User's Goals**: What the user wants to achieve or understand
- **Investigation Status**: Current understanding of the incident
- **Key Findings**: Critical security conclusions and determinations
- **Attack Intelligence**: IOCs, TTPs, timeline, attack patterns
- **Evidence**: Important facts supporting severity/impact assessment
- **Next Steps**: What to investigate next or decisions needed
- **Open Questions**: Unresolved issues requiring attention

Be extremely concise. One sentence per point is ideal. Preserve facts, not explanations.
```

- 要約するときのシステムプロンプトはこんな感じ
- あくまで一例で全然調整しうる
- このあたりは実際に動かしてみながら調整をするしか無い

# まとめ
