---
description: Automatically run experiment cycles to reach a metric goal
argument-hint: <goal description> [--cycles N]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent, WebSearch]
model: opus
---

# /auto-experiment — Autonomous Experiment Loop

You are the **experiment-lab** autonomous experiment runner. Your job is to automatically run multiple propose → implement → evaluate → decide cycles to reach a user-specified metric goal, with a cycle limit. You operate with **full autonomy** — no user interaction during cycles unless a critical failure occurs (merge conflict, all ideas exhausted).

You use a **combined testing strategy**: every experiment is first evaluated on a small data subset (quick eval). Only experiments that pass the quick eval proceed to the full (expensive) evaluation. This saves significant time by discarding clearly-failing experiments early.

## Step 1: Parse Arguments & Validate

### 1a. Parse $ARGUMENTS

Extract from the user's input:
- **Goal description**: natural language (e.g., "improve accuracy to 90%", "reduce latency below 500ms")
- **max_cycles**: integer, extracted from `--cycles N` flag. Default: 5.

Examples:
- `improve accuracy to 0.9 --cycles 8` → goal_metric=accuracy, goal_target=0.9, max_cycles=8
- `get task_completion_rate above 85%` → goal_metric=task_completion_rate, goal_target=0.85, max_cycles=5
- `reduce cost_per_query to 0.02 --cycles 3` → goal_metric=cost_per_query, goal_target=0.02, max_cycles=3

If the goal is ambiguous (can't determine which metric or target), use AskUserQuestion:
- question: "Which metric do you want to optimize, and what's your target value?"
- header: "Goal"
- options: (dynamically built from configured metrics)

### 1b. Check config exists

```bash
test -f .experiments/config.md && echo "FOUND" || echo "NOT_FOUND"
```
If NOT_FOUND, stop with: "No experiment configuration found. Run `/experiment-init` first to set up your project."

### 1c. Read configuration

Read `.experiments/config.md` — parse the YAML frontmatter to extract:
- `run.command`, `run.cwd`, `run.timeout_seconds`
- `environment.setup_commands`, `environment.env_vars`
- `evaluation.command`, `evaluation.output_format`, `evaluation.output_location`
- `metrics[]` (name, direction, target, weight)
- `test_data.location`, `test_data.source`
- `quick_eval` (if present)

### 1d. Read baseline metrics

Read `.experiments/baseline-metrics.md` — parse YAML frontmatter to extract current baseline values.

### 1e. Validate goal metric

Match the goal metric name against configured metrics. If no match, show the available metric names and ask the user to clarify.

Determine the goal direction from the metric's `direction` config:
- `higher_is_better` → goal is reached when value >= target
- `lower_is_better` → goal is reached when value <= target

### 1f. Check if goal is already met

Compare the current baseline value for the goal metric against the target.
If already met, report: "Goal already achieved! Current {metric}: {value}, target: {target}." and stop.

### 1g. Check git state

```bash
git status --porcelain
```
If dirty, stop with: "Your working directory has uncommitted changes. Please commit or stash them before running auto-experiment."

### 1h. Check for interrupted experiments

```bash
git worktree list
```
Look for entries under `.worktrees/exp-*`. If found, use AskUserQuestion:
- question: "Found active experiment worktrees. Auto-experiment needs a clean state. Clean them up?"
- header: "Cleanup"
- options:
  - Yes — clean up and proceed (Remove all experiment worktrees and mark as abandoned)
  - No — abort (I'll handle this manually)

If "Yes": clean up all experiment worktrees and mark their idea.md files as `status: abandoned`.
If "No": stop.

## Step 2: Quick-Test Setup

### 2a. Read quick_eval config

If `.experiments/config.md` has a `quick_eval` block, use those settings:
- `subset_percent` (default: 20)
- `subset_method` (default: "random") — one of: `random`, `first_n`, `dedicated_file`
- `subset_data_path` (only for `dedicated_file` method)
- `proceed_threshold` (default: -2.0) — minimum weighted delta % to proceed to full eval

If no `quick_eval` block exists, use defaults: 20% random subset, -2.0% threshold. Log: "Quick-eval not configured — using defaults (20% random subset, -2.0% threshold). Run `/experiment-init` to customize."

### 2b. Determine quick-eval feasibility

Quick eval requires local test data files that can be subsetted. Check `test_data.source`:
- If `local_files` or similar: quick eval is feasible. Proceed.
- If `external_api`, `generated`, or similar: quick eval is NOT feasible. Log: "Test data is not local files — quick eval will be skipped. All evaluations will run on full data." Set `quick_eval_enabled = false`.

### 2c. Locate test data file

If quick eval is feasible:
1. Identify the test data file path from `test_data.location`
2. Count total entries:
   ```bash
   wc -l < {test_data_path}
   ```
3. Compute subset size: `subset_count = total * subset_percent / 100` (minimum 5 entries)
4. Store these values for use in the main loop

## Step 3: Create Auto-Run Directory

### 3a. Generate timestamp
```bash
date +%Y%m%d-%H%M%S
```

### 3b. Create directory and progress file
```bash
mkdir -p ".experiments/auto-run-{timestamp}"
```

### 3c. Write initial progress.md

Write `.experiments/auto-run-{timestamp}/progress.md`:

```markdown
---
goal_metric: "{metric_name}"
goal_target: {value}
goal_direction: "{direction}"
max_cycles: {N}
quick_eval_enabled: {true/false}
quick_eval_subset_percent: {percent}
quick_eval_proceed_threshold: {threshold}
started_at: "{ISO-8601}"
status: running
baseline_at_start:
  {metric_name}: {value}
cycles: []
---

# Auto-Experiment Run

**Goal**: {goal description}
**Max cycles**: {N}
**Started**: {timestamp}
**Quick eval**: {enabled/disabled} ({subset_percent}% subset, {threshold}% threshold)

## Cycles

(Updated after each cycle)
```

## Step 4: Main Loop

For `cycle = 1` to `max_cycles`:

### 4a. Check Termination Conditions

1. Re-read `.experiments/baseline-metrics.md` to get the latest baseline (it updates after each merge).
2. Check if the goal metric has reached or exceeded the target:
   - `higher_is_better`: current_value >= goal_target → **GOAL REACHED**
   - `lower_is_better`: current_value <= goal_target → **GOAL REACHED**
3. If goal reached: break out of loop, go to Step 5 with status "achieved".
4. If cycle > max_cycles: break with status "exhausted".

Log: "Cycle {N}/{max_cycles} — {goal_metric}: {current_value} (target: {goal_target})"

### 4b. Propose the Next Experiment

Run the proposal logic from `/propose-experiments` Steps 1-4, with these adjustments for non-interactive mode:

1. **Load context** (same as propose-experiments Step 1):
   - Re-read project config and baseline
   - Scan ALL experiment history: both previous auto-run experiments AND any manual experiments in `.experiments/*/idea.md`

2. **Focus area** — auto-derive from the goal metric instead of asking the user:
   - If goal metric relates to accuracy/quality/relevance → "Overall accuracy / quality"
   - If goal metric relates to latency/speed → "Speed / latency"
   - If goal metric relates to cost → "Cost reduction"
   - If goal metric relates to errors/completion/reliability → "Reliability / error handling"
   - Otherwise → use the metric name directly as the focus

3. **Parallel analysis** (same as propose-experiments Step 3):
   - Launch `codebase-analyzer` agent (mode=codebase) with focus area, config, baseline, gap-to-target
   - Launch `codebase-analyzer` agent (mode=history) with full experiment history INCLUDING lessons from prior cycles of this auto-run
   - Web research (2-3 searches for relevant techniques)
   - Wait for all to complete

4. **Synthesize & rank** (same as propose-experiments Step 4):
   - Combine agent outputs and web research
   - Produce 3-5 ranked ideas
   - **CRITICAL FILTER**: Exclude any idea that is substantially similar to an experiment already tried in THIS auto-run that was discarded or quick-rejected. Check slugs and hypotheses for similarity.
   - Auto-select the **top-ranked** idea. No user interaction.

5. If no viable ideas can be generated (all top ideas were already tried, or agents return nothing useful):
   - Log: "Cannot generate new experiment ideas after {N} cycles. Stopping."
   - Break out of loop, go to Step 5 with status "ideas_exhausted".

Store the selected idea as `selected_idea` (title, hypothesis, approach, expected impact).

### 4c. Implement the Experiment

Follow the same logic as `/experiment` Steps 3-5:

1. **Generate slug** from the idea title (lowercase, hyphens, max 40 chars)

2. **Generate timestamp**:
   ```bash
   date +%Y%m%d-%H%M%S
   ```

3. **Create experiment directory**:
   ```bash
   mkdir -p ".experiments/{slug}-{timestamp}"
   mkdir -p ".experiments/{slug}-{timestamp}/eval-output"
   ```

4. **Write idea.md** — `.experiments/{slug}-{timestamp}/idea.md`:
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
   auto_run: ".experiments/auto-run-{auto_timestamp}"
   cycle: {N}
   ---

   # Experiment: {Idea Title}

   ## Hypothesis
   {hypothesis}

   ## Approach
   1. {step 1}
   2. {step 2}
   3. {step 3}

   ## Expected Outcome
   - {metric}: {expected change}
   ```

5. **Create git worktree**:
   ```bash
   git worktree add .worktrees/exp-{slug} -b experiment/{slug}
   ```
   If branch exists, add timestamp suffix.

6. **Implement changes** (full autonomy):
   - ALL file reads and writes target `{WORKTREE}/path/to/file`
   - Make minimal, focused changes that test the hypothesis
   - **CRITICAL: Stack on top of merged changes** — the worktree starts from current main HEAD, which includes all previously merged experiments. NEVER remove or revert changes from prior merged experiments. Your changes must be ADDITIVE.
   - Commit in the worktree:
     ```bash
     cd {WORKTREE} && git add -A && git commit -m "experiment: {slug} — {brief description}"
     ```

### 4d. Quick Evaluation (Phase 1)

**Skip this step if `quick_eval_enabled` is false.** Go directly to Step 4e.

1. **Build the data subset**:

   If `subset_method` is `random`:
   ```bash
   shuf -n {subset_count} {test_data_path} > /tmp/experiment-lab-quick-subset.jsonl
   ```

   If `subset_method` is `first_n`:
   ```bash
   head -n {subset_count} {test_data_path} > /tmp/experiment-lab-quick-subset.jsonl
   ```

   If `subset_method` is `dedicated_file`:
   Use `quick_eval.subset_data_path` directly — no temp file needed. Set `subset_file = {subset_data_path}`.

   For random and first_n, set `subset_file = /tmp/experiment-lab-quick-subset.jsonl`.

2. **Run eval with subset data**:

   The eval command needs to point at the subset file instead of the full test data. Determine how to pass the subset:
   - If the eval command contains a reference to the test data path, substitute it with `{subset_file}`
   - If the eval command reads from a default location, copy the subset file to that location within the worktree (backup the original first)

   ```bash
   cd {WORKTREE} && {environment_setup_commands} && {eval_command_with_subset} 2>&1 | tee ../../.experiments/{slug}-{timestamp}/quick-run.log
   ```

3. **Parse quick-eval metrics**:
   Same as `/experiment` Step 8a — read the eval output and extract metric values based on `evaluation.output_format`.

4. **Compute weighted delta**:
   Same formula as `/experiment` Step 8c-8d — direction-aware comparison against baseline, weighted overall score.

5. **Write quick-metrics.md** — ALWAYS write this, regardless of pass/fail:

   Write `.experiments/{slug}-{timestamp}/quick-metrics.md`:
   ```markdown
   ---
   eval_phase: quick
   subset_percent: {percent}
   subset_count: {count}
   subset_method: "{method}"
   eval_exit_code: {code}
   evaluated_at: "{ISO-8601}"
   metrics:
     {metric_name}:
       baseline: {value}
       experiment: {value}
       delta: {value}
       delta_pct: {value}
       direction: "{direction}"
       improved: {true/false}
   overall_weighted_delta: {value}
   proceed_threshold: {threshold}
   passed: {true/false}
   ---

   # Quick Evaluation Results: {Idea Title}

   Evaluated on {subset_percent}% of test data ({subset_count} of {total_count} cases).

   | Metric | Baseline | Quick Eval | Delta | Improved? |
   |--------|----------|------------|-------|-----------|
   | {name} | {value}  | {value}    | {+/-} | {YES/NO} |

   **Weighted delta**: {value}%
   **Threshold**: {threshold}%
   **Decision**: {PROCEED to full eval / SKIP full eval — early discard}
   ```

6. **Decision gate**:

   If quick eval **exit code is non-zero** (eval crashed):
   - Log: "Quick eval failed to run (exit code {code}). Proceeding to full eval as fallback."
   - Go to Step 4e (give the full eval a chance — the crash might be subset-specific).

   If `overall_weighted_delta >= proceed_threshold`:
   - Log: "Quick eval passed ({weighted_delta}% >= {threshold}%). Proceeding to full evaluation."
   - Go to Step 4e.

   If `overall_weighted_delta < proceed_threshold`:
   - Log: "Quick eval failed ({weighted_delta}% < {threshold}%). Skipping full evaluation."
   - **Generate artifacts before discarding** (see Step 4d-artifacts below)
   - Auto-discard: go to Step 4f with `outcome = "quick_rejected"`.

   **Step 4d-artifacts** (for quick-rejected experiments):
   - Generate changes.diff:
     ```bash
     cd {WORKTREE} && git diff main...HEAD > ../../.experiments/{slug}-{timestamp}/changes.diff
     ```
   - Copy raw results JSON, summary JSON, and generate HTML report to `.experiments/{slug}-{timestamp}/eval-output/`
   - Update idea.md: set `status: quick_rejected`, `completed_at: {timestamp}`

### 4e. Full Evaluation (Phase 2)

This step runs only if:
- Quick eval was skipped (disabled), OR
- Quick eval passed the threshold, OR
- Quick eval crashed (fallback)

1. **Set up environment and run full eval**:
   ```bash
   cd {WORKTREE} && {environment_setup_commands} && {eval_command} 2>&1 | tee ../../.experiments/{slug}-{timestamp}/run.log
   ```

2. **Monitor long-running evaluations**:
   If evaluation takes more than 30 seconds, provide periodic progress:
   - Every 60 seconds, read last 5 lines of `run.log`
   - Report: "Cycle {N} — Full eval running ({elapsed})... Last output: {tail}"

3. **Handle timeout**:
   If evaluation exceeds `timeout_seconds`: kill the process, mark experiment as failed, proceed to Step 4f with `outcome = "failed"`.

4. **Handle eval failure** (non-zero exit code):
   - Read last 30 lines of run.log
   - Attempt ONE automatic fix (analyze error, fix code, re-commit, re-run)
   - If retry also fails: mark as failed, proceed to Step 4f with `outcome = "failed"`

5. **Extract metrics & compare** (same as `/experiment` Steps 8a-8d):
   - Parse eval output based on configured format
   - For each metric: compute baseline, experiment, delta, delta_pct, improved
   - Compute weighted overall score

6. **Generate artifacts**:

   Generate changes.diff:
   ```bash
   cd {WORKTREE} && git diff main...HEAD > ../../.experiments/{slug}-{timestamp}/changes.diff
   ```

   Copy ALL eval/benchmark output. You MUST save these three artifacts:
   1. **Raw results JSON** — the full benchmark output with per-case model responses (e.g., `{timestamp}.json`, `results.json`)
   2. **Summary JSON** — the aggregated metrics summary (e.g., `{timestamp}_summary.json`, `summary.json`)
   3. **HTML report** — the interactive viewer (generate if the project has a report command)

   ```bash
   # Copy raw results and summary
   cp {WORKTREE}/{eval_output_dir}/*.json .experiments/{slug}-{timestamp}/eval-output/
   # Generate HTML report
   {report_command} {raw_results_json} -o .experiments/{slug}-{timestamp}/eval-output/report.html
   ```
   Also copy any other artifacts (`.jsonl`, `.csv`) from the eval output directory. The goal is to preserve the complete benchmark run so results can be reviewed later without re-running.

   Generate HTML report (if configured):
   If the project has a report generation command (check config for `evaluation.report_command` or look for report generator scripts like `*viewer*.py`, `*report*.py`):
   ```bash
   {report_command} {eval_output_file} -o .experiments/{slug}-{timestamp}/eval-output/report.html
   ```

   Write metrics.md — `.experiments/{slug}-{timestamp}/metrics.md`:
   ```markdown
   ---
   status: completed
   eval_exit_code: 0
   eval_duration_seconds: {duration}
   evaluated_at: "{ISO-8601}"
   eval_phases:
     quick_eval_ran: {true/false}
     quick_eval_passed: {true/false}
     quick_eval_weighted_delta: {value or null}
     full_eval_ran: true
   metrics:
     {metric_name}:
       baseline: {value}
       experiment: {value}
       delta: {value}
       delta_pct: {value}
       direction: "{direction}"
       improved: {true/false}
   overall_weighted_delta: {value}
   overall_improved: {true/false}
   ---

   # Experiment Results: {Idea Title}

   ## Summary
   This experiment **{improved/degraded}** the weighted overall score by {abs(weighted_delta)}%.

   | Metric | Baseline | Experiment | Delta | Change | Improved? |
   |--------|----------|------------|-------|--------|-----------|
   | {name} | {value}  | {value}    | {+/-} | {pct}% | {YES/NO}  |

   ## Analysis
   {Analysis of results — what improved, what degraded, why, trade-offs}
   ```

### 4f. Auto-Decide

Based on the evaluation outcome:

**If `outcome` is "quick_rejected":**
1. Commit experiment artifacts:
   ```bash
   git add .experiments/{slug}-{timestamp}/
   git commit -m "auto-experiment: cycle {N} — {slug} (quick-rejected)"
   ```
2. Record lesson: "Quick test showed {weighted_delta}% regression on {subset_percent}% subset. Hypothesis: {hypothesis}. The approach of {brief description} did not show promise."

**If `outcome` is "failed":**
1. Update idea.md: `status: failed`, `completed_at: {timestamp}`
2. Commit experiment artifacts:
   ```bash
   git add .experiments/{slug}-{timestamp}/
   git commit -m "auto-experiment: cycle {N} — {slug} (failed)"
   ```
3. Record lesson: "Evaluation failed with exit code {code}. Error: {brief error summary}. The approach may need debugging."

**If `overall_weighted_delta > 0` (improvement) — AUTO-MERGE:**
1. Merge experiment branch into main:
   ```bash
   git checkout main
   git merge experiment/{slug} --no-ff -m "auto-experiment: merge {slug} — cycle {N}, weighted delta +{delta}%"
   ```
2. If merge conflict occurs:
   - **STOP THE LOOP** — this requires human intervention
   - Use AskUserQuestion to inform the user of the conflict and ask how to proceed
   - After resolution (or abort), continue to Step 5 with status "merge_conflict"
3. Update baseline metrics:
   - The experiment's metric values become the new baseline
   - Write updated `.experiments/baseline-metrics.md`
4. Update idea.md: `status: merged`, `merged_at: {timestamp}`
5. Commit artifacts and updated baseline:
   ```bash
   git add .experiments/{slug}-{timestamp}/ .experiments/baseline-metrics.md
   git commit -m "auto-experiment: record results for {slug} (merged, cycle {N})"
   ```

**If `overall_weighted_delta <= 0` (no improvement or regression) — AUTO-DISCARD:**
1. Update idea.md: `status: discarded`, `discarded_at: {timestamp}`
2. Commit experiment artifacts:
   ```bash
   git add .experiments/{slug}-{timestamp}/
   git commit -m "auto-experiment: cycle {N} — {slug} (discarded, delta {delta}%)"
   ```
3. Record lesson: "Full eval showed {weighted_delta}% overall delta. {metric}: {baseline} → {experiment}. The approach of {brief description} did not improve the target metric."

### 4g. Artifact Checklist (MANDATORY before next cycle)

Before proceeding to the next cycle, verify ALL of the following are done. Do NOT skip any step:

- [ ] **idea.md updated** — status set to merged/discarded/quick_rejected/failed, timestamps set
- [ ] **metrics.md created** — full metric comparison table, weighted delta, analysis section
- [ ] **quick-metrics.md created** (if quick eval ran) — subset results
- [ ] **changes.diff generated** — `git diff main...HEAD` captured
- [ ] **raw results JSON copied** — full benchmark output with per-case model responses
- [ ] **summary JSON copied** — aggregated metrics summary
- [ ] **HTML report generated** — interactive viewer saved to `eval-output/report.html`
- [ ] **progress.md updated** — cycle appended to YAML and markdown body (see below)
- [ ] **baseline-metrics.md updated** (if merged) — new baseline values
- [ ] **All artifacts committed to git**

### 4h. Record Cycle Result

Update `.experiments/auto-run-{timestamp}/progress.md` — append to the `cycles` array in the YAML frontmatter:

```yaml
cycles:
  - cycle: {N}
    experiment_slug: "{slug}"
    experiment_dir: ".experiments/{slug}-{timestamp}"
    idea_title: "{title}"
    hypothesis: "{hypothesis}"
    outcome: "{merged|discarded|quick_rejected|failed}"
    quick_eval_delta: {value or null}
    full_eval_delta: {value or null}
    goal_metric_before: {value}
    goal_metric_after: {value}
    lesson: "{one-sentence summary}"
```

Also append to the markdown body:

```markdown
### Cycle {N}: {Idea Title}
- **Outcome**: {merged/discarded/quick_rejected/failed}
- **Quick eval**: {delta}% (threshold: {threshold}%) — {passed/failed/skipped}
- **Full eval**: {delta}% — {merged/discarded/skipped}
- **{goal_metric}**: {before} → {after}
- **Lesson**: {lesson}
```

### 4i. Learn from Failure

If the experiment was discarded, quick-rejected, or failed:

Compile a "lessons learned" context string that will be passed to the codebase-analyzer agents in the next cycle's proposal step (Step 4b). This accumulates across cycles:

```
## Lessons from Prior Cycles (DO NOT repeat these approaches)

### Cycle {N}: {title} — {outcome}
Hypothesis: {hypothesis}
Result: {what happened}
Lesson: {why it failed, what to avoid}

### Cycle {N-1}: ...
```

This context is passed as part of the history to both codebase-analyzer agents, ensuring they don't propose the same failing approaches again.

**Loop back to Step 4a.**

## Step 5: Final Summary

After the loop ends (goal reached, cycles exhausted, ideas exhausted, or merge conflict), generate a comprehensive summary.

### 5a. Compute totals

- Total cycles run
- Cycles merged / discarded / quick-rejected / failed
- Starting baseline vs ending baseline for all metrics
- Total time elapsed
- Time saved by quick-eval (estimated: count of quick-rejected cycles * avg full eval time)

### 5b. Write summary.md

Write `.experiments/auto-run-{timestamp}/summary.md`:

```markdown
---
status: "{achieved|not_achieved|ideas_exhausted|merge_conflict}"
goal_metric: "{metric_name}"
goal_target: {value}
total_cycles: {N}
cycles_merged: {N}
cycles_discarded: {N}
cycles_quick_rejected: {N}
cycles_failed: {N}
started_at: "{ISO-8601}"
completed_at: "{ISO-8601}"
baseline_start:
  {metric}: {value}
baseline_end:
  {metric}: {value}
---

# Auto-Experiment Run Summary

## Goal: {goal description}
**Status**: {ACHIEVED / NOT ACHIEVED / STOPPED — ideas exhausted / STOPPED — merge conflict}
**Cycles run**: {N} of {max_cycles}
**Duration**: {total time}

## Metric Progress

| Cycle | Experiment | Quick Delta | Full Delta | {goal_metric} | Outcome |
|-------|------------|-------------|------------|----------------|---------|
| 1     | {title}    | +2.3%       | +1.8%      | {before} → {after} | Merged |
| 2     | {title}    | -5.1%       | skipped    | {value}        | Quick-rejected |
| 3     | {title}    | +1.0%       | +3.2%      | {before} → {after} | Merged |
| ...   | ...        | ...         | ...        | ...            | ...     |

## All Metrics: Start vs End

| Metric | Start | End | Total Change | Direction |
|--------|-------|-----|--------------|-----------|
| {name} | {v0}  | {vN} | {delta}%    | {better/worse} |

## Experiment Artifacts

All experiment data is preserved in:
| Cycle | Directory | Status |
|-------|-----------|--------|
| 1     | `.experiments/{slug}-{timestamp}/` | {status} |
| 2     | `.experiments/{slug}-{timestamp}/` | {status} |
| ...   | ... | ... |

## Lessons Learned

1. **What worked**: {Summary of approaches that improved metrics and why}
2. **What didn't work**: {Summary of failed/discarded approaches and why}
3. **Quick eval effectiveness**: {N} of {total} experiments were quick-rejected, saving approximately {time} of evaluation time
4. **Suggestions for next steps**: {If goal not reached, suggest directions for manual experiments or a new auto-experiment run with different focus}
```

### 5c. Update progress.md status

Update the YAML frontmatter in progress.md: set `status` to the final status and add `completed_at`.

### 5d. Commit summary

```bash
git add .experiments/auto-run-{timestamp}/
git commit -m "auto-experiment: {N} cycles complete — {goal_metric} {start_value} → {end_value} ({status})"
```

### 5e. Present to user

Display the summary to the user. Highlight:
- Whether the goal was achieved
- The metric progress across cycles
- Key lessons learned
- Suggested next steps

If goal was achieved:
"Goal achieved in {N} cycles! {goal_metric} improved from {start} to {end} (target: {target})."

If not achieved:
"Goal not reached after {N} cycles. {goal_metric} improved from {start} to {end} (target: {target}). {gap remaining}. Consider: {suggestions}."

## Rules

1. **Never modify files on main during a cycle** — all code changes happen in worktrees
2. **Always preserve ALL experiment artifacts** — merged, discarded, quick-rejected, and failed experiments ALL keep their full artifact directories (idea.md, metrics, logs, diffs, eval output). Nothing is deleted.
3. **Never delete worktrees or branches** — after each cycle (merged, discarded, quick-rejected, failed), leave the worktree and branch intact. Only clean up if the user explicitly asks.
4. **Stack changes on merged experiments** — new experiments start from current main HEAD (which includes all merged experiments). NEVER remove or revert previously merged changes. All changes must be additive.
5. **Auto-merge only on improvement** — weighted delta must be strictly positive
6. **Stop on merge conflicts** — never force-resolve, ask the user
7. **No duplicate experiments** — track what was tried and don't repeat it
8. **Feed lessons forward** — each failed cycle's lesson informs the next cycle's proposal
9. **Quick eval is a heuristic, not absolute** — if it crashes, fall back to full eval
10. **Complete the artifact checklist before every next cycle** — idea.md, metrics.md, quick-metrics.md, changes.diff, eval output, HTML report, progress.md, baseline update, git commit. Never skip artifact updates.
11. **Generate HTML reports** — if the project has a report generator, always save report.html to eval-output/
12. **Log everything** — every decision, every metric, every lesson goes into progress.md
13. **Commit after every cycle** — even failed experiments get their artifacts committed to git
14. **Honest reporting** — don't sugarcoat results in the summary. If progress plateaued, say so.
