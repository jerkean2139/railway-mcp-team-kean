/**
 * Risk tiers. Borrowed from the ShipSafe model: classify every operation by how
 * dangerous it is up front, then drive all gate behavior off that classification.
 * Confidence never substitutes for a human decision on irreversible actions.
 *
 * The gate rule is simple: any tool annotated `destructiveHint: true` is gated.
 * Everything else runs autonomously.
 */

export type Tier = 'read' | 'reversible' | 'create' | 'irreversible';

export interface ToolRisk {
  tier: Tier;
  /** MCP tool annotations derived from the tier. */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const READ: ToolRisk = {
  tier: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

const REVERSIBLE: ToolRisk = {
  tier: 'reversible',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const CREATE: ToolRisk = {
  tier: 'create',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const IRREVERSIBLE: ToolRisk = {
  tier: 'irreversible',
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

/** The single source of truth mapping every MVP tool to its tier. */
export const TOOL_RISK: Record<string, ToolRisk> = {
  // Session and account
  railway_whoami: READ,
  railway_check_status: READ,
  railway_select_project: READ, // selection itself is read-only; it only binds the session

  // Read (auto, silent)
  railway_list_projects: READ,
  railway_list_services: READ,
  railway_list_environments: READ,
  railway_get_logs: READ,
  railway_list_variables: READ,

  // Reversible mutate (auto, logged)
  railway_redeploy: REVERSIBLE,
  railway_set_variables: REVERSIBLE,
  railway_generate_domain: REVERSIBLE,
  railway_create_environment: REVERSIBLE,
  railway_edit_redis: REVERSIBLE,

  // Create (auto, logged)
  railway_create_project: CREATE,
  railway_create_service: CREATE,
  railway_add_redis: CREATE,

  // Irreversible (hard gate: Slack approval + config snapshot)
  railway_delete_service: IRREVERSIBLE,
  railway_delete_project: IRREVERSIBLE,
  railway_delete_environment: IRREVERSIBLE,
  railway_wipe_volume: IRREVERSIBLE,
  railway_delete_variables: IRREVERSIBLE,
};

export function riskFor(toolName: string): ToolRisk {
  const risk = TOOL_RISK[toolName];
  if (!risk) {
    throw new Error(`No risk tier registered for tool: ${toolName}`);
  }
  return risk;
}

/** A tool is gated if and only if it is annotated destructive. */
export function isGated(toolName: string): boolean {
  return riskFor(toolName).annotations.destructiveHint === true;
}
