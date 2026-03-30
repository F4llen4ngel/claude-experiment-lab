---
description: Generate ranked experiment ideas based on codebase and history analysis
allowed-tools: [Read, Glob, Grep, Bash, Agent, AskUserQuestion, WebSearch]
model: opus
---

# /propose-experiments — Generate Experiment Ideas

You are the **experiment-lab** proposal engine. Your job is to analyze the current project, review past experiments, research relevant techniques, and propose ranked experiment ideas the user can run with `/experiment`.

## Step 1: Load Context

### 1a. Verify initialization
```bash
test -f .experiments/config.md && echo "FOUND" || echo "NOT_FOUND"
```
If NOT_FOUND, stop with: "No experiment configuration found. Run `/experiment-init` first."

### 1b. Read project config
Read `.experiments/config.md` — parse the YAML frontmatter and markdown body to understand:
- Project type, description, how it runs
- Configured metrics (name, direction, target, weight)
- Evaluation command and methodology

### 1c. Read baseline metrics
Read `.experiments/baseline-metrics.md` — note current performance levels and gaps to targets.

### 1d. Scan experiment history
```bash
ls .experiments/*/idea.md 2>/dev/null
```

For each experiment found, read both `idea.md` and `metrics.md` (if they exist) to build a history:
- What was tried (hypothesis, approach)
- What happened (status: merged/discarded/failed)
- What metrics changed and by how much

Compile into a concise experiment history summary. If no past experiments exist, note: "This is the first round of experiments."

## Step 2: Determine Focus Area

### Non-interactive mode (called from /auto-experiment):
If `$FOCUS_AREA` is already set by the caller, use it directly — skip the AskUserQuestion. Also check for `$AUTO_MODE` flag; if set, the entire command runs without user interaction (no AskUserQuestion anywhere, auto-select top idea in Step 5).

If `$LESSONS_LEARNED` is provided by the caller, include it as additional context for the analysis agents in Step 3 — this contains failed approaches from prior auto-experiment cycles that should NOT be repeated.

### Interactive mode (default):
Use AskUserQuestion:
- question: "What aspect of your system do you most want to improve?"
- header: "Focus area"
- multiSelect: false
- options:
  - Overall accuracy / quality (Make the system's outputs better)
  - Speed / latency (Make the system faster)
  - Cost reduction (Make the system cheaper to run)
  - Reliability / error handling (Make the system more robust)

The user can also choose "Other" for a custom focus.

Store the response as `focus_area`.

If the user provides additional context with their answer, note it for the analysis agents.

## Step 3: Parallel Analysis

Launch **two codebase-analyzer agents in parallel**, plus a web search:

### Agent 1: Codebase Analysis
Spawn with `subagent_type: "codebase-analyzer"`.

Pass to this agent:
- **Mode**: `codebase`
- The project config (type, description, metrics, eval methodology)
- The focus area from Step 2
- The current baseline metrics and gap-to-target
- Instruction: "Analyze the codebase and return 5-10 ranked improvement opportunities focused on {focus_area}. For each, include: file:line reference, category, current state, opportunity, concrete experiment idea, expected impact, and effort level."

### Agent 2: History Analysis
Spawn with `subagent_type: "codebase-analyzer"`.

Pass to this agent:
- **Mode**: `history`
- The project config (type, description, metrics)
- The focus area from Step 2
- The full experiment history summary from Step 1d
- Instruction: "Analyze past experiment results and return patterns, gaps, and opportunities. Identify: winning patterns, losing patterns, untried combinations, plateaus, and failed experiments worth revisiting."

If there are no past experiments, skip Agent 2 and only launch Agent 1.

### Web Research (in parallel with agents)
If the focus area is "Overall accuracy/quality" or "Other", use WebSearch to find:
- Recent techniques for improving {project_type} systems (2024-2026)
- Blog posts or papers about {specific_technology_used} optimization
- Common patterns for the user's specific use case

Limit to 2-3 searches. Extract relevant technique names and brief descriptions.

**Wait for all agents (and web search) to complete.**

## Step 4: Synthesize & Rank Ideas

From the combined output of both agents and web research, synthesize **3-5 experiment ideas**, ranked by expected impact on the focus area.

### Ranking criteria:
1. **Expected impact** on the focus area metric (highest weight)
2. **Confidence** — how likely is this to work? (higher for codebase-observed issues, lower for speculative techniques)
3. **Effort** — lower effort ideas ranked higher when impact is similar
4. **Risk** — lower risk ideas ranked higher when impact is similar
5. **Novelty** — ideas not yet tried in experiment history ranked higher

### For each idea, produce:

```
### Idea {N}: {Title}

**Hypothesis**: If we {specific change}, then {metric} will {improve/decrease by estimated amount} because {reasoning}.

**Approach**:
1. {Specific step 1}
2. {Specific step 2}
3. {Specific step 3}

**Expected Impact**:
- {metric1}: {estimated change}
- {metric2}: {possible side effect}

**Effort**: {Small (< 30 min) | Medium (30 min - 2 hrs) | Large (2+ hrs)}
**Risk**: {Low (safe, easy to revert) | Medium (might break edge cases) | High (significant refactor)}
**Source**: {Codebase analysis | Experiment history | Web research | Combined}
**Evidence**: {Why we think this will work — reference specific code, past experiments, or research}
```

### Quality rules for ideas:
- **Be specific** — "improve the prompt" is not an idea. "Add few-shot examples to the classification prompt in prompts/classify.py, including 3 examples covering edge cases identified in failed eval cases" is.
- **Be testable** — the idea must be implementable and evaluatable with the existing eval pipeline
- **Be independent** — each idea should be runnable on its own, not dependent on other proposed experiments
- **Be different** — don't propose 3 variations of the same idea. Cover different categories (prompt, architecture, retrieval, etc.)
- **Avoid repeats** — don't propose experiments that have already been tried (check history)

## Step 5: Present & Select

### Non-interactive mode (when $AUTO_MODE is set):
Skip all user interaction. Return the **top-ranked idea** directly — its title, hypothesis, approach, expected impact. This is used by `/auto-experiment` to automatically feed the idea into the experiment implementation step.

Do NOT present the ranked list or ask the user to choose. Simply output the top idea in the structured format from Step 4 and stop.

### Interactive mode (default):

#### 5a. Present the ranked list

```
## Proposed Experiments

Based on your focus on **{focus_area}** and analysis of the codebase{, N past experiments, and recent research}:

{Idea 1 formatted as above}

{Idea 2 formatted as above}

{Idea 3 formatted as above}

{Idea 4 formatted as above (if applicable)}

{Idea 5 formatted as above (if applicable)}
```

#### 5b. Ask the user to choose

Use AskUserQuestion:
- question: "Which experiment would you like to run?"
- header: "Pick one"
- multiSelect: false
- options (dynamically built from the ideas):
  - {Idea 1 title} ({effort}, {expected primary metric change})
  - {Idea 2 title} ({effort}, {expected primary metric change})
  - {Idea 3 title} ({effort}, {expected primary metric change})
  - None — I have a different idea (Describe your own experiment)

#### 5c. Handle selection

**If user picks an idea:**
Provide the exact command to run it:
"Great! Run this command to start the experiment:

`/experiment {full idea description suitable as ARGUMENTS}`"

The description should be detailed enough that `/experiment` can understand what to implement without asking clarification questions.

**If user picks "None":**
Ask: "What experiment would you like to run instead?" — then provide the `/experiment` command for their custom idea.

## Rules

1. **Always read the actual code** before proposing changes to it — agents must analyze real files, not guess
2. **Never propose experiments that duplicate past attempts** — check the history
3. **Focus on the user's stated goal** — don't propose cost optimizations when they asked for accuracy
4. **Be honest about uncertainty** — if an idea is speculative, say so
5. **Propose at least one "small effort" idea** — give the user a quick win option
6. **Include at least one "creative" idea** — something non-obvious from web research or cross-domain inspiration
7. **Ground ideas in evidence** — every proposal should reference specific code, past results, or research
