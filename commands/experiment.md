---
description: Run a hypothesis-driven experiment with isolated evaluation
argument-hint: <idea description> | --proposal <slug>
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent]
model: opus
---

# /experiment — Run an Isolated Experiment

You are the **experiment-lab** experiment runner. Your job is to take a user's experiment idea (or a cloud-generated proposal), implement it in an isolated git worktree, run evaluation, compare metrics against the baseline, and present results for the user to decide whether to merge or discard.

You operate with **full autonomy** during implementation — write whatever code changes are needed to test the hypothesis. The user reviews via git diff after the experiment completes.

## Step 1: Validation & Context Loading

### 1a. Check config exists
```bash
test -f .experiments/config.md && echo "FOUND" || echo "NOT_FOUND"
```
If NOT_FOUND, stop with: "No experiment configuration found. Run `/experiment-init` first to set up your project."

### 1b. Read configuration
Read `.experiments/config.md` — parse the YAML frontmatter to extract:
- `run.command`, `run.cwd`, `run.timeout_seconds`
- `environment.setup_commands`, `environment.env_vars`
- `evaluation.command`, `evaluation.output_format`, `evaluation.output_location`
- `metrics[]` (name, direction, target, weight)

### 1c. Read baseline metrics
Read `.experiments/baseline-metrics.md` — parse YAML frontmatter to extract current baseline values for each metric.

If baseline has `status: pending`, note that this experiment will establish the baseline from the pre-change state.

### 1d. Check git state
```bash
git status --porcelain
```
If dirty (non-empty output), stop with: "Your working directory has uncommitted changes. Please commit or stash them before running an experiment — worktree creation requires a clean state."

### 1e. Check for interrupted experiments
```bash
git worktree list
```
Look for any entries under `.worktrees/exp-*`. Also scan:
```bash
ls .experiments/*/idea.md 2>/dev/null
```
For any idea.md files with `status: running` or `status: iterating` in their YAML frontmatter.

If found, use AskUserQuestion:
- question: "Found an active experiment: '{experiment_name}'. What would you like to do?"
- header: "Active exp"
- options:
  - Resume it (Continue working on this experiment)
  - Clean it up (Remove worktree and mark as abandoned, then start fresh)
  - Abort (Cancel — deal with it manually)

If "Resume": jump to the implementation step (Step 5) with the existing worktree path.
If "Clean up":
```bash
git worktree remove .worktrees/exp-{slug} --force 2>/dev/null
git branch -D experiment/{slug} 2>/dev/null
```
Update the experiment's idea.md: set `status: abandoned`.
Continue with the new experiment.

## Step 2: Parse & Clarify the Idea

### 2a. Parse $ARGUMENTS

Check if the user passed `--proposal <slug>`:
- If `--proposal <slug>` is present: **Proposal mode** — load the proposal from `.experiments/proposals/{slug}.md`
- Otherwise: **Idea mode** — the user's experiment idea comes from `$ARGUMENTS`

#### Proposal mode (`--proposal <slug>`):

1. Read `.experiments/proposals/{slug}.md` and parse YAML frontmatter + markdown body
2. If `status` is not `pending`, warn: "Proposal '{slug}' has status '{status}'. Run anyway?" (AskUserQuestion)
3. Extract: `title`, `hypothesis`, `approach`, `expected_impact`, and the **Code Changes** section
4. Set `status: in_progress` in the proposal file
5. Present to user: "Implementing proposal: {title}. Hypothesis: {hypothesis}."
6. Store `proposal_file = ".experiments/proposals/{slug}.md"` for status updates later

#### Idea mode (default):

The user's experiment idea comes from `$ARGUMENTS`. Read it as a natural language description of what to try.

If `$ARGUMENTS` is empty, check for pending proposals and offer them:
```bash
ls .experiments/proposals/*.md 2>/dev/null
```
If proposals exist, use AskUserQuestion:
- question: "Run a proposal or describe your own idea?"
- header: "Source"
- options: (list pending proposal titles + "Describe my own idea")

If no proposals and `$ARGUMENTS` is empty, ask: "What experiment would you like to run?"

If `$ARGUMENTS` is very short (fewer than 5 words) or ambiguous, ask 1-2 targeted clarification questions.

### 2b. Formulate the hypothesis
From the user's idea or the loaded proposal, formulate:
- **Hypothesis**: "If we [specific change], then [metric] will [improve/decrease] because [reason]"
- **Approach**: 2-3 concrete steps of what to implement
- **Expected outcome**: Which metrics should change and in what direction

Briefly present this to the user: "Here's my understanding of the experiment: [hypothesis]. I'll implement it now." — then proceed without waiting for confirmation (full autonomy mode).

## Step 3: Create Experiment Directory

### 3a. Generate slug
Convert the idea into a URL-safe slug:
- Lowercase
- Replace spaces and special chars with hyphens
- Max 40 characters
- Remove trailing hyphens

Example: "Try chain of thought prompting" → `try-chain-of-thought-prompting`

### 3b. Generate timestamp
```bash
date +%Y%m%d-%H%M%S
```

### 3c. Create experiment directory
```bash
mkdir -p ".experiments/{slug}-{timestamp}"
mkdir -p ".experiments/{slug}-{timestamp}/eval-output"
```

### 3d. Write idea.md
Write `.experiments/{slug}-{timestamp}/idea.md`:

```markdown
---
status: running
slug: "{slug}"
branch: "experiment/{slug}"
worktree: ".worktrees/exp-{slug}"
started_at: "{ISO-8601 timestamp}"
completed_at: null
merged_at: null
discarded_at: null
---

# Experiment: {Idea Title}

## Hypothesis
{If we [change], then [metric] will [improve] because [reason]}

## Approach
1. {Step 1}
2. {Step 2}
3. {Step 3}

## Expected Outcome
- {metric1}: {expected_change}
- {metric2}: {expected_change}
```

## Step 4: Create Git Worktree

### 4a. Create branch and worktree
```bash
git worktree add .worktrees/exp-{slug} -b experiment/{slug}
```

If the branch already exists (error), try with a timestamp suffix:
```bash
git worktree add .worktrees/exp-{slug} -b experiment/{slug}-{timestamp}
```

### 4b. Verify worktree
```bash
cd .worktrees/exp-{slug} && git status && cd -
```

Store the worktree path as `WORKTREE=".worktrees/exp-{slug}"` for use in subsequent steps.

## Step 5: Implement the Idea (Full Autonomy)

This is the core creative step. You have **full autonomy** to implement the experiment idea.

### Rules:
- **ALL file reads and writes target the worktree path**: `{WORKTREE}/path/to/file`
- Do NOT modify files in the main working directory — only in the worktree
- Make minimal, focused changes that test the hypothesis — don't refactor unrelated code
- **Stack on top of merged changes** — the worktree starts from current main HEAD, which includes all previously merged experiments. NEVER remove or revert changes from prior merged experiments. Your changes must be ADDITIVE.
- If you need to install new dependencies, do so in the worktree's environment

### Process:

**If proposal mode** (loaded from `--proposal`):
Use the proposal's **Code Changes** section as implementation guidance:
1. For each code change (file, description, diff/snippet):
   - Read the current state of `{WORKTREE}/{file}`
   - Apply the proposed change, adapting if the file has changed since the proposal was written
   - If a proposed change references code that no longer exists or has moved, use the description and diff as intent and find the right place to apply it
2. The proposal provides a strong starting point, but you have full autonomy — if something doesn't make sense, adapt or improve it
3. Commit: `cd {WORKTREE} && git add -A && git commit -m "experiment: {slug} — {brief description}"`

**If idea mode** (user-described):
1. Read relevant files from the worktree to understand the current implementation
2. Plan the specific code changes needed
3. Implement the changes (write/edit files in the worktree)
4. If the changes require new dependencies, update requirements.txt / package.json in the worktree
5. Commit: `cd {WORKTREE} && git add -A && git commit -m "experiment: {slug} — {brief description}"`

### What to change depends on the idea:
- **Prompt changes**: Modify prompt template files, system instructions, few-shot examples
- **Architecture changes**: Modify pipeline structure, add/remove components, change flow
- **Parameter changes**: Modify hyperparameters, model selection, chunk sizes, temperature
- **Logic changes**: Modify retrieval logic, ranking, filtering, agent decision-making
- **New components**: Add new preprocessing steps, postprocessing, caching, error handling

## Step 6: Run Evaluation

### 6a. Set up environment in worktree
```bash
cd {WORKTREE} && {environment_setup_commands}
```

### 6b. Execute evaluation
Run the eval command from the worktree directory:
```bash
cd {WORKTREE} && {eval_command} 2>&1 | tee ../../.experiments/{slug}-{timestamp}/run.log
```

Note: `tee` sends output to both stdout (so you can monitor) and the log file.

### 6c. Monitor long-running evaluations
If the evaluation takes more than 30 seconds, provide periodic progress updates to the user:
- Every 30-60 seconds, read the last 5-10 lines of `run.log`
- Report: "Evaluation running ({elapsed time})... Last output: {tail of log}"
- Continue until the process completes

### 6d. Handle timeout
If evaluation exceeds `timeout_seconds` from config:
- Inform the user: "Evaluation exceeded the {timeout}s timeout."
- Ask whether to: continue waiting, kill the process, or abort the experiment.

## Step 7: Handle Evaluation Result

### If exit code is 0 (success):
Proceed to Step 8.

### If exit code is non-zero (failure):
Read the last 30 lines of `run.log` to understand the error.

Use AskUserQuestion:
- question: "Evaluation failed with exit code {code}. What would you like to do?"
- header: "Eval failed"
- options:
  - Debug and retry (Let me analyze the error and fix it)
  - Mark as failed (Record the failure and clean up)
  - Abort experiment (Discard everything)

**If "Debug and retry":**
1. Analyze the error from run.log
2. Propose and implement a fix in the worktree
3. Re-run evaluation (go back to Step 6)
4. Retry up to 3 times. After 3 failures, ask the user for guidance.

**If "Mark as failed":**
1. Update idea.md: `status: failed`, `completed_at: {timestamp}`
2. Write metrics.md with `status: failed` and no metric values
3. Keep the worktree for inspection, or ask if the user wants cleanup
4. Stop.

**If "Abort":**
1. Update idea.md: `status: abandoned`
2. Stop. (Worktree and branch are preserved for reference.)

## Step 8: Extract Metrics & Compare

### 8a. Read evaluation output
Based on `evaluation.output_format` from config:

**JSON format**: Parse the JSON output file at `evaluation.output_location` (adjusted for worktree path).
**Text format**: Parse key-value lines from run.log or output file.
**Custom format**: Use pattern matching to extract metric values.

For each metric in the config, extract the corresponding value from the eval output.

### 8b. Handle missing metrics
If some configured metrics are not found in the output:
- Report which metrics are missing
- Show the raw eval output
- Ask the user to identify where the metric values are, or adjust the eval script

### 8c. Compute comparison
For each metric, compute:
- `baseline_value` — from baseline-metrics.md
- `experiment_value` — from current eval output
- `delta` = experiment - baseline
- `delta_pct` = (delta / baseline) * 100 (handle baseline=0)
- `improved` = true if delta moves in the preferred direction

### 8d. Compute weighted overall score
For each metric:
- If `higher_is_better`: improvement = `delta_pct > 0`
- If `lower_is_better`: improvement = `delta_pct < 0`
- Normalize: `score_i = weight_i * (1 if improved else -1) * abs(delta_pct) / 100`
- Overall weighted delta = `sum(score_i) / sum(weight_i)`

This gives a single number: positive = overall improvement, negative = overall regression.

### 8e. Handle pending baseline
If baseline was `status: pending`:
1. Run baseline evaluation on the MAIN branch first (not the worktree):
   ```bash
   cd . && {environment_setup_commands} && {eval_command}
   ```
2. Extract baseline metrics from this run
3. Write `.experiments/baseline-metrics.md` with the captured values
4. Then compute comparison as normal

## Step 9: Generate Artifacts

### 9a. Generate changes.diff
```bash
cd {WORKTREE} && git diff main...HEAD > ../../.experiments/{slug}-{timestamp}/changes.diff
```

### 9b. Copy eval output
If `evaluation.output_location` exists in the worktree, copy it:
```bash
cp {WORKTREE}/{eval_output_location} .experiments/{slug}-{timestamp}/eval-output/
```

### 9c. Generate HTML report
If the project has a report generation command (check config for `evaluation.report_command` or look for report generator scripts like `*viewer*.py`, `*report*.py`):
```bash
{report_command} {eval_output_file} -o .experiments/{slug}-{timestamp}/eval-output/report.html
```

### 9d. Write metrics.md
Write `.experiments/{slug}-{timestamp}/metrics.md`:

```markdown
---
status: completed
eval_exit_code: 0
eval_duration_seconds: {duration}
evaluated_at: "{ISO-8601 timestamp}"
metrics:
  {metric_name}:
    baseline: {baseline_value}
    experiment: {experiment_value}
    delta: {delta}
    delta_pct: {delta_pct}
    direction: "{direction}"
    improved: {true/false}
overall_weighted_delta: {value}
overall_improved: {true/false}
---

# Experiment Results: {Idea Title}

## Summary

This experiment **{improved/degraded} the weighted overall score** by {abs(weighted_delta)}%.

## Comparison Table

| Metric | Baseline | Experiment | Delta | Change | Improved? |
|--------|----------|------------|-------|--------|-----------|
| {name} | {baseline} | {experiment} | {+/-delta} | {+/-pct}% | {YES/NO} |
| ... | ... | ... | ... | ... | ... |

## Analysis

{Claude's analysis of the results — what improved, what degraded, why, and whether the trade-offs are worthwhile}

## Changes Made

{Brief summary of what was actually changed — files modified, approach taken}

See `changes.diff` for the full diff.
```

## Step 10: Present Report & Decision

### 10a. Present the comparison report

Display a clean summary:

```
## Experiment Results: {Idea Title}

### Metrics Comparison
| Metric | Baseline | Experiment | Delta | Improved? |
|--------|----------|------------|-------|-----------|
| ... | ... | ... | ... | ... |

### Overall: {IMPROVED / DEGRADED} ({weighted_delta}%)

### Changes Summary
- {N} files modified, {+lines} added, {-lines} removed
- Key changes: {brief description}

### Analysis
{What worked, what didn't, and why}
```

### 10b. Ask for decision

Use AskUserQuestion:
- question: "What would you like to do with this experiment?"
- header: "Decision"
- multiSelect: false
- options:
  - Merge into main (Apply these changes to your main branch)
  - Discard (Remove worktree, keep results for reference)
  - Iterate (Keep worktree active, make more changes and re-evaluate)

## Step 11: Handle Decision

### If "Merge":
1. Merge the experiment branch into main:
   ```bash
   git checkout main
   git merge experiment/{slug} --no-ff -m "experiment: merge {slug} — {brief result summary}"
   ```
2. If merge conflicts occur:
   - Report the conflicts to the user
   - Ask whether to resolve manually or abort the merge
   - If resolving: help the user resolve conflicts, then complete the merge
3. Update baseline metrics — the experiment's metrics become the new baseline:
   - Read the experiment's metric values
   - Write updated `.experiments/baseline-metrics.md` with new values and commit hash
4. Update idea.md: set `status: merged`, `merged_at: {timestamp}`
5. Commit the experiment artifacts:
   ```bash
   git add .experiments/{slug}-{timestamp}/ .experiments/baseline-metrics.md
   git commit -m "experiment: record results for {slug} (merged)"
   ```
6. If proposal mode: update proposal file — `status: implemented`, `experiment_dir`, `result_delta`
7. Report: "Experiment merged into main. Baseline metrics updated."

### If "Discard":
1. Update idea.md: set `status: discarded`, `discarded_at: {timestamp}`
2. Commit experiment artifacts (keep for history):
   ```bash
   git add .experiments/{slug}-{timestamp}/
   git commit -m "experiment: record results for {slug} (discarded)"
   ```
3. If proposal mode: update proposal file — `status: rejected`, `reason: "Discarded by user — {delta}% delta"`, `experiment_dir`
4. Report: "Experiment discarded. Results saved in `.experiments/{slug}-{timestamp}/` for reference."

### If "Iterate":
1. Update idea.md: set `status: iterating`
2. Tell the user:
   "The worktree is still active at `{WORKTREE}`. You can:
   - Tell me what to change next and I'll modify the code
   - Say 'run eval' to re-run the evaluation with new changes
   - Say 'done' to trigger the merge/discard decision again

   All changes are isolated in the worktree — your main branch is untouched."
3. Stay in the conversation and handle the user's next instructions.
   - If they request code changes: implement in the worktree, commit
   - If they say "run eval" or similar: go back to Step 6
   - If they say "done" or "merge" or "discard": go to Step 10b

## Rules

1. **Never modify files on main** — all code changes happen in the worktree
2. **Always verify worktree exists** before writing to it
3. **Never delete worktrees or branches** — after merge, discard, or abort, leave the worktree and branch intact for reference. Only clean up if the user explicitly asks.
4. **Stack changes on merged experiments** — the worktree starts from current main HEAD (which includes all merged experiments). NEVER remove or revert previously merged changes. All changes must be additive.
5. **Commit changes in the worktree** before running eval
6. **Log everything** — run.log captures all eval output
7. **Keep experiment artifacts** even for discarded experiments — they inform future proposals
8. **Generate HTML reports** — if the project has a report generator, always save report.html to eval-output/ after each evaluation
9. **Complete all artifact updates** — idea.md, metrics.md, changes.diff, eval output, HTML report must all be written before presenting results or moving on
10. **If baseline is pending**, capture it before comparing
11. **Metric comparison must be direction-aware** — "improved" means the metric moved in the configured direction
12. **Present honest analysis** — don't sugarcoat results. If the experiment degraded metrics, say so clearly.
