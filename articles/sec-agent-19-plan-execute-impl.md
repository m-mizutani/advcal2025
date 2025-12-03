---
title: "Goで作るセキュリティ分析LLMエージェント(19): エージェント実行の高度な制御 (2) Plan & Execute の実装"
emoji: "🔄"
type: "tech"
topics: ["ai", "go", "llm", "agent"]
published: false
---

この記事はアドベントカレンダー「[Goで作るセキュリティ分析LLMエージェント](https://adventar.org/calendars/11354)」の19日目です。

今回のコードは https://github.com/m-mizutani/leveret の [day19-plan-execute](https://github.com/m-mizutani/leveret/tree/day19-plan-execute-impl) ブランチに格納されていますので適宜参照してください。また今回は前日の設計に基づいた実装になっているため、先にそちらの記事を閲覧されることをおすすめします。

# Plan & Executeの実装の大まかな流れ

- まず具体的な処理の流れをみていく
- 昨日提示したこのループを表現するコードを見ていく

```mermaid
flowchart TD
    Start([ユーザ入力]) --> Judge{計画が<br/>必要か?}
    Judge -->|不要| Simple[通常の応答]
    Judge -->|必要| Plan[計画を立てる]

    Plan --> Execute[ステップを実行]
    Execute --> Reflect[内省]

    Reflect --> Check{目的達成?}
    Check -->|未達成| Update[計画を更新]
    Update --> Execute

    Check -->|達成| Report[結論を提出]

    Simple --> End([終了])
    Report --> End

    style Start fill:#e1f5ff
    style End fill:#e1f5ff
    style Judge fill:#fff4e1
    style Check fill:#fff4e1
    style Plan fill:#f0e1ff
    style Execute fill:#e1ffe1
    style Reflect fill:#ffe1e1
    style Update fill:#f0e1ff
    style Report fill:#e1ffe1
```


- `sendWithPlanExecute` がPlan & Executeの中核をなす実装
- 既存の `Send` を壊さないよう、別立ての実装にしている

```go:pkg/usecase/chat/session.go
// sendWithPlanExecute executes the plan & execute mode
func (s *Session) sendWithPlanExecute(ctx context.Context, message string) (*PlanExecuteResult, error) {

	// Initialize plan & execute components
	planGen := newPlanGenerator(s.gemini, s.registry)
	conclusionGen := newConclusionGenerator(s.gemini)

	// Step 1: Generate plan
	fmt.Printf("\n📋 計画を生成中...\n")
	plan, err := planGen.Generate(ctx, message, s.alert)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to generate plan")
	}
	displayPlan(plan)
```

- まずここまででPlanを作成し、ユーザに提示する

```go
	// Step 2-4: Execute plan with reflection loop
	results, reflections, err := executeStepsWithReflection(ctx, s.gemini, s.registry, plan)
	if err != nil {
		return nil, err
	}
```

その後、 `executeStepsWithReflection` でツール実行とPlan修正（reflection）のループに入る

```go
	// Step 5: Generate conclusion
	fmt.Printf("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
	fmt.Printf("📝 結論を生成中...\n")
	fmt.Printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n")

	conclusion, err := conclusionGen.Generate(ctx, plan, results, reflections)
	if err != nil {
		return nil, goerr.Wrap(err, "failed to generate conclusion")
	}
```

- 最終的にループから得られた情報をもとに結論を生成する
- では設計にあった(0)のPlan & Executeを使うかどうかの判定はというと、これは `Send` 側に実装している

```go
// Check if plan & execute mode should be used
if shouldUsePlanExecuteMode(ctx, s.gemini, message, s.history.Contents) {
    // Use plan & execute mode
    result, err := s.sendWithPlanExecute(ctx, message)
    if err != nil {
        return nil, goerr.Wrap(err, "Plan & Execute mode failed")
    }
    // Plan & Execute mode succeeded
    // Convert to response format (create a synthetic response)
    return s.createResponseFromPlanExecute(result), nil
}
```

- もとの `Send` の冒頭で問い合わせるようにしている
- これによって通常処理か、あるいはplan & executeかを自動的に選択している

```go
func (s *Session) Send(ctx context.Context, message string) (*genai.GenerateContentResponse, error) {
	// Check if plan & execute mode should be used
	if shouldUsePlanExecuteMode(ctx, s.gemini, message, s.history.Contents) {
		// Use plan & execute mode
		result, err := s.SendWithPlanExecute(ctx, message)
		if err != nil {
			return nil, goerr.Wrap(err, "Plan & Execute mode failed")
		}
		// Plan & Execute mode succeeded
		// Convert to response format (create a synthetic response)
		return s.createResponseFromPlanExecute(result), nil
	}
```

- ここまでが全体の流れ
- ここから各処理を見ていく

# Plan & Execute の各処理の実装

## 計画生成

```md
# Plan Generation

## Your Role

You are a security analyst assistant. Your role is to support security alert analysis and create systematic plans for various tasks.

## User Request

{{.Request}}

## Alert Context

**Alert ID**: {{.AlertID}}
**Title**: {{.AlertTitle}}
**Description**: {{.AlertDescription}}

### Extracted Attributes

{{ if .AlertAttributes }}
{{- range .AlertAttributes }}
- **{{ .Key }}** ({{ .Type }}): {{ .Value }}
{{- end }}
{{ else }}
(No attributes extracted)
{{ end }}

### Raw Alert Data

{{ .AlertDataJSON }}
```





# まとめ
