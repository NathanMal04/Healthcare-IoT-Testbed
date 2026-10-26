import { describe, expect, it } from "vitest";
import { notebookToScript } from "./notebookScript";

const nb = (...cells: [string, string][]) => ({
  cells: cells.map(([cell_type, source]) => ({ cell_type, source })),
});

describe("notebookToScript", () => {
  it("wraps the code in run(ctx), drops context() and keeps imports at the top", () => {
    const script = notebookToScript(
      nb(
        ["markdown", "# Look at the log"],
        ["code", "from platform_notebook import context\nimport json\nctx = context()"],
        ["code", "data = ctx.input.read_text()\nctx.output('n.json').write_text(json.dumps(len(data)))"]
      ),
      "Log.ipynb"
    );
    expect(script).toContain("import json\n\n\ndef run(ctx):");
    expect(script).toContain("    # # Look at the log");
    expect(script).toContain("    data = ctx.input.read_text()");
    expect(script).not.toContain("platform_notebook");
    expect(script).not.toMatch(/ctx = context/);
  });

  it("comments out magics and shell lines", () => {
    const script = notebookToScript(nb(["code", "%matplotlib inline\n!tshark -v\nx = 1"]), "a");
    expect(script).toContain("    # (notebook only) %matplotlib inline");
    expect(script).toContain("    # (notebook only) !tshark -v");
    expect(script).toContain("    x = 1");
  });

  it("keeps a notebook that defines run(ctx) as it is, minus the call", () => {
    const script = notebookToScript(
      nb(["code", "from platform_notebook import context\nctx = context('a.pcap')"], ["code", "def run(ctx):\n    return 1"], ["code", "run(ctx)"]),
      "b"
    );
    expect(script).toContain("def run(ctx):\n    return 1");
    expect(script).not.toMatch(/^run\(ctx\)$/m);
    expect(script.match(/def run/g)).toHaveLength(1);
  });

  it("moves a PEP 723 block to the top", () => {
    const script = notebookToScript(
      nb(["code", "x = 1"], ["code", '# /// script\n# dependencies = ["rich"]\n# ///\nimport rich']),
      "c"
    );
    expect(script.startsWith('# /// script\n# dependencies = ["rich"]\n# ///')).toBe(true);
    expect(script).toContain("import rich\n");
  });

  it("refuses a notebook without code", () => {
    expect(() => notebookToScript(nb(["markdown", "hi"]), "d")).toThrow(/no code/);
  });
});
