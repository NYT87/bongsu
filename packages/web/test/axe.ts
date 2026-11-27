// axe-core over a rendered screen: the serious and critical violations, one line each ("rule: where"). Colour contrast
// is left to contrast.test.ts, which reads the stylesheets: happy-dom lays nothing out.
import axe from "axe-core";

export async function axeProblems(root: Element = document.body): Promise<string[]> {
  const r = await axe.run(root, { rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}
