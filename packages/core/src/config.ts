// Parses fabrica.yaml: model providers and the provider and model each agent role uses. See docs/ROADMAP.md.
// Takes file contents only; reading them from disk is the caller's job. Credentials never live in this file.
import { parse } from "yaml";

export type ProviderConfig =
  | { type: "anthropic" }
  | { type: "bedrock"; region: string }
  | { type: "vertex"; project: string; region: string }
  | { type: "anthropic-compatible"; base_url: string };

export interface RoleConfig {
  provider: string;
  model?: string;
}

export interface FabricaConfig {
  providers: Record<string, ProviderConfig>;
  roles: Record<string, RoleConfig>;
}

// Provider-selection and routing variables cleared before providerEnv is applied, so a host-wide setting can't leak
// into a role.
export const PROVIDER_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
];

// The fields each provider type takes besides type, all required non-empty strings.
const PROVIDER_FIELDS: Record<ProviderConfig["type"], readonly string[]> = {
  anthropic: [],
  bedrock: ["region"],
  vertex: ["project", "region"],
  "anthropic-compatible": ["base_url"],
};

// Hosts a gateway base_url may reach over plain http:. URL.hostname keeps the brackets around IPv6 addresses.
const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

type Mapping = Record<string, unknown>;

export function parseFabricaConfig(content: string): FabricaConfig {
  let document: unknown;
  try {
    document = parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid YAML: ${message}`);
  }
  if (document === null || document === undefined) return { providers: {}, roles: {} };
  const top = mapping(document, "top level");
  allowKeys(top, ["providers", "roles"], "");

  const providers = Object.fromEntries(
    entries(top.providers, "providers").map(([name, value]) => [name, parseProvider(value, `providers.${name}`)]),
  );
  const roles = Object.fromEntries(
    entries(top.roles, "roles").map(([name, value]) => [name, parseRole(value, `roles.${name}`, providers)]),
  );
  return { providers, roles };
}

export function providerEnv(provider: ProviderConfig): Record<string, string> {
  switch (provider.type) {
    case "anthropic":
      return {};
    case "bedrock":
      return { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: provider.region };
    case "vertex":
      return {
        CLAUDE_CODE_USE_VERTEX: "1",
        ANTHROPIC_VERTEX_PROJECT_ID: provider.project,
        CLOUD_ML_REGION: provider.region,
      };
    case "anthropic-compatible":
      return { ANTHROPIC_BASE_URL: provider.base_url };
  }
}

function parseProvider(value: unknown, path: string): ProviderConfig {
  const fields = mapping(value, path);
  const type = fields.type;
  if (typeof type !== "string" || !Object.hasOwn(PROVIDER_FIELDS, type)) {
    const known = Object.keys(PROVIDER_FIELDS).join(", ");
    throw new Error(`${path}.type must be one of ${known}, got ${JSON.stringify(type)}`);
  }
  const required = PROVIDER_FIELDS[type as ProviderConfig["type"]];
  allowKeys(fields, ["type", ...required], path);
  for (const key of required) requireString(fields[key], `${path}.${key}`);
  // The gateway receives the runner's Anthropic credentials, so it must be reached over TLS (or stay on this host)
  // and the URL carries none. Userinfo is checked first so no error message echoes credentials.
  if (type === "anthropic-compatible") {
    const baseUrl = fields.base_url as string;
    if (!URL.canParse(baseUrl)) throw new Error(`${path}.base_url must be a URL`);
    const url = new URL(baseUrl);
    if (url.username !== "" || url.password !== "") {
      throw new Error(`${path}.base_url must not contain user:pass@ credentials`);
    }
    const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) {
      throw new Error(
        `${path}.base_url must be an https: URL, or http: on localhost, 127.0.0.1 or [::1], got ${JSON.stringify(baseUrl)}`,
      );
    }
  }
  return fields as ProviderConfig;
}

function parseRole(value: unknown, path: string, providers: Record<string, ProviderConfig>): RoleConfig {
  const fields = mapping(value, path);
  allowKeys(fields, ["provider", "model"], path);
  const provider = requireString(fields.provider, `${path}.provider`);
  if (!Object.hasOwn(providers, provider)) {
    throw new Error(`${path}.provider names no declared provider: ${JSON.stringify(provider)}`);
  }
  const role: RoleConfig = { provider };
  if (fields.model !== undefined) role.model = requireString(fields.model, `${path}.model`);
  return role;
}

// A missing or empty section yields no entries.
function entries(value: unknown, path: string): [string, unknown][] {
  if (value === undefined || value === null) return [];
  return Object.entries(mapping(value, path));
}

function mapping(value: unknown, path: string): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a mapping`);
  }
  return value as Mapping;
}

function allowKeys(fields: Mapping, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) throw new Error(`${path ? `${path}.` : ""}${key} is not a known key`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}
