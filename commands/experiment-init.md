---
description: Initialize experiment tracking for your project
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent]
model: opus
---

# /experiment-init — Project Setup & Interview

You are the **experiment-lab** initialization wizard. Your job is to interview the user about their project, capture everything needed to run reproducible experiments, and set up the `.experiments/` directory with a baseline.

## Step 1: Pre-flight Checks

Before starting the interview, perform ALL of these checks:

1. **Verify git repo:**
   ```bash
   git rev-parse --is-inside-work-tree
   ```
   If this fails, stop with: "This command must be run inside a git repository. Please initialize one with `git init` first."

2. **Check for existing config:**
   ```bash
   test -f .experiments/config.md && echo "EXISTS" || echo "NOT_FOUND"
   ```
   If EXISTS, use AskUserQuestion:
   - question: "An experiment configuration already exists. What would you like to do?"
   - header: "Existing config"
   - options:
     - Re-initialize (Overwrite config but keep experiment history)
     - View current config (Show existing config and exit)
     - Abort (Cancel and keep everything as-is)
   If "View current config" → read and display `.experiments/config.md`, then stop.
   If "Abort" → stop.
   If "Re-initialize" → continue with interview.

3. **Check git state:**
   ```bash
   git status --porcelain
   ```
   If dirty, warn: "Your working directory has uncommitted changes. Baseline metrics captured now may not match a clean state. Consider committing first." Ask whether to continue or abort.

## Step 2: Project Type

Use AskUserQuestion:
- question: "What type of project is this?"
- header: "Project type"
- multiSelect: false
- options:
  - LLM Application (Prompting, RAG, chains, tool-use pipelines)
  - Multi-agent System (Multiple coordinating agents, orchestration, delegation)
  - Agentic Application (Single agent with tool use, planning, autonomous execution)
  - Hybrid (Combination of LLM pipelines and agent components)

Store the selected type as `project_type`.

## Step 3: Project Description

Ask the user in natural language (not AskUserQuestion — this needs free text):

"Please describe your system in 2-3 sentences:
- What does it do?
- What is the input format? (text, JSON, files, API calls, etc.)
- What is the expected output?"

Wait for the user's response. Store as `project_description`.

## Step 4: How to Run

Ask: "How do you run your system? Describe in natural language — for example: 'run python main.py with a test input file' or 'start the API server and hit the /predict endpoint'."

After the user responds:
1. Analyze their description and the project structure (use Glob to find relevant files like `main.py`, `app.py`, `run.sh`, `Makefile`, etc.)
2. Propose exact shell command(s) to run the system
3. Ask the user to confirm or correct your proposed commands

Store the confirmed command as `run_command` and the working directory as `run_cwd` (default: ".").

Also ask: "What's a reasonable timeout for a single run? (default: 1 hour)" — store as `timeout_seconds`.

## Step 5: Test Data

Use AskUserQuestion:
- question: "Where is your test/evaluation data?"
- header: "Test data"
- multiSelect: false
- options:
  - Local files in this repo (Data files committed or gitignored in the project)
  - External API or service (Data fetched from an external source at eval time)
  - Generated on the fly (Synthetic data created by the eval script itself)
  - I need help setting up test data (Don't have eval data yet)

Based on the answer:
- **Local files**: Ask for the path(s). Verify they exist with `test -f` or `test -d`. Ask for a brief description of the data format and size.
- **External API**: Ask for the endpoint or service name. Note it in config.
- **Generated**: Ask how it's generated (command or built into the eval script).
- **Need help**: Note this — the eval-builder agent in Step 6 will handle it.

Store as `test_data_location`, `test_data_source`, `test_data_description`.

## Step 5b: Quick-Test Configuration (for Auto-Experiments)

This step configures the quick evaluation settings used by `/auto-experiment`. Quick eval runs your evaluation on a small data subset first, saving time by discarding clearly-failing experiments before running the full (expensive) evaluation.

Use AskUserQuestion:
- question: "Would you like to configure quick-test settings for auto-experiments? This runs evaluation on a small data subset first to save time by discarding bad experiments early."
- header: "Quick test"
- multiSelect: false
- options:
  - Yes — configure quick-test (Recommended for expensive evaluations)
  - No — skip (Auto-experiments will use defaults: 20% random subset)

### If "Yes":

**Subset percentage:**
Ask: "What percentage of test data should the quick test use? (default: 20%, range: 10-50%)"
- Store as `quick_eval.subset_percent` (integer, default 20)

**Subset method:**
Use AskUserQuestion:
- question: "How should the quick-test subset be selected?"
- header: "Subset method"
- multiSelect: false
- options:
  - Random sample (Pick random test cases each run — best for diverse test sets)
  - First N entries (Use the first N cases from the data file — deterministic)
  - Dedicated quick-test file (I have a separate smaller test set)

Store as `quick_eval.subset_method`: `random`, `first_n`, or `dedicated_file`.

If "Dedicated quick-test file": ask for the path and verify it exists:
```bash
test -f {path} && echo "FOUND" || echo "NOT_FOUND"
```
Store as `quick_eval.subset_data_path`.

**Proceed threshold:**
Ask: "What is the minimum acceptable weighted delta for the quick test to proceed to full evaluation? A negative value tolerates slight regression on the small subset. (default: -2.0%)"
- Store as `quick_eval.proceed_threshold` (float, default -2.0)

### If "No" or if test data is not local files:

Store defaults:
```yaml
quick_eval:
  enabled: true
  subset_percent: 20
  subset_method: "random"
  subset_data_path: null
  proceed_threshold: -2.0
```

If test data source is `external_api` or `generated`, set `quick_eval.enabled: false` and note: "Quick eval disabled — test data is not local files."

## Step 6: Evaluation Methodology

Use AskUserQuestion:
- question: "Do you have an existing evaluation script or process?"
- header: "Eval method"
- multiSelect: false
- options:
  - Yes — I have eval scripts ready (Just need the command to run them)
  - Partially — I have some but need help (Have parts of an eval, need help completing it)
  - No — help me build one from scratch (Need an evaluation script created)

### If "Yes":
Ask: "What is the exact command to run your evaluation? And what format does it output? (JSON, plain text key: value, CSV, etc.)"

Verify the eval script/command exists:
```bash
# Check if the script file exists
test -f <script_path> && echo "FOUND" || echo "NOT_FOUND"
```

Store as `eval_command`, `eval_output_format`, `eval_output_location`.

### If "Partially" or "No":
Tell the user: "I'll help you build an evaluation script. Let me analyze your project first."

Spawn the `eval-builder` agent:
```
subagent_type: "eval-builder"
```

Pass to the agent:
- The project type from Step 2
- The project description from Step 3
- The run command from Step 4
- The test data info from Step 5
- The input/output format described by the user
- Instruction: Analyze the project structure, propose an evaluation approach, write the eval script, test it, and return the eval command and output format.

After the agent returns, verify the eval script works:
```bash
# Quick smoke test of the eval
<eval_command> 2>&1 | head -20
```

If it fails, show the error and ask the user to help debug. Iterate until the eval runs successfully.

Store the working eval command and output format.

## Step 7: Metrics Definition

Ask: "What metrics should we track for your experiments? For each metric, I need:
- **Name** (e.g., accuracy, latency_ms, cost_per_query)
- **Direction** (higher_is_better or lower_is_better)
- **Target value** (optional — what you're aiming for)
- **Weight** (priority — higher number = more important, default: 1)

Example: 'accuracy (higher is better, target 0.95, weight 3), latency in ms (lower is better, target 500, weight 1)'"

If the user is unsure, propose defaults based on project type:

**LLM Application defaults:**
| Metric | Direction | Weight |
|--------|-----------|--------|
| accuracy | higher_is_better | 3 |
| relevance_score | higher_is_better | 2 |
| latency_ms | lower_is_better | 1 |
| cost_per_query | lower_is_better | 1 |

**Multi-agent / Agentic defaults:**
| Metric | Direction | Weight |
|--------|-----------|--------|
| task_completion_rate | higher_is_better | 3 |
| steps_to_completion | lower_is_better | 2 |
| error_rate | lower_is_better | 2 |
| cost_per_task | lower_is_better | 1 |

**Hybrid defaults:** combine relevant metrics from both.

Parse the user's response into structured metric definitions. Validate:
- At least 1 metric defined
- Every metric has a name and direction
- Weights default to 1 if not specified
- Targets are optional (null if not specified)

Store as `metrics` array.

## Step 8: Environment Setup

Use AskUserQuestion:
- question: "How should the experiment environment be set up?"
- header: "Environment"
- multiSelect: false
- options:
  - Virtual environment (source .venv/bin/activate or similar)
  - Conda environment (conda activate env-name)
  - No special setup (Dependencies are globally installed or managed otherwise)
  - Custom setup script (I have a setup.sh or similar)

Based on the answer, capture the specific setup commands. Ask:
- "What are the exact setup commands? (e.g., `source .venv/bin/activate && pip install -r requirements.txt`)"
- "Are there any required environment variables? (Just the names — values stay in .env)"

Store as `environment_setup_type`, `environment_setup_commands`, `environment_env_vars`.

## Step 9: Confirmation

Present a full summary of everything captured in a clean format:

```
## Experiment Lab Configuration Summary

**Project**: {project_type}
{project_description}

**Run command**: `{run_command}`
**Timeout**: {timeout_seconds}s
**Working directory**: {run_cwd}

**Test data**: {test_data_source} — {test_data_location}
{test_data_description}

**Evaluation**: `{eval_command}`
**Output format**: {eval_output_format}

**Metrics**:
| Metric | Direction | Target | Weight |
|--------|-----------|--------|--------|
| ... | ... | ... | ... |

**Environment**: {setup_type}
Setup: `{setup_commands}`
Env vars: {env_vars}

**Quick eval** (for /auto-experiment): {enabled/disabled}
Subset: {subset_percent}% ({subset_method})
Proceed threshold: {proceed_threshold}%
```

Use AskUserQuestion:
- question: "Does this configuration look correct?"
- header: "Confirm"
- multiSelect: false
- options:
  - Yes — proceed with setup (Save config and run baseline evaluation)
  - No — let me modify something (Go back and change a specific section)

If "No": ask which section to modify (1-8), loop back to that step. After modification, show the updated summary again.

## Step 10: Setup Execution

After confirmation, execute the setup:

### 10a. Create directory structure
```bash
mkdir -p .experiments
```

### 10b. Write config.md

Write `.experiments/config.md` with **YAML frontmatter** (machine-readable) and **Markdown body** (human-readable). Use the exact schema from the plan:

```markdown
---
project_name: "{project_name}"
project_type: "{project_type}"
initialized_at: "{ISO-8601 timestamp}"

run:
  command: "{run_command}"
  cwd: "{run_cwd}"
  timeout_seconds: {timeout_seconds}

environment:
  setup_type: "{setup_type}"
  setup_commands:
    - "{command1}"
    - "{command2}"
  env_vars: ["{var1}", "{var2}"]

test_data:
  location: "{location}"
  source: "{source}"
  description: "{description}"

evaluation:
  command: "{eval_command}"
  output_format: "{format}"
  output_location: "{location}"
  cwd: "."

metrics:
  - name: "{name}"
    direction: "{direction}"
    target: {target_or_null}
    weight: {weight}

quick_eval:
  enabled: {true/false}
  subset_percent: {percent}
  subset_method: "{random|first_n|dedicated_file}"
  subset_data_path: {path_or_null}
  proceed_threshold: {threshold}
---

# Experiment Lab Configuration

## Project Description
{project_description}

## How to Run
```bash
{run_command}
```

## Evaluation
{eval_description}

```bash
{eval_command}
```

## Metrics
| Metric | Direction | Target | Weight |
|--------|-----------|--------|--------|
| {name} | {direction} | {target} | {weight} |

## Environment Setup
```bash
{setup_commands}
```

Required env vars: {env_vars_list}

## Notes
Initialized on {date} by experiment-lab.
```

### 10c. Update .gitignore

Check if `.worktrees/` is already in `.gitignore`. If not, append it:
```bash
grep -qxF '.worktrees/' .gitignore 2>/dev/null || echo '.worktrees/' >> .gitignore
```

Also ensure `.gitignore` exists:
```bash
touch .gitignore
```

### 10d. Run baseline evaluation

Tell the user: "Running baseline evaluation to establish current metrics..."

Execute the evaluation pipeline:
```bash
cd {run_cwd} && {environment_setup_commands} && {eval_command}
```

Capture stdout and stderr.

If the eval succeeds:
1. Parse the output to extract metric values (based on `eval_output_format`)
2. Write `.experiments/baseline-metrics.md`:

```markdown
---
captured_at: "{ISO-8601 timestamp}"
commit: "{git rev-parse HEAD}"
branch: "main"
metrics:
  {metric_name}: {value}
  ...
---

# Baseline Metrics

Captured from branch `main` at commit `{short_hash}`.

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| {name} | {value} | {target} | {on_target/below_target/above_target} |
```

If the eval **fails**:
- Show the error output
- Use AskUserQuestion:
  - question: "Baseline evaluation failed. What would you like to do?"
  - header: "Eval failed"
  - options:
    - Debug (Let me help fix the issue and retry)
    - Skip baseline (Save config without baseline — first experiment will establish it)
    - Abort (Cancel initialization entirely)
- If "Debug": read the error, propose fixes, retry. Loop up to 3 times.
- If "Skip baseline": write `baseline-metrics.md` with `status: pending` and no metric values.
- If "Abort": delete `.experiments/` directory and stop.

### 10e. Present completion summary

```
## Experiment Lab — Initialized

Configuration saved to `.experiments/config.md`

### Baseline Metrics
| Metric | Value | Target | Gap |
|--------|-------|--------|-----|
| ... | ... | ... | ... |

### Next Steps
- Run `/experiment {your idea}` to test a hypothesis
- Run `/propose-experiments` to get experiment suggestions
- Edit `.experiments/config.md` to adjust settings manually
```
