/**
 * Turns a notebook into an L1 script ("Save as script").
 *
 * In a notebook, `ctx = context()` (from platform_notebook) gives the same
 * ctx a script's run(ctx) gets. The script keeps the code cells, in order:
 * - the platform_notebook import and `ctx = context(...)` lines are dropped;
 * - IPython-only lines (`%magic`, `!shell`) are commented out;
 * - a PEP 723 `# /// script` block, if a cell has one, goes first;
 * - if the notebook already defines `def run(ctx)` at the top level, the code
 *   stays as it is; otherwise single-line imports stay at the top and the
 *   rest becomes the body of `def run(ctx):`.
 * Markdown cells become comments.
 */

interface Cell {
  cell_type: string;
  source: string | string[];
}

const DROP = [
  /^\s*from\s+platform_notebook\s+import\b/,
  /^\s*import\s+platform_notebook\b/,
  /^\s*ctx\s*=\s*(platform_notebook\.)?context\(.*\)\s*(#.*)?$/,
];
const MAGIC = /^\s*[%!]/;
const IMPORT = /^(import\s+\S|from\s+\S+\s+import\s+[^(\\]+$)/;
const DEFINES_RUN = /^def\s+run\s*\(/m;
const CALLS_RUN = /^run\s*\(\s*ctx\s*\)\s*$/;

function sourceOf(cell: Cell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source;
}

export function notebookToScript(notebook: unknown, title: string): string {
  const cells = ((notebook as { cells?: Cell[] })?.cells ?? []).filter(
    (c) => c.cell_type === "code" || c.cell_type === "markdown"
  );
  if (!cells.some((c) => c.cell_type === "code" && sourceOf(c).trim())) {
    throw new Error("This notebook has no code to save");
  }

  let pep723 = "";
  const blocks: { kind: "code" | "markdown"; lines: string[] }[] = [];
  for (const cell of cells) {
    let text = sourceOf(cell).replace(/\r\n/g, "\n");
    if (cell.cell_type === "markdown") {
      if (text.trim()) blocks.push({ kind: "markdown", lines: text.trimEnd().split("\n").map((l) => `# ${l}`.trimEnd()) });
      continue;
    }
    const block = text.match(/^# \/\/\/ script\n[\s\S]*?^# \/\/\/\s*$/m);
    if (block && !pep723) {
      pep723 = block[0];
      text = text.replace(block[0], "");
    }
    const lines = text
      .split("\n")
      .filter((line) => !DROP.some((re) => re.test(line)))
      .map((line) => (MAGIC.test(line) ? `# (notebook only) ${line.trim()}` : line));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length) blocks.push({ kind: "code", lines });
  }

  const header = [
    ...(pep723 ? [pep723, ""] : []),
    `# Saved from the notebook "${title}".`,
    "# The platform calls run(ctx) once per work unit; see the Scripts page for ctx.",
    "",
  ];

  const code = blocks.filter((b) => b.kind === "code").map((b) => b.lines.join("\n")).join("\n");
  if (DEFINES_RUN.test(code)) {
    const body = blocks.map((b) => b.lines.filter((l) => !CALLS_RUN.test(l)).join("\n"));
    return [...header, body.join("\n\n"), ""].join("\n");
  }

  const imports: string[] = [];
  const body: string[] = [];
  for (const block of blocks) {
    if (body.length) body.push("");
    for (const line of block.lines) {
      if (block.kind === "code" && IMPORT.test(line)) {
        if (!imports.includes(line.trim())) imports.push(line.trim());
      } else {
        body.push(line);
      }
    }
  }
  while (body.length && !body[0].trim()) body.shift();
  const indented = body.map((line) => (line.trim() ? `    ${line}` : ""));
  return [
    ...header,
    ...(imports.length ? [...imports, "", ""] : []),
    "def run(ctx):",
    ...(indented.some((l) => l.trim()) ? indented : ["    pass"]),
    "",
  ].join("\n");
}
