// Job ids and the job-folder write guard: the runner's own writes stay inside <repo>/factory/jobs/<id>/.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const JOB_ID = /^\d{3}-[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidJobId(id: string): boolean {
  return JOB_ID.test(id);
}

export function jobFolder(repo: string, id: string): string {
  if (!isValidJobId(id)) throw new Error(`Invalid job id: ${JSON.stringify(id)}`);
  return join(resolve(repo), "factory", "jobs", id);
}

// Resolves target lexically and throws unless it is the job folder or inside it.
export function insideJobFolder(repo: string, id: string, target: string): string {
  const folder = jobFolder(repo, id);
  const resolved = resolve(target);
  if (resolved !== folder && !resolved.startsWith(folder + sep)) {
    throw new Error(`${id}: refusing to write outside ${folder}${sep}: ${target}`);
  }
  return resolved;
}

export async function writeJobFile(repo: string, id: string, target: string, content: string): Promise<void> {
  await writeFile(insideJobFolder(repo, id, target), content);
}

export async function createJobDir(repo: string, id: string, target: string): Promise<void> {
  await mkdir(insideJobFolder(repo, id, target), { recursive: true });
}
