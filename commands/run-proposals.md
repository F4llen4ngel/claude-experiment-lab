---
description: Execute cloud-generated proposals as autonomous experiment cycles
argument-hint: <goal description> [--cycles N]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Agent]
model: opus
---

# /run-proposals — Execute Cloud Proposals

You are the **experiment-lab** proposal executor. You consume experiment proposals written by cloud Claude (via `/plan-experiments`) and run them through the evaluate → decide loop. Each proposal has concrete code changes that you implement and test against real data.

This is the local-only counterpart to `/plan-experiments`. The flow is:
1. Cloud Claude runs `/plan-experiments` → writes proposals to `.experiments/proposals/`
2. You run `/run-proposals` → implement each proposal, evaluate, merge or discard

## Step 1: Parse Arguments & Validate

### 1a. Parse $ARGUMENTS

Extract from the user's input:
- **Goal description**: natural language (e.g., "improve accuracy to 90%")
- **max_cycles**: integer, extracted from `--cycles N` flag. Default: number of pending proposals.

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

### 1f. Check if goal is already met

Compare the current baseline value for the goal metric against the target.
If already met, report: "Goal already achieved! Current {metric}: {value}, target: {target}." and stop.

### 1g. Check git state

```bash
git status --porcelain
```
If dirty, stop with: "Your working directory has uncommitted changes. Please commit or stash them before running proposals."

### 1h. Load proposals

Scan for pending proposals:
```bash
ls .experiments/proposals/*.md 2>/dev/null
```

If no proposals directory or no `.md` files found, stop with: "No proposals found in `.experiments/proposals/`. Run `/plan-experiments` from cloud Claude first to generate proposals."

For each proposal file found:
1. Read the file and parse the YAML frontmatter
2. Filter to only `status: pending` proposals
3. Sort by file modification time (oldest first — FIFO order)

If no pending proposals remain, stop with: "All proposals have been processed (none with `status: pending`). Generate new proposals with `/plan-experiments` from cloud Claude."

Store the sorted proposal queue as `pending_proposals`.

If `max_cycles` was not explicitly set by the user, default it to the number of pending proposals.

Log: "Found {N} pending proposals. Will process up to {max_cycles} in this run."

## Step 2: Quick-Test Setup

### 2a. Read quick_eval config

If `.experiments/config.md` has a `quick_eval` block, use those settings:
- `subset_percent` (default: 20)
- `subset_method` (default: "random") — one of: `random`, `first_n`, `dedicated_file`
- `subset_data_path` (only for `dedicated_file` method)
- `proceed_threshold` (default: -2.0) — minimum weighted delta % to proceed to full eval

If no `quick_eval` block exists, use defaults: 20% random subset, -2.0% threshold.

### 2b. Determine quick-eval feasibility

Check `test_data.source`:
- If `local_files` or similar: quick eval is feasible.
- If `external_api`, `generated`, or similar: quick eval is NOT feasible. Set `quick_eval_enabled = false`.

### 2c. Locate test data file

If quick eval is feasible:
1. Identify the test data file path from `test_data.location`
2. Count total entries: `wc -l < {test_data_path}`
3. Compute subset size: `subset_count = total * subset_percent / 100` (minimum 5 entries)

## Step 3: Create Auto-Run Directory

### 3a. Generate timestamp
```bash
date +%Y%m%d-%H%M%S
```

### 3b. Create directory and write initial progress.md

```bash
mkdir -p ".experiments/auto-run-{timestamp}"
```

Write `.experiments/auto-run-{timestamp}/progress.md`:

```markdown
---
goal_metric: "{metric_name}"
goal_target: {value}
goal_direction: "{direction}"
max_cycles: {N}
mode: proposals
proposal_count: {N}
quick_eval_enabled: {true/false}
started_at: "{ISO-8601}"
status: running
baseline_at_start:
  {metric_name}: {value}
cycles: []
---

# Proposal Execution Run

**Goal**: {goal description}
**Mode**: Executing {N} cloud proposals
**Started**: {timestamp}
**Quick eval**: {enabled/disabled}

## Cycles

(Updated after each cycle)
```

## Step 4: Main Loop

For `cycle = 1` to `max_cycles`:

### 4a. Check Termination Conditions

1. Re-read `.experiments/baseline-metrics.md` to get the latest baseline.
2. Check if the goal metric has reached the target → **GOAL REACHED**, go to Step 5.
3. If `pending_proposals` is empty → go to Step 5 with status "proposals_exhausted".

Log: "Cycle {N}/{max_cycles} — {goal_metric}: {current_value} (target: {goal_target})"

### 4b. Load Next Proposal

Pop the next proposal from `pending_proposals`:

1. Read the full proposal file from `.experiments/proposals/{slug}.md`
2. Parse the YAML frontmatter and markdown body:
   - `title`, `hypothesis`, `approach`, `expected_impact`
   - **Code Changes** section — the concrete code modifications proposed by cloud Claude
3. Update the proposal file's YAML frontmatter: set `status: in_progress`

Log: "Cycle {N}: implementing proposal '{title}'"

### 4c. Implement the Proposal

1. **Generate slug** from the proposal title (lowercase, hyphens, max 40 chars)

2. **Generate timestamp**: `date +%Y%m%d-%H%M%S`

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
   started_at: "{ISO-8601}"
   completed_at: null
   merged_at: null
   discarded_at: null
   auto_run: ".experiments/auto-run-{auto_timestamp}"
   cycle: {N}
   proposal_file: ".experiments/proposals/{proposal_slug}.md"
   ---

   # Experiment: {Proposal Title}

   ## Hypothesis
   {hypothesis from proposal}

   ## Approach
   {approach from proposal}

   ## Expected Outcome
   {expected_impact from proposal}
   ```

5. **Create git worktree**:
   ```bash
   git worktree add .worktrees/exp-{slug} -b experiment/{slug}
   ```
   If branch exists, add timestamp suffix.

6. **Implement the proposal's code changes**:
   - ALL file reads and writes target `{WORKTREE}/path/to/file`
   - **CRITICAL: Stack on top of merged changes** — the worktree starts from current main HEAD, which includes all previously merged experiments. NEVER remove or revert changes from prior merged experiments. Your changes must be ADDITIVE.
   - Use the proposal's **Code Changes** section as implementation guidance:
     - For each code change (file, description, diff/snippet):
       - Read the current state of `{WORKTREE}/{file}`
       - Apply the proposed change, adapting if the file has changed since the proposal was written
       - If a proposed change references code that no longer exists or has moved, use the description and diff as intent and find the right place to apply it
     - The proposal provides a strong starting point, but you have full autonomy — if something doesn't make sense, adapt or improve it
   - Commit in the worktree:
     ```bash
     cd {WORKTREE} && git add -A && git commit -m "experiment: {slug} — {brief description}"
     ```

### 4d. Quick Evaluation (Phase 1)

**Skip this step if `quick_eval_enabled` is false.** Go directly to Step 4e.

1. **Build the data subset** (same method as `/auto-experiment`):
   - `random`: `shuf -n {subset_count} {test_data_path} > /tmp/experiment-lab-quick-subset.jsonl`
   - `first_n`: `head -n {subset_count} {test_data_path} > /tmp/experiment-lab-quick-subset.jsonl`
   - `dedicated_file`: use `quick_eval.subset_data_path` directly

2. **Run eval with subset data**:
   ```bash
   cd {WORKTREE} && {environment_setup_commands} && {eval_command_with_subset} 2>&1 | tee ../../.experiments/{slug}-{timestamp}/quick-run.log
   ```

3. **Parse quick-eval metrics** and **compute weighted delta**.

4. **Write quick-metrics.md** — ALWAYS write this, regardless of pass/fail.

5. **Decision gate**:
   - Crashed → proceed to full eval as fallback
   - `weighted_delta >= threshold` → proceed to full eval
   - `weighted_delta < threshold` → generate artifacts, go to Step 4f with `outcome = "quick_rejected"`

   **Quick-rejected artifacts**:
   - Generate changes.diff: `cd {WORKTREE} && git diff main...HEAD > ../../.experiments/{slug}-{timestamp}/changes.diff`
   - Copy eval output to `.experiments/{slug}-{timestamp}/eval-output/`
   - Update idea.md: `status: quick_rejected`, `completed_at: {timestamp}`

### 4e. Full Evaluation (Phase 2)

1. **Run full eval**:
   ```bash
   cd {WORKTREE} && {environment_setup_commands} && {eval_command} 2>&1 | tee ../../.experiments/{slug}-{timestamp}/run.log
   ```

2. **Monitor** long-running evaluations (report every 60s).

3. **Handle timeout/failure**: mark as failed if unrecoverable after ONE retry.

4. **Extract metrics & compare** — parse eval output, compute weighted delta.

5. **Generate artifacts**:
   - changes.diff: `cd {WORKTREE} && git diff main...HEAD > ../../.experiments/{slug}-{timestamp}/changes.diff`
   - Copy eval output to `.experiments/{slug}-{timestamp}/eval-output/`
   - Generate HTML report (if project has a report generator)
   - Write metrics.md with full comparison table and analysis

### 4f. Auto-Decide

**If `outcome` is "quick_rejected":**
1. Commit experiment artifacts.
2. Update proposal: `status: rejected`, `reason: "Quick eval showed {delta}% delta"`, `experiment_dir: "..."`
3. Record lesson.

**If `outcome` is "failed":**
1. Update idea.md: `status: failed`, `completed_at: {timestamp}`
2. Commit experiment artifacts.
3. Update proposal: `status: rejected`, `reason: "Evaluation failed: {error}"`, `experiment_dir: "..."`
4. Record lesson.

**If `overall_weighted_delta > 0` — AUTO-MERGE:**
1. Merge: `git checkout main && git merge experiment/{slug} --no-ff -m "..."`
2. If merge conflict: **STOP**, ask user.
3. Update baseline metrics.
4. Update idea.md: `status: merged`, `merged_at: {timestamp}`
5. Commit artifacts and updated baseline.
6. Update proposal: `status: implemented`, `experiment_dir: "..."`, `result_delta: {delta}`

**If `overall_weighted_delta <= 0` — AUTO-DISCARD:**
1. Update idea.md: `status: discarded`, `discarded_at: {timestamp}`
2. Commit experiment artifacts.
3. Update proposal: `status: rejected`, `reason: "Full eval showed {delta}% delta"`, `experiment_dir: "..."`
4. Record lesson.

### 4g. Artifact Checklist (MANDATORY before next cycle)

- [ ] **idea.md updated** — status and timestamps set
- [ ] **metrics.md created** — full comparison table, weighted delta, analysis
- [ ] **quick-metrics.md created** (if quick eval ran)
- [ ] **changes.diff generated**
- [ ] **eval output copied** to eval-output/
- [ ] **HTML report generated** (if applicable)
- [ ] **proposal status updated** — marked implemented/rejected with results
- [ ] **progress.md updated** — cycle appended
- [ ] **baseline-metrics.md updated** (if merged)
- [ ] **All artifacts committed to git**

### 4h. Record Cycle Result

Update `.experiments/auto-run-{timestamp}/progress.md` — append to `cycles` array and markdown body:

```markdown
### Cycle {N}: {Proposal Title}
- **Proposal**: `.experiments/proposals/{slug}.md`
- **Outcome**: {merged/discarded/quick_rejected/failed}
- **Quick eval**: {delta}% — {passed/failed/skipped}
- **Full eval**: {delta}% — {merged/discarded/skipped}
- **{goal_metric}**: {before} → {after}
- **Lesson**: {lesson}
```

**Loop back to Step 4a.**

## Step 5: Final Summary

Write `.experiments/auto-run-{timestamp}/summary.md` and present to user:

```markdown
---
status: "{achieved|not_achieved|proposals_exhausted|merge_conflict}"
goal_metric: "{metric_name}"
goal_target: {value}
total_cycles: {N}
cycles_merged: {N}
cycles_discarded: {N}
cycles_quick_rejected: {N}
cycles_failed: {N}
proposals_total: {N}
proposals_implemented: {N}
proposals_rejected: {N}
proposals_remaining: {N}
---

# Proposal Execution Summary

## Goal: {goal description}
**Status**: {ACHIEVED / NOT ACHIEVED / PROPOSALS EXHAUSTED / MERGE CONFLICT}
**Cycles**: {N} proposals processed

## Results by Proposal

| # | Proposal | Quick Delta | Full Delta | Outcome |
|---|----------|-------------|------------|---------|
| 1 | {title}  | {delta}%    | {delta}%   | {outcome} |
| ...

## Metric Progress: {goal_metric}
Start: {value} → End: {value} (target: {target})

## Next Steps
{If proposals remain: "Run `/run-proposals` again to continue."}
{If exhausted: "Generate new proposals with `/plan-experiments` from cloud Claude, then `/export-context` to refresh the bundle."}
```

Commit summary and update progress.md status.

## Rules

1. **Never modify files on main during a cycle** — all code changes happen in worktrees
2. **Always preserve ALL experiment artifacts** — nothing is deleted
3. **Never delete worktrees or branches** — leave intact after every cycle
4. **Stack changes on merged experiments** — NEVER remove previously merged changes, always additive
5. **Auto-merge only on improvement** — weighted delta must be strictly positive
6. **Stop on merge conflicts** — never force-resolve, ask the user
7. **Always update proposal status** — mark each proposal as `implemented` or `rejected` after the cycle
8. **Respect proposal intent** — implement what cloud Claude proposed, but adapt if code has changed
9. **Complete the artifact checklist before every next cycle** — never skip artifact updates
10. **Generate HTML reports** — if the project has a report generator, always save to eval-output/
11. **Commit after every cycle** — even failed experiments get artifacts committed
12. **Honest reporting** — don't sugarcoat results
