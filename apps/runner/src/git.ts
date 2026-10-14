// Runs host commands as argument arrays through execFile, never through a shell.
import { execFile } from "node:child_process";

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  // On failure: stderr, else stdout, else the error message.
  error: string;
}

export function run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  return new Promise((done) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      const text = error ? stderr.trim() || stdout.trim() || error.message : "";
      done({ ok: error === null, stdout, stderr, error: text });
    });
  });
}

export function git(args: readonly string[], cwd: string): Promise<RunResult> {
  return run("git", args, cwd);
}
