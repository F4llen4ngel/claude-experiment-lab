# experiment-lab plugin

Claude Code plugin for hypothesis-driven ML experiment management.

## Structure

- `commands/` — Slash commands (/experiment-init, /experiment, /propose-experiments)
- `agents/` — Subagents (codebase-analyzer, eval-builder)
- `.claude-plugin/plugin.json` — Plugin metadata

## Development

To test locally: `claude plugin install /path/to/self-evolving-bro`

Commands use YAML frontmatter for metadata and Markdown for workflow instructions.
Agents are defined as Markdown files in `agents/` and spawned via the Agent tool with `subagent_type`.
