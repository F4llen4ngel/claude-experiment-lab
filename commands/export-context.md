---
description: Export safe project context for cloud Claude (strips sensitive data)
allowed-tools: [Read, Bash, Glob, Grep, Write]
model: sonnet
---

# /export-context — Export Safe Context for Cloud Claude

You are the **experiment-lab** context exporter. Your job is to gather all **non-sensitive** project data — source code structure, metrics, experiment history, config, diffs — and bundle it into a single file that cloud Claude can safely read. Sensitive data (test datasets, eval output, run logs, RAG chunks, judge responses with real examples) is **never** included.

## What is sensitive (NEVER include)

- Test data files (actual questions, answers, ground truth) — path from `test_data.location` in config
- `eval-output/` directories — contain per-case results with real data
- `run.log` and `quick-run.log` — dump real data during evaluation
- Any file content containing verbatim user queries, RAG chunks, or model outputs from real data
- `details[]` arrays from eval JSON output (per-case breakdowns)

## What is safe (include)

- All source code and prompt templates
- `.experiments/config.md` — project configuration
- `.experiments/baseline-metrics.md` — aggregate metrics
- `.experiments/*/idea.md` — hypotheses, approaches
- `.experiments/*/metrics.md` — aggregate comparisons and analysis
- `.experiments/*/quick-metrics.md` — quick eval aggregate results
- `.experiments/*/changes.diff` — code diffs
- `.experiments/auto-run-*/progress.md` — auto-run tracking
- `.experiments/auto-run-*/summary.md` — auto-run summaries
- `.experiments/proposals/` — existing proposals and their status
- Project file tree (names, not content of sensitive files)

## Step 1: Read Configuration

Read `.experiments/config.md` and parse the YAML frontmatter.
Extract `test_data.location` and `quick_eval.subset_data_path` — these are the sensitive data paths to avoid.

## Step 2: Build File Tree

Generate the project file tree, excluding:
- `node_modules/`, `.git/`, `.worktrees/`, `__pycache__/`, `.venv/`, `venv/`
- Files matching sensitive data paths

```bash
find . -type f \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/.worktrees/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/.venv/*' \
  -not -path '*/venv/*' \
  -not -path '*/.experiments/*/eval-output/*' \
  -not -name '*run.log' \
  -not -name '*quick-run.log' \
  | sort
```

Also filter out the test data path from config.

## Step 3: Read Safe Experiment Files

### 3a. Config and baseline
Read:
- `.experiments/config.md` (full content)
- `.experiments/baseline-metrics.md` (full content)

### 3b. Experiment history
For each experiment directory in `.experiments/`:
```bash
ls -d .experiments/*/idea.md 2>/dev/null
```

For each experiment, read ONLY these files:
- `idea.md` — full content
- `metrics.md` — full content (this has aggregate numbers + analysis, no raw data)
- `quick-metrics.md` — full content if it exists
- `changes.diff` — full content

Do NOT read: `run.log`, `quick-run.log`, anything in `eval-output/`.

### 3c. Auto-run summaries
```bash
ls -d .experiments/auto-run-*/summary.md 2>/dev/null
ls -d .experiments/auto-run-*/progress.md 2>/dev/null
```
Read each if it exists.

### 3d. Existing proposals
```bash
ls .experiments/proposals/*.md 2>/dev/null
```
Read each proposal file (these are safe — written by cloud Claude previously).

## Step 4: Read Source Code

Read all source code files (`.py`, `.ts`, `.js`, `.yaml`, `.yml`, `.json`, `.toml`, `.cfg`, `.sh`, `.md` in project root) — EXCEPT:
- Files in sensitive data paths
- Files in `eval-output/`
- Run logs

For very large files (>500 lines), include the first 200 lines and note it was truncated.

For binary files, skip them entirely.

## Step 5: Write Context Bundle

Write everything to `.experiments/context-bundle.md`:

```markdown
---
exported_at: "{ISO-8601 timestamp}"
commit: "{git rev-parse HEAD}"
branch: "{git branch --show-current}"
---

# Experiment Lab Context Bundle

Exported for cloud Claude analysis. This file contains NO sensitive data —
no test data, no eval output, no run logs, no real user queries or model outputs.

## Project File Tree

```
{file tree from Step 2}
```

## Configuration

{full content of .experiments/config.md}

## Baseline Metrics

{full content of .experiments/baseline-metrics.md}

## Experiment History

### Experiment: {slug-timestamp}

#### Idea
{content of idea.md}

#### Metrics
{content of metrics.md}

#### Quick Metrics
{content of quick-metrics.md, or "N/A"}

#### Code Changes
```diff
{content of changes.diff}
```

---

{repeat for each experiment}

## Auto-Run Summaries

### {auto-run-timestamp}

#### Progress
{content of progress.md}

#### Summary
{content of summary.md}

---

{repeat for each auto-run}

## Existing Proposals

### {proposal slug}
{content of proposal.md}

---

{repeat for each proposal}

## Source Code

### {file_path}
```{extension}
{file content}
```

{repeat for each source file}
```

## Step 6: Report

Tell the user:

```
Context bundle exported to `.experiments/context-bundle.md`.

Includes:
- Project file tree
- Configuration and baseline metrics
- {N} experiment(s) (ideas, metrics, diffs)
- {N} auto-run summary(ies)
- {N} existing proposal(s)
- {N} source code files

Excludes (sensitive):
- Test data files
- Eval output directories
- Run logs

Next step: Open this project in cloud Claude Code and run `/plan-experiments`.
The context bundle contains everything cloud Claude needs to propose experiments.
```

## Rules

1. **NEVER read or include test data files** — check the path against `test_data.location` from config
2. **NEVER read or include eval-output/ contents** — these contain per-case results with real data
3. **NEVER read or include run.log or quick-run.log** — these dump real data during evaluation
4. **When in doubt, exclude** — it's better to miss a safe file than to include a sensitive one
5. **Source code is always safe** — prompt templates, configs, pipeline logic are not sensitive
6. **Aggregate analysis is safe** — "model struggles with X type of queries" is fine, just no verbatim examples
