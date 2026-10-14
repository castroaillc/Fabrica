#!/usr/bin/env node
// Runs the CLI from its TypeScript sources: tsx resolves next to this file, so any cwd works.
import { register } from "tsx/esm/api";

register();
await import("../src/bin.ts");
