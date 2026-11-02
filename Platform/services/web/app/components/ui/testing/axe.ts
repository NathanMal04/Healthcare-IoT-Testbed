// Test-only: automated accessibility checks (axe-core) for components
// rendered in jsdom. jsdom has no layout or colours, so the colour-contrast
// rule is off (contrast comes from the design tokens), as is "region", which
// asks for a whole page's landmarks and doesn't apply to a lone component.

import axe from "axe-core";

/** The accessibility violations in `root`, one readable line each (empty when clean). */
export async function axeViolations(root: Element): Promise<string[]> {
  // axe probes <canvas> to detect icon fonts; jsdom has no canvas and logs an
  // error for each probe. Without one, axe treats the text as plain text.
  if (typeof HTMLCanvasElement !== "undefined" && !(HTMLCanvasElement.prototype as { __axeQuiet?: boolean }).__axeQuiet) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { value: () => null, configurable: true });
    Object.defineProperty(HTMLCanvasElement.prototype, "__axeQuiet", { value: true });
  }
  const results = await axe.run(root, {
    rules: {
      "color-contrast": { enabled: false },
      region: { enabled: false },
    },
  });
  return results.violations.map(
    (v) => `${v.id}: ${v.help} [${v.nodes.map((n) => n.target.join(" ")).join(" | ")}]`
  );
}
