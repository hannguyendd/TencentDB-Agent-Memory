/**
 * Config parameter registry — loads and validates metadata_config_params.json.
 *
 * Exports CONFIG_PARAM_REGISTRY for use by ConfigParamService / Router.
 * Hardcoding default parameter values in business code is forbidden; this registry is the single source of truth.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Type definitions ──

export type ConfigParamScope = "global" | "user";

export interface ParamDef {
  param_name: string;
  param_value: string;
  description: string;
  allowed_scopes: ConfigParamScope[];
}

export interface ModuleDef {
  module: string;
  description: string;
  params: ParamDef[];
}

export interface ConfigParamsFile {
  version: string;
  modules: ModuleDef[];
}

export type ConfigParamRegistry = Map<string, ModuleDef>;

// ── Validation regexes ──

const MODULE_RE = /^[a-z][a-z0-9_]*$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9_.]*$/;

// ── Loading and validation ──

export class ParamRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParamRegistryError";
  }
}

/**
 * Load and validate the config registry from a JSON file path.
 */
export function loadParamRegistry(filePath: string): ConfigParamRegistry {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err: any) {
    throw new ParamRegistryError(`Failed to read config params file: ${filePath} — ${err.message}`);
  }

  let parsed: ConfigParamsFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ParamRegistryError(`Invalid JSON in config params file: ${filePath}`);
  }

  return buildRegistry(parsed);
}

/**
 * Build the registry from an already-parsed object (usable in tests).
 */
export function buildRegistry(data: ConfigParamsFile): ConfigParamRegistry {
  if (!data.version || !Array.isArray(data.modules)) {
    throw new ParamRegistryError("Config params file must have 'version' and 'modules' array");
  }

  const registry: ConfigParamRegistry = new Map();
  const seenModules = new Set<string>();

  for (const mod of data.modules) {
    if (!mod.module || typeof mod.module !== "string") {
      throw new ParamRegistryError("Each module entry must have a 'module' string field");
    }
    if (!MODULE_RE.test(mod.module)) {
      throw new ParamRegistryError(
        `Invalid module name '${mod.module}': must match ${MODULE_RE}`,
      );
    }
    if (seenModules.has(mod.module)) {
      throw new ParamRegistryError(`Duplicate module '${mod.module}'`);
    }
    seenModules.add(mod.module);

    if (!mod.description) {
      throw new ParamRegistryError(`Module '${mod.module}' must have a description`);
    }
    if (!Array.isArray(mod.params) || mod.params.length === 0) {
      throw new ParamRegistryError(`Module '${mod.module}' must have at least one param`);
    }

    const seenParams = new Set<string>();
    for (const param of mod.params) {
      if (!param.param_name || typeof param.param_name !== "string") {
        throw new ParamRegistryError(
          `Module '${mod.module}': each param must have a 'param_name' string`,
        );
      }
      if (!PARAM_NAME_RE.test(param.param_name)) {
        throw new ParamRegistryError(
          `Module '${mod.module}': invalid param_name '${param.param_name}': must match ${PARAM_NAME_RE}`,
        );
      }
      if (seenParams.has(param.param_name)) {
        throw new ParamRegistryError(
          `Module '${mod.module}': duplicate param_name '${param.param_name}'`,
        );
      }
      seenParams.add(param.param_name);

      if (param.param_value === undefined || param.param_value === null) {
        throw new ParamRegistryError(
          `Module '${mod.module}', param '${param.param_name}': param_value is required`,
        );
      }
      if (!param.description) {
        throw new ParamRegistryError(
          `Module '${mod.module}', param '${param.param_name}': description is required`,
        );
      }
      if (
        !Array.isArray(param.allowed_scopes) ||
        param.allowed_scopes.length === 0
      ) {
        throw new ParamRegistryError(
          `Module '${mod.module}', param '${param.param_name}': allowed_scopes must be non-empty array`,
        );
      }
      for (const scope of param.allowed_scopes) {
        if (scope !== "global" && scope !== "user") {
          throw new ParamRegistryError(
            `Module '${mod.module}', param '${param.param_name}': invalid scope '${scope}'`,
          );
        }
      }
    }

    registry.set(mod.module, mod);
  }

  return registry;
}

// ── Query helpers ──

export function getModuleDef(
  registry: ConfigParamRegistry,
  module: string,
): ModuleDef | undefined {
  return registry.get(module);
}

export function getParamDef(
  registry: ConfigParamRegistry,
  module: string,
  paramName: string,
): ParamDef | undefined {
  const mod = registry.get(module);
  if (!mod) return undefined;
  return mod.params.find((p) => p.param_name === paramName);
}

export function isUserWritable(
  registry: ConfigParamRegistry,
  module: string,
  paramName: string,
): boolean {
  const param = getParamDef(registry, module, paramName);
  if (!param) return false;
  return param.allowed_scopes.includes("user");
}

export function isGlobalOnly(
  registry: ConfigParamRegistry,
  module: string,
  paramName: string,
): boolean {
  const param = getParamDef(registry, module, paramName);
  if (!param) return false;
  return (
    param.allowed_scopes.includes("global") &&
    !param.allowed_scopes.includes("user")
  );
}

export function isModuleGlobalOnly(
  registry: ConfigParamRegistry,
  module: string,
): boolean {
  const mod = registry.get(module);
  if (!mod) return false;
  return mod.params.every((p) => !p.allowed_scopes.includes("user"));
}

// ── Default loading (executed at module initialization) ──

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CONFIG_PATH = resolve(
  __dirname,
  "metadata_config_params.json",
);

/**
 * Load the registry from the default config file. A replacement path can be given via overridePath.
 */
export function loadDefaultRegistry(overridePath?: string): ConfigParamRegistry {
  const filePath = overridePath || DEFAULT_CONFIG_PATH;
  return loadParamRegistry(filePath);
}
