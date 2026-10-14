import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobDir, insideJobFolder, writeJobFile } from "./jobFolder.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "fabrica-guard-")));
  temps.push(repo);
  mkdirSync(join(repo, "factory", "jobs", "003-x"), { recursive: true });
  mkdirSync(join(repo, "factory", "jobs", "004-y"));
  return repo;
}

describe("job folder write guard", () => {
  it("writes files and directories inside the job folder", async () => {
    const repo = makeRepo();
    const folder = join(repo, "factory", "jobs", "003-x");
    await createJobDir(repo, "003-x", `${folder}/round-1/`);
    await writeJobFile(repo, "003-x", `${folder}/round-1/../decision.md`, "APPROVE\n");
    expect(existsSync(join(folder, "round-1"))).toBe(true);
    expect(readFileSync(join(folder, "decision.md"), "utf8")).toBe("APPROVE\n");
  });

  it("refuses paths outside the job folder before writing", async () => {
    const repo = makeRepo();
    const escape = `${repo}/factory/jobs/003-x/../other.md`;
    const sibling = `${repo}/factory/jobs/004-y/job.json`;
    await expect(writeJobFile(repo, "003-x", escape, "x")).rejects.toThrow(/refusing to write outside/);
    await expect(writeJobFile(repo, "003-x", sibling, "{}")).rejects.toThrow(/refusing to write outside/);
    await expect(createJobDir(repo, "003-x", `${repo}/factory/jobs/003-xy/`)).rejects.toThrow(/refusing/);
    expect(existsSync(join(repo, "factory", "jobs", "other.md"))).toBe(false);
    expect(existsSync(sibling)).toBe(false);
    expect(existsSync(join(repo, "factory", "jobs", "003-xy"))).toBe(false);
  });

  it("refuses an invalid job id", () => {
    expect(() => insideJobFolder("/r", "..", "/r/factory/x.md")).toThrow(/Invalid job id/);
  });
});
