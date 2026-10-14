import { describe, expect, it } from "vitest";
import { PROVIDER_ENV_KEYS, parseFabricaConfig, providerEnv } from "./index.js";
import type { FabricaConfig } from "./index.js";

// Copied verbatim from docs/ROADMAP.md, "Models: provider config per agent role".
const ROADMAP = `providers:
  claude-bedrock: { type: bedrock, region: us-east-1 }       # CLAUDE_CODE_USE_BEDROCK
  claude-vertex:  { type: vertex, project: acme, region: us-east5 }
  gateway:        { type: anthropic-compatible, base_url: http://localhost:4000 }  # ANTHROPIC_BASE_URL
roles:
  spec-writer:       { provider: claude-bedrock, model: claude-opus-5-5 }
  builder:           { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-security: { provider: claude-bedrock, model: claude-opus-5-5 }
  reviewer-ux:       { provider: gateway, model: qwen3-coder }   # e.g. local vLLM
`;

describe("parseFabricaConfig", () => {
  it("parses the roadmap example", () => {
    expect(parseFabricaConfig(ROADMAP)).toEqual<FabricaConfig>({
      providers: {
        "claude-bedrock": { type: "bedrock", region: "us-east-1" },
        "claude-vertex": { type: "vertex", project: "acme", region: "us-east5" },
        gateway: { type: "anthropic-compatible", base_url: "http://localhost:4000" },
      },
      roles: {
        "spec-writer": { provider: "claude-bedrock", model: "claude-opus-5-5" },
        builder: { provider: "claude-bedrock", model: "claude-opus-5-5" },
        "reviewer-security": { provider: "claude-bedrock", model: "claude-opus-5-5" },
        "reviewer-ux": { provider: "gateway", model: "qwen3-coder" },
      },
    });
  });

  it("parses an anthropic provider and a role without a model", () => {
    const config = parseFabricaConfig("providers:\n  api: { type: anthropic }\nroles:\n  builder: { provider: api }\n");
    expect(config).toEqual<FabricaConfig>({
      providers: { api: { type: "anthropic" } },
      roles: { builder: { provider: "api" } },
    });
  });

  it("yields empty maps for an empty document or missing sections", () => {
    expect(parseFabricaConfig("")).toEqual({ providers: {}, roles: {} });
    expect(parseFabricaConfig("# only a comment\n")).toEqual({ providers: {}, roles: {} });
    expect(parseFabricaConfig("providers:\n  api: { type: anthropic }\n")).toEqual({
      providers: { api: { type: "anthropic" } },
      roles: {},
    });
  });

  it("parses setup as an argv list, kept verbatim", () => {
    const config = parseFabricaConfig("setup: [pnpm, install, --frozen-lockfile, 'a b']\n");
    expect(config).toEqual<FabricaConfig>({
      providers: {},
      roles: {},
      setup: ["pnpm", "install", "--frozen-lockfile", "a b"],
    });
  });

  it("leaves setup out when it is absent or null", () => {
    expect(parseFabricaConfig("providers: {}\n")).not.toHaveProperty("setup");
    expect(parseFabricaConfig("setup:\n")).not.toHaveProperty("setup");
  });

  it.each([
    ["a plain-string setup", "setup: pnpm install\n"],
    ["an empty setup list", "setup: []\n"],
    ["a setup with a non-string entry", "setup: [pnpm, 1]\n"],
    ["a setup with an empty-string entry", "setup: [pnpm, '']\n"],
    ["a setup mapping", "setup: { command: pnpm }\n"],
  ])("rejects %s naming setup", (_, content) => {
    expect(() => parseFabricaConfig(content)).toThrow(/^setup/);
  });

  it.each([
    ["a role naming an undeclared provider", "roles:\n  builder: { provider: nope }\n", "roles.builder.provider"],
    ["an unknown provider type", "providers:\n  p: { type: openai }\n", "providers.p.type"],
    ["bedrock without region", "providers:\n  p: { type: bedrock }\n", "providers.p.region"],
    ["vertex without project", "providers:\n  p: { type: vertex, region: us-east5 }\n", "providers.p.project"],
    [
      "anthropic-compatible with a base_url that is not a URL",
      "providers:\n  p: { type: anthropic-compatible, base_url: not a url }\n",
      "providers.p.base_url",
    ],
    [
      "anthropic-compatible with a non-http base_url",
      "providers:\n  p: { type: anthropic-compatible, base_url: 'ftp://host' }\n",
      "providers.p.base_url",
    ],
    [
      "anthropic-compatible with an http: base_url on a non-loopback host",
      "providers:\n  p: { type: anthropic-compatible, base_url: 'http://litellm:4000' }\n",
      "providers.p.base_url",
    ],
    [
      "anthropic-compatible with user:pass@ in base_url",
      "providers:\n  p: { type: anthropic-compatible, base_url: 'https://user:pass@litellm:4000' }\n",
      "providers.p.base_url",
    ],
    [
      "anthropic-compatible with a user@ in base_url",
      "providers:\n  p: { type: anthropic-compatible, base_url: 'https://token@litellm:4000' }\n",
      "providers.p.base_url",
    ],
    ["an unknown top-level key", "providers: {}\nmodels: {}\n", "models"],
    [
      "an unknown key in a role",
      "providers:\n  p: { type: anthropic }\nroles:\n  builder: { provider: p, api_key: x }\n",
      "roles.builder.api_key",
    ],
    ["an unknown key in a provider", "providers:\n  p: { type: bedrock, region: r, profile: x }\n", "providers.p.profile"],
    ["a provider that is not a mapping", "providers:\n  p: bedrock\n", "providers.p"],
    ["a role that is not a mapping", "roles:\n  builder: [p]\n", "roles.builder"],
    ["a non-string required field", "providers:\n  p: { type: bedrock, region: 1 }\n", "providers.p.region"],
    ["an empty required field", "providers:\n  p: { type: bedrock, region: '' }\n", "providers.p.region"],
    [
      "an empty role model",
      "providers:\n  p: { type: anthropic }\nroles:\n  builder: { provider: p, model: '' }\n",
      "roles.builder.model",
    ],
    ["a provider named after an Object property", "roles:\n  builder: { provider: toString }\n", "roles.builder.provider"],
  ])("throws naming the path for %s", (_, content, path) => {
    expect(() => parseFabricaConfig(content)).toThrow(path);
  });

  it.each(["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000", "https://litellm:4000"])(
    "accepts the gateway base_url %s",
    (baseUrl) => {
      const config = parseFabricaConfig(`providers:\n  p: { type: anthropic-compatible, base_url: '${baseUrl}' }\n`);
      expect(config.providers.p).toEqual({ type: "anthropic-compatible", base_url: baseUrl });
    },
  );

  it.each(["http://user:s3cret@litellm:4000", "ftp://user:s3cret@host", "http://user:s3cret@localhost:4000"])(
    "rejects user:pass@ in %s without echoing the credentials",
    (baseUrl) => {
      const content = `providers:\n  p: { type: anthropic-compatible, base_url: '${baseUrl}' }\n`;
      expect(() => parseFabricaConfig(content)).toThrow("providers.p.base_url must not contain user:pass@");
      expect(() => parseFabricaConfig(content)).not.toThrow("s3cret");
    },
  );

  it("throws when the top level is not a mapping", () => {
    expect(() => parseFabricaConfig("- providers\n")).toThrow("top level");
  });

  it("throws on invalid YAML", () => {
    expect(() => parseFabricaConfig("providers: { a: [\n")).toThrow(/Invalid YAML/);
  });
});

describe("providerEnv", () => {
  it("maps each provider type to its environment variables", () => {
    expect(providerEnv({ type: "anthropic" })).toEqual({});
    expect(providerEnv({ type: "bedrock", region: "us-east-1" })).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
    });
    expect(providerEnv({ type: "vertex", project: "acme", region: "us-east5" })).toEqual({
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "acme",
      CLOUD_ML_REGION: "us-east5",
    });
    expect(providerEnv({ type: "anthropic-compatible", base_url: "https://litellm:4000" })).toEqual({
      ANTHROPIC_BASE_URL: "https://litellm:4000",
    });
  });

  it("lists the provider-selection variables to clear", () => {
    expect(PROVIDER_ENV_KEYS).toEqual([
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
      "CLAUDE_CODE_SKIP_VERTEX_AUTH",
      "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    ]);
  });
});
