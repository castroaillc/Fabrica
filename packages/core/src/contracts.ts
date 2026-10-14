// Parsers for the first-line contracts of build.md, review-<lens>.md and decision.md.
// Each returns null when the first line is not a valid contract; the caller decides what to do.

export type Verdict = "PASS" | "CHANGES";
export type Decision = "APPROVE" | "ESCALATE";
export type BuildStatus = "READY" | "BLOCKED";

function firstLine(content: string): string {
  const line = content.split("\n", 1)[0] ?? "";
  return line.replace(/\r$/, "").replace(/[ \t]+$/, "");
}

export function parseVerdict(content: string): Verdict | null {
  switch (firstLine(content)) {
    case "VERDICT: PASS":
      return "PASS";
    case "VERDICT: CHANGES":
      return "CHANGES";
    default:
      return null;
  }
}

export function parseDecision(content: string): Decision | null {
  switch (firstLine(content)) {
    case "APPROVE":
      return "APPROVE";
    case "ESCALATE":
      return "ESCALATE";
    default:
      return null;
  }
}

export function parseBuildStatus(content: string): BuildStatus | null {
  switch (firstLine(content)) {
    case "STATUS: READY":
      return "READY";
    case "STATUS: BLOCKED":
      return "BLOCKED";
    default:
      return null;
  }
}
