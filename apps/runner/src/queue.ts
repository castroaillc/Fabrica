// The job queue on pg-boss, in a schema of its own: fabrica run enqueues { repo, id }, a worker claims it and calls resumeJob.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PgBoss } from "pg-boss";
import { isValidJobId } from "./jobFolder.js";
import { resumeJob } from "./runner.js";
import type { RunnerOptions } from "./runner.js";
import { checkSchemaName } from "./store.js";

export const QUEUE_SCHEMA = "fabrica_queue";

// A message carries only the job's key. The feature and all state come from the store.
export interface JobMessage {
  repo: string;
  id: string;
}

export interface JobQueue {
  send(message: JobMessage): Promise<void>;
}

export interface QueueConfig {
  databaseUrl: string;
  schema?: string;
  // Test-only: lower to pg-boss's minimum of 10 so a lost worker is noticed sooner.
  heartbeatSeconds?: number;
}

// One queue per repo, so a worker only ever sees jobs for the repo it was started in.
export function queueName(repo: string): string {
  return `fabrica-jobs-${createHash("sha256").update(resolve(repo)).digest("hex").slice(0, 16)}`;
}

async function startBoss(config: QueueConfig, repo: string, notify: (message: string) => void): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: checkSchemaName(config.schema ?? QUEUE_SCHEMA) });
  boss.on("error", (error) => notify(`pg-boss: ${error.message}`));
  await boss.start();
  try {
    await boss.createQueue(queueName(repo), {
      heartbeatSeconds: config.heartbeatSeconds ?? 60,
      expireInSeconds: 86400,
      retryLimit: 3,
    });
  } catch (error) {
    await boss.stop();
    throw error;
  }
  return boss;
}

export async function openQueue(
  config: QueueConfig,
  repo: string,
  notify: (message: string) => void,
): Promise<JobQueue & { close(): Promise<void> }> {
  const boss = await startBoss(config, repo, notify);
  const name = queueName(repo);
  return {
    async send(message) {
      await boss.send(name, message);
    },
    async close() {
      await boss.stop();
    },
  };
}

export interface Worker {
  // Stops pg-boss. Graceful by default: an active job gets pg-boss's grace period before it is failed for a retry.
  stop(options?: { graceful?: boolean }): Promise<void>;
}

// Claims one job at a time for options.repo and drives it with resumeJob. A thrown error fails the message, so pg-boss retries it.
export async function startWorker(
  options: RunnerOptions,
  config: QueueConfig,
): Promise<Worker> {
  const { notify } = options;
  const repo = resolve(options.repo);
  const boss = await startBoss(config, repo, notify);
  try {
    await boss.work<JobMessage>(queueName(repo), { batchSize: 1, localConcurrency: 1 }, async ([job]) => {
      if (job === undefined) return;
      try {
        const { repo: from, id } = job.data;
        if (from !== repo) throw new Error(`the message is for another repo: ${JSON.stringify(from)}`);
        if (typeof id !== "string" || !isValidJobId(id)) throw new Error(`invalid job id: ${JSON.stringify(id)}`);
        await resumeJob(options, id);
      } catch (error) {
        notify(`queue job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    });
  } catch (error) {
    await boss.stop();
    throw error;
  }
  return { stop: (stopOptions = {}) => boss.stop({ graceful: stopOptions.graceful ?? true }) };
}
