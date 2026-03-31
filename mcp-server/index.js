import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { resolve, relative, join, basename, dirname } from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";

// --- Project root resolution ---

const PROJECT_ROOT = resolve(process.env.PROJECT_ROOT || process.cwd());

// --- Config loading ---

function loadConfig() {
  const configPath = join(PROJECT_ROOT, ".experiments", "config.md");
  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, "utf-8");
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  return yaml.load(match[1]);
}

const config = loadConfig();

// --- Path security ---

const SENSITIVE_PATTERNS = [
  /[/\\]eval-output[/\\]/,
  /[/\\]eval-output$/,
  /run\.log$/,
  /quick-run\.log$/,
  /^\/tmp\/experiment-lab-/,
];

// Paths from config that contain sensitive data
const SENSITIVE_DATA_PATHS = [];
if (config?.test_data?.location) {
  SENSITIVE_DATA_PATHS.push(resolve(PROJECT_ROOT, config.test_data.location));
}
if (config?.quick_eval?.subset_data_path) {
  SENSITIVE_DATA_PATHS.push(
    resolve(PROJECT_ROOT, config.quick_eval.subset_data_path)
  );
}

// Under .experiments/, only these patterns are allowed
const EXPERIMENTS_ALLOWLIST = [
  /^config\.md$/,
  /^baseline-metrics\.md$/,
  /^[^/]+\/idea\.md$/,
  /^[^/]+\/metrics\.md$/,
  /^[^/]+\/quick-metrics\.md$/,
  /^[^/]+\/changes\.diff$/,
  /^auto-run-[^/]+\/progress\.md$/,
  /^auto-run-[^/]+\/summary\.md$/,
  /^proposals\//,
];

function isSensitivePath(filePath) {
  const abs = resolve(PROJECT_ROOT, filePath);

  // Path traversal protection: must be under PROJECT_ROOT
  if (!abs.startsWith(PROJECT_ROOT + "/") && abs !== PROJECT_ROOT) {
    return true;
  }

  const rel = relative(PROJECT_ROOT, abs);

  // Check .experiments/ allowlist
  if (rel.startsWith(".experiments/") || rel.startsWith(".experiments\\")) {
    const experimentRel = rel.replace(/^\.experiments[/\\]/, "");
    const allowed = EXPERIMENTS_ALLOWLIST.some((pattern) =>
      pattern.test(experimentRel)
    );
    if (!allowed) return true;
  }

  // Check sensitive filename patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(abs)) return true;
  }

  // Check sensitive data paths (test data, subset data)
  for (const sensitivePath of SENSITIVE_DATA_PATHS) {
    if (abs === sensitivePath || abs.startsWith(sensitivePath + "/")) {
      return true;
    }
  }

  return false;
}

function assertSafePath(filePath) {
  if (isSensitivePath(filePath)) {
    throw new Error(
      `Access denied: "${filePath}" may contain sensitive data and is blocked by the experiment-lab MCP security filter.`
    );
  }
}

// --- Helpers ---

function readSafeFile(filePath) {
  const abs = resolve(PROJECT_ROOT, filePath);
  assertSafePath(filePath);
  if (!existsSync(abs)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return readFileSync(abs, "utf-8");
}

function parseYamlFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: null, body: content };
  const frontmatter = yaml.load(match[1]);
  const body = content.slice(match[0].length).trim();
  return { frontmatter, body };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// --- MCP Server ---

const server = new McpServer({
  name: "experiment-lab",
  version: "1.0.0",
});

// Tool: read_code
server.tool(
  "read_code",
  "Read a source code file. Blocked for sensitive paths (test data, eval output, run logs).",
  { path: z.string().describe("Relative path from project root") },
  async ({ path: filePath }) => {
    try {
      const content = readSafeFile(filePath);
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: read_experiment_config
server.tool(
  "read_experiment_config",
  "Read the experiment configuration (.experiments/config.md).",
  {},
  async () => {
    try {
      const content = readSafeFile(".experiments/config.md");
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: read_baseline_metrics
server.tool(
  "read_baseline_metrics",
  "Read the current baseline metrics (.experiments/baseline-metrics.md).",
  {},
  async () => {
    try {
      const content = readSafeFile(".experiments/baseline-metrics.md");
      return { content: [{ type: "text", text: content }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: read_experiment_history
server.tool(
  "read_experiment_history",
  "Read all experiment history: idea.md and metrics.md for each experiment (safe portions only, no eval output or logs).",
  {},
  async () => {
    try {
      const experimentsDir = join(PROJECT_ROOT, ".experiments");
      if (!existsSync(experimentsDir)) {
        return { content: [{ type: "text", text: "No experiments directory found." }] };
      }

      const entries = readdirSync(experimentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("auto-run-") && d.name !== "proposals")
        .map((d) => d.name);

      const experiments = [];

      for (const dir of entries) {
        const experiment = { slug: dir };

        const ideaPath = join(".experiments", dir, "idea.md");
        try {
          experiment.idea = readSafeFile(ideaPath);
        } catch {
          continue; // skip dirs without idea.md
        }

        const metricsPath = join(".experiments", dir, "metrics.md");
        try {
          experiment.metrics = readSafeFile(metricsPath);
        } catch {
          experiment.metrics = null;
        }

        const quickMetricsPath = join(".experiments", dir, "quick-metrics.md");
        try {
          experiment.quick_metrics = readSafeFile(quickMetricsPath);
        } catch {
          experiment.quick_metrics = null;
        }

        experiments.push(experiment);
      }

      // Also include auto-run summaries
      const autoRuns = readdirSync(experimentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("auto-run-"))
        .map((d) => d.name);

      const autoRunSummaries = [];
      for (const dir of autoRuns) {
        const summary = {};
        try {
          summary.progress = readSafeFile(join(".experiments", dir, "progress.md"));
        } catch {
          summary.progress = null;
        }
        try {
          summary.summary = readSafeFile(join(".experiments", dir, "summary.md"));
        } catch {
          summary.summary = null;
        }
        if (summary.progress || summary.summary) {
          summary.name = dir;
          autoRunSummaries.push(summary);
        }
      }

      const result = {
        experiment_count: experiments.length,
        experiments,
        auto_run_count: autoRunSummaries.length,
        auto_runs: autoRunSummaries,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: read_experiment
server.tool(
  "read_experiment",
  "Read safe artifacts for a specific experiment: idea.md, metrics.md, quick-metrics.md, changes.diff. Never returns run logs or eval output.",
  { slug: z.string().describe("Experiment directory name (slug-timestamp)") },
  async ({ slug }) => {
    try {
      const result = {};

      const files = ["idea.md", "metrics.md", "quick-metrics.md", "changes.diff"];
      for (const file of files) {
        const filePath = join(".experiments", slug, file);
        try {
          result[file] = readSafeFile(filePath);
        } catch {
          result[file] = null;
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: write_proposal
server.tool(
  "write_proposal",
  "Write an experiment proposal to .experiments/proposals/. Used by cloud Claude to suggest experiments for local Claude to execute.",
  {
    title: z.string().describe("Proposal title"),
    hypothesis: z.string().describe("If we [change], then [metric] will [improve] because [reason]"),
    approach: z.array(z.string()).describe("Numbered implementation steps"),
    expected_impact: z
      .record(z.string(), z.string())
      .describe("Map of metric_name to expected change, e.g. { accuracy: '+5%' }"),
    code_changes: z
      .array(
        z.object({
          file: z.string().describe("File path to modify"),
          description: z.string().describe("What to change"),
          diff_or_snippet: z.string().describe("Proposed diff or code snippet"),
        })
      )
      .describe("Concrete code changes to implement"),
  },
  async ({ title, hypothesis, approach, expected_impact, code_changes }) => {
    try {
      const slug = slugify(title);
      const proposalsDir = join(PROJECT_ROOT, ".experiments", "proposals");
      mkdirSync(proposalsDir, { recursive: true });

      const timestamp = new Date().toISOString();

      // Build YAML frontmatter
      const frontmatter = {
        title,
        slug,
        proposed_at: timestamp,
        proposed_by: "cloud",
        status: "pending",
        hypothesis,
        expected_impact,
      };

      // Build markdown body
      let body = `# Proposal: ${title}\n\n`;
      body += `## Hypothesis\n${hypothesis}\n\n`;
      body += `## Approach\n`;
      approach.forEach((step, i) => {
        body += `${i + 1}. ${step}\n`;
      });
      body += `\n## Expected Impact\n`;
      for (const [metric, change] of Object.entries(expected_impact)) {
        body += `- **${metric}**: ${change}\n`;
      }
      body += `\n## Proposed Code Changes\n\n`;
      for (const change of code_changes) {
        body += `### \`${change.file}\`\n`;
        body += `${change.description}\n\n`;
        body += "```diff\n" + change.diff_or_snippet + "\n```\n\n";
      }

      const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
      const content = `---\n${yamlStr}---\n\n${body}`;

      const filePath = join(proposalsDir, `${slug}.md`);
      writeFileSync(filePath, content, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `Proposal written to .experiments/proposals/${slug}.md`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: list_files
server.tool(
  "list_files",
  "List files matching a glob pattern, filtered to exclude sensitive paths.",
  {
    pattern: z.string().describe("Glob pattern, e.g. '**/*.py' or 'src/**/*.ts'"),
  },
  async ({ pattern }) => {
    try {
      // Use system glob via find or node glob
      const cmd = `find ${PROJECT_ROOT} -path '*/.git' -prune -o -path '*/node_modules' -prune -o -type f -print`;
      const allFiles = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })
        .trim()
        .split("\n")
        .filter(Boolean);

      // Simple glob matching
      const globRegex = globToRegex(pattern);
      const matched = allFiles
        .map((f) => relative(PROJECT_ROOT, f))
        .filter((f) => globRegex.test(f))
        .filter((f) => !isSensitivePath(f))
        .sort();

      return { content: [{ type: "text", text: matched.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Tool: search_code
server.tool(
  "search_code",
  "Search file contents for a pattern (regex), filtered to exclude sensitive paths. Returns matching lines with file and line number.",
  {
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().optional().describe("Optional subdirectory to scope the search"),
  },
  async ({ pattern, path: searchPath }) => {
    try {
      const targetDir = searchPath
        ? resolve(PROJECT_ROOT, searchPath)
        : PROJECT_ROOT;

      // Use grep/rg
      let cmd;
      try {
        execSync("which rg", { encoding: "utf-8" });
        cmd = `rg -n --no-heading "${pattern.replace(/"/g, '\\"')}" "${targetDir}" 2>/dev/null || true`;
      } catch {
        cmd = `grep -rn "${pattern.replace(/"/g, '\\"')}" "${targetDir}" 2>/dev/null || true`;
      }

      const output = execSync(cmd, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });

      // Filter out sensitive paths from results
      const lines = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((line) => {
          const filePart = line.split(":")[0];
          const rel = relative(PROJECT_ROOT, filePart);
          return !isSensitivePath(rel);
        })
        .map((line) => {
          // Convert absolute paths to relative
          const abs = line.split(":")[0];
          const rel = relative(PROJECT_ROOT, abs);
          return rel + line.slice(abs.length);
        })
        .slice(0, 200); // cap results

      return { content: [{ type: "text", text: lines.join("\n") || "No matches found." }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// --- Glob helper ---

function globToRegex(pattern) {
  let regexStr = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        regexStr += "(?:.*/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (c === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (c === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
