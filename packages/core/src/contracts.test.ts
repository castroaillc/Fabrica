import { describe, expect, it } from "vitest";
import { parseBuildStatus, parseDecision, parseVerdict } from "./index.js";

describe("parseVerdict", () => {
  it("parses PASS and CHANGES", () => {
    expect(parseVerdict("VERDICT: PASS\n\nbody")).toBe("PASS");
    expect(parseVerdict("VERDICT: CHANGES\n\n## Findings")).toBe("CHANGES");
    expect(parseVerdict("VERDICT: PASS")).toBe("PASS");
  });

  it("tolerates CRLF and trailing spaces or tabs", () => {
    expect(parseVerdict("VERDICT: CHANGES\r\n")).toBe("CHANGES");
    expect(parseVerdict("VERDICT: PASS\r\n\r\nbody")).toBe("PASS");
    expect(parseVerdict("VERDICT: PASS  \t\nbody")).toBe("PASS");
    expect(parseVerdict("VERDICT: PASS \r\n")).toBe("PASS");
  });

  it("rejects anything else", () => {
    expect(parseVerdict("verdict: pass")).toBeNull();
    expect(parseVerdict("VERDICT: pass")).toBeNull();
    expect(parseVerdict(" VERDICT: PASS")).toBeNull();
    expect(parseVerdict("\tVERDICT: PASS")).toBeNull();
    expect(parseVerdict("VERDICT:PASS")).toBeNull();
    expect(parseVerdict("VERDICT:  PASS")).toBeNull();
    expect(parseVerdict("VERDICT: PASS.")).toBeNull();
    expect(parseVerdict("VERDICT: APPROVE")).toBeNull();
    expect(parseVerdict("# Review\nVERDICT: PASS")).toBeNull();
    expect(parseVerdict("\nVERDICT: PASS")).toBeNull();
    expect(parseVerdict("")).toBeNull();
  });
});

describe("parseDecision", () => {
  it("parses APPROVE and ESCALATE", () => {
    expect(parseDecision("APPROVE\n\nLooks good.")).toBe("APPROVE");
    expect(parseDecision("ESCALATE")).toBe("ESCALATE");
    expect(parseDecision("ESCALATE\n\nReview rounds exhausted. ...")).toBe("ESCALATE");
    expect(parseDecision("APPROVE\r\n\r\nbody")).toBe("APPROVE");
    expect(parseDecision("ESCALATE \t\r\n")).toBe("ESCALATE");
  });

  it("rejects anything else", () => {
    expect(parseDecision("APPROVE | ESCALATE")).toBeNull();
    expect(parseDecision("Approve")).toBeNull();
    expect(parseDecision(" APPROVE")).toBeNull();
    expect(parseDecision("DECISION: APPROVE")).toBeNull();
    expect(parseDecision("# Decision\nAPPROVE")).toBeNull();
    expect(parseDecision("")).toBeNull();
  });
});

describe("parseBuildStatus", () => {
  it("parses READY and BLOCKED", () => {
    expect(parseBuildStatus("STATUS: READY\n\n# Build: x")).toBe("READY");
    expect(parseBuildStatus("STATUS: BLOCKED\n\n## Blocked")).toBe("BLOCKED");
    expect(parseBuildStatus("STATUS: READY\r\n")).toBe("READY");
    expect(parseBuildStatus("STATUS: BLOCKED  \n")).toBe("BLOCKED");
  });

  it("rejects anything else", () => {
    expect(parseBuildStatus("STATUS: DONE")).toBeNull();
    expect(parseBuildStatus("status: ready")).toBeNull();
    expect(parseBuildStatus(" STATUS: READY")).toBeNull();
    expect(parseBuildStatus("STATUS:READY")).toBeNull();
    expect(parseBuildStatus("# Build\nSTATUS: READY")).toBeNull();
    expect(parseBuildStatus("")).toBeNull();
  });
});
