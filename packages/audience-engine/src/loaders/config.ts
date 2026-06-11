/**
 * YAML config loader.
 *
 * Reads an InstanceConfig from a YAML file. The YAML is the *machine-
 * readable* form of the engine instantiation worksheet
 * (docs/playbooks/templates/template--instantiation-worksheet.md).
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { InstanceConfig } from "../types/index.js";

/** Load and validate an InstanceConfig from a YAML file. */
export async function loadConfig(configPath: string): Promise<InstanceConfig> {
  const content = await readFile(configPath, "utf-8");
  const raw = parseYaml(content);

  // Validate the top-level shape.
  validateConfig(raw);
  return raw as InstanceConfig;
}

/** Validation: ensure all 5 parameters are present. */
function validateConfig(raw: unknown): asserts raw is InstanceConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Config root must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.systemName !== "string" || obj.systemName.length === 0) {
    throw new Error("Config.systemName is required");
  }
  if (typeof obj.parameters !== "object" || obj.parameters === null) {
    throw new Error("Config.parameters is required (the 5 engine parameters)");
  }
  const p = obj.parameters as Record<string, unknown>;
  for (const key of ["p1Host", "p2Wedge", "p3Product", "p4OwnedAsset", "p5ProofLoop"]) {
    if (typeof p[key] !== "object" || p[key] === null) {
      throw new Error(`Config.parameters.${key} is required`);
    }
  }
  if (typeof obj.channels !== "object" || obj.channels === null) {
    throw new Error("Config.channels is required (host + product)");
  }
  const c = obj.channels as Record<string, unknown>;
  if (typeof c.host !== "object" || c.host === null) {
    throw new Error("Config.channels.host is required");
  }
  if (typeof c.product !== "object" || c.product === null) {
    throw new Error("Config.channels.product is required");
  }
  if (typeof obj.ladder !== "object" || obj.ladder === null) {
    throw new Error("Config.ladder is required");
  }
  if (typeof obj.attack !== "object" || obj.attack === null) {
    throw new Error("Config.attack is required (5-level attack)");
  }
  if (typeof obj.kpis !== "object" || obj.kpis === null) {
    throw new Error("Config.kpis is required");
  }
  if (!Array.isArray(obj.kpis)) {
    throw new Error("Config.kpis must be an array");
  }
}
