/**
 * The MVP tool catalog. Nineteen tools, no more. Each tool's risk tier (see
 * risk.ts) drives its annotations and whether it is gated. Every invocation is
 * audit-logged with the human initiator and, when gated, the approver.
 *
 * Containment walls enforced here:
 *  - One project per session: every project-scoped mutation calls requireBinding.
 *  - Staging only: env-scoped mutations always use the bound (staging) environment,
 *    so production is never mutated when a staging environment exists.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { riskFor } from './risk.js';
import { writeAudit } from './db.js';
import { redactArgs, maskVariableMap } from './redact.js';
import { getBinding, setBinding, requireBinding } from './session.js';
import { runGate, requestProdOnlyConfirm } from './gate.js';
import * as railway from './railway/api.js';
import { pool } from './db.js';

interface HandlerResult {
  content: Array<{ type: 'text'; text: string }>;
  audit?: {
    projectId?: string | null;
    projectName?: string | null;
    environment?: string | null;
    approval?: { approver: string; approvedAt: string } | null;
    outcome?: string;
  };
}

function text(s: string): HandlerResult {
  return { content: [{ type: 'text', text: s }] };
}

const STAGING = 'staging';
const PRODUCTION = 'production';

/**
 * Register every tool on a per-request McpServer, closing over the authenticated
 * human identity so the audit trail always knows who initiated the action.
 */
export function registerTools(server: McpServer, identity: string): void {
  const define = (
    name: string,
    cfg: { title: string; description: string; inputSchema: z.ZodRawShape },
    handler: (args: Record<string, unknown>) => Promise<HandlerResult>,
  ): void => {
    const risk = riskFor(name);
    server.registerTool(
      name,
      {
        title: cfg.title,
        description: cfg.description,
        inputSchema: cfg.inputSchema,
        annotations: risk.annotations,
      },
      // The SDK validates args against inputSchema before calling us.
      async (args: Record<string, unknown>) => {
        const redacted = redactArgs(name, args ?? {});
        try {
          const result = await handler(args ?? {});
          await writeAudit({
            initiator: identity,
            tool: name,
            args: redacted,
            tier: risk.tier,
            projectId: result.audit?.projectId ?? null,
            projectName: result.audit?.projectName ?? null,
            environment: result.audit?.environment ?? null,
            approval: result.audit?.approval ?? null,
            outcome: result.audit?.outcome ?? 'success',
          });
          return { content: result.content, isError: false };
        } catch (err) {
          const message = (err as Error).message;
          await writeAudit({
            initiator: identity,
            tool: name,
            args: redacted,
            tier: risk.tier,
            outcome: `error: ${message}`,
          });
          return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
        }
      },
    );
  };

  // ---- Session and account -------------------------------------------------

  define(
    'railway_whoami',
    {
      title: 'Who am I',
      description: 'Report the connected human identity and the reachable Railway workspace.',
      inputSchema: {},
    },
    async () => {
      const me = await railway.getMe();
      const projects = await railway.listProjects();
      const lines = [
        `Gateway identity: ${identity}`,
        me ? `Railway account: ${me.name ?? me.id}` : 'Railway token: workspace/service token (not personal scoped)',
        `Reachable projects: ${projects.length}`,
      ];
      return text(lines.join('\n'));
    },
  );

  define(
    'railway_check_status',
    {
      title: 'Check status',
      description: 'Report server, database, and Railway token health.',
      inputSchema: {},
    },
    async () => {
      let dbOk = false;
      let railwayOk = false;
      try {
        await pool.query('SELECT 1');
        dbOk = true;
      } catch {
        dbOk = false;
      }
      try {
        await railway.listProjects();
        railwayOk = true;
      } catch {
        railwayOk = false;
      }
      const binding = await getBinding(identity);
      return text(
        [
          `Database: ${dbOk ? 'ok' : 'unreachable'}`,
          `Railway token: ${railwayOk ? 'ok' : 'unreachable or invalid'}`,
          binding
            ? `Bound project: ${binding.projectName} (env ${binding.environmentName})`
            : 'Bound project: none (call railway_select_project)',
        ].join('\n'),
      );
    },
  );

  define(
    'railway_select_project',
    {
      title: 'Select project',
      description:
        'Bind this session to one project and run staging enforcement. If staging exists the session binds to staging and production becomes unreachable. If only production exists an approver is asked to confirm. Provide a project id or an exact project name.',
      inputSchema: {
        projectId: z.string().optional().describe('The Railway project id to bind.'),
        projectName: z.string().optional().describe('Exact project name, used if no id is given.'),
      },
    },
    async (args) => {
      const projectId = args.projectId as string | undefined;
      const projectName = args.projectName as string | undefined;
      if (!projectId && !projectName) {
        throw new Error('Provide either projectId or projectName.');
      }

      let resolvedId = projectId;
      if (!resolvedId) {
        const all = await railway.listProjects();
        const match = all.find((p) => p.name === projectName);
        if (!match) throw new Error(`No project found with name "${projectName}".`);
        resolvedId = match.id;
      }

      const project = await railway.getProject(resolvedId);
      const staging = project.environments.find((e) => e.name.toLowerCase() === STAGING);
      const production = project.environments.find((e) => e.name.toLowerCase() === PRODUCTION);

      // Both or staging-only: bind to staging. Production is unreachable this session.
      if (staging) {
        await setBinding({
          identity,
          projectId: project.id,
          projectName: project.name,
          environmentId: staging.id,
          environmentName: staging.name,
        });
        return {
          content: [
            {
              type: 'text',
              text:
                `Bound to project ${project.name}, staging environment "${staging.name}". ` +
                (production ? 'Production exists and is unreachable for this session.' : 'No production environment present.'),
            },
          ],
          audit: { projectId: project.id, projectName: project.name, environment: staging.name },
        };
      }

      // Production-only: pause and ask an approver to confirm treating prod as staging.
      if (production) {
        const decision = await requestProdOnlyConfirm({
          initiator: identity,
          projectId: project.id,
          projectName: project.name,
          environmentName: production.name,
        });
        if (!decision.approved) {
          return {
            content: [
              {
                type: 'text',
                text: `Bind refused. Treating ${project.name} production as staging was ${decision.status}.`,
              },
            ],
            audit: {
              projectId: project.id,
              projectName: project.name,
              environment: production.name,
              outcome: `bind_refused: ${decision.status}`,
            },
          };
        }
        await setBinding({
          identity,
          projectId: project.id,
          projectName: project.name,
          environmentId: production.id,
          environmentName: production.name,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Approved by ${decision.approver}. Bound to ${project.name}, treating "${production.name}" as staging for this session.`,
            },
          ],
          audit: {
            projectId: project.id,
            projectName: project.name,
            environment: production.name,
            approval: decision.approver ? { approver: decision.approver, approvedAt: new Date().toISOString() } : null,
          },
        };
      }

      throw new Error(
        `Project ${project.name} has neither a staging nor a production environment. Create a "staging" environment first.`,
      );
    },
  );

  // ---- Read (auto, logged) -------------------------------------------------

  define(
    'railway_list_projects',
    {
      title: 'List projects',
      description: 'List all projects reachable by the workspace token.',
      inputSchema: {},
    },
    async () => {
      const projects = await railway.listProjects();
      if (projects.length === 0) return text('No projects found.');
      return text(projects.map((p) => `${p.name} (${p.id})`).join('\n'));
    },
  );

  define(
    'railway_list_services',
    {
      title: 'List services',
      description: 'List services in the bound project.',
      inputSchema: {},
    },
    async () => {
      const binding = await requireBinding(identity);
      const services = await railway.listServices(binding.projectId);
      const body = services.length === 0 ? 'No services.' : services.map((s) => `${s.name} (${s.id})`).join('\n');
      return {
        content: [{ type: 'text', text: body }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_list_environments',
    {
      title: 'List environments',
      description: 'List environments in the bound project, marking the one bound to this session.',
      inputSchema: {},
    },
    async () => {
      const binding = await requireBinding(identity);
      const envs = await railway.listEnvironments(binding.projectId);
      const body = envs
        .map((e) => `${e.name} (${e.id})${e.id === binding.environmentId ? '  [bound]' : ''}`)
        .join('\n');
      return {
        content: [{ type: 'text', text: body }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_get_logs',
    {
      title: 'Get logs',
      description: 'Fetch recent deployment logs for a service in the bound (staging) environment.',
      inputSchema: {
        serviceId: z.string().describe('The service id to read logs for.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max log lines (default 100).'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const serviceId = args.serviceId as string;
      const limit = (args.limit as number | undefined) ?? 100;
      const deployment = await railway.getLatestDeployment(serviceId, binding.environmentId);
      if (!deployment) {
        return {
          content: [{ type: 'text', text: 'No deployment found for that service in the bound environment.' }],
          audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
        };
      }
      const logs = await railway.getDeploymentLogs(deployment.id, limit);
      const body =
        logs.length === 0
          ? `Deployment ${deployment.id} (${deployment.status}) has no log lines.`
          : logs.map((l) => `${l.timestamp ?? ''} ${l.severity ?? ''} ${l.message}`.trim()).join('\n');
      return {
        content: [{ type: 'text', text: body }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_list_variables',
    {
      title: 'List variables',
      description:
        'List variable keys with masked values for the bound project and environment. Secret values are never returned.',
      inputSchema: {
        serviceId: z.string().optional().describe('Limit to a service. Omit for shared environment variables.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const serviceId = args.serviceId as string | undefined;
      const vars = await railway.getVariables(binding.projectId, binding.environmentId, serviceId);
      const masked = maskVariableMap(vars);
      const body = masked.length === 0 ? 'No variables.' : masked.join('\n');
      return {
        content: [{ type: 'text', text: body }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  // ---- Reversible mutate (auto, logged) ------------------------------------

  define(
    'railway_redeploy',
    {
      title: 'Redeploy',
      description: 'Redeploy a service in the bound (staging) environment using its existing build.',
      inputSchema: { serviceId: z.string().describe('The service id to redeploy.') },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const serviceId = args.serviceId as string;
      await railway.redeploy(serviceId, binding.environmentId);
      return {
        content: [{ type: 'text', text: `Redeploy triggered for service ${serviceId} in ${binding.environmentName}.` }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_set_variables',
    {
      title: 'Set variables',
      description:
        'Set one or more variables on the bound project and environment. The values are never logged; only the keys are recorded.',
      inputSchema: {
        variables: z.record(z.string(), z.string()).describe('Map of variable name to value.'),
        serviceId: z.string().optional().describe('Target a service. Omit for shared environment variables.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const variables = args.variables as Record<string, string>;
      const serviceId = args.serviceId as string | undefined;
      const keys = Object.keys(variables);
      if (keys.length === 0) throw new Error('Provide at least one variable.');
      await railway.upsertVariables(binding.projectId, binding.environmentId, serviceId, variables);
      return {
        content: [
          {
            type: 'text',
            text: `Set ${keys.length} variable(s) [${keys.join(', ')}] on ${
              serviceId ? `service ${serviceId}` : 'shared env'
            } in ${binding.environmentName}.`,
          },
        ],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_generate_domain',
    {
      title: 'Generate domain',
      description: 'Generate a Railway service domain for a service in the bound (staging) environment.',
      inputSchema: {
        serviceId: z.string().describe('The service id to expose.'),
        targetPort: z.number().int().optional().describe('Container port to route to.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const serviceId = args.serviceId as string;
      const targetPort = args.targetPort as number | undefined;
      const domain = await railway.generateDomain(serviceId, binding.environmentId, targetPort);
      return {
        content: [{ type: 'text', text: `Domain generated: ${domain.domain}` }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  define(
    'railway_create_environment',
    {
      title: 'Create environment',
      description: 'Create a new environment in the bound project.',
      inputSchema: { name: z.string().describe('Name for the new environment.') },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const name = args.name as string;
      const env = await railway.createEnvironment(binding.projectId, name);
      return {
        content: [{ type: 'text', text: `Created environment ${env.name} (${env.id}).` }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  // ---- Create (auto, logged) -----------------------------------------------

  define(
    'railway_create_project',
    {
      title: 'Create project',
      description:
        'Create a new Railway project in the workspace. This is the one mutating tool that does not require a bound project, because it creates one. It does not touch any existing project.',
      inputSchema: {
        name: z.string().describe('Name for the new project.'),
        workspaceId: z.string().optional().describe('Workspace to create in, if the token spans more than one.'),
      },
    },
    async (args) => {
      const name = args.name as string;
      const workspaceId = args.workspaceId as string | undefined;
      const project = await railway.createProject(name, workspaceId);
      return {
        content: [
          {
            type: 'text',
            text: `Created project ${project.name} (${project.id}). Call railway_select_project to bind it before mutating it.`,
          },
        ],
        audit: { projectId: project.id, projectName: project.name },
      };
    },
  );

  define(
    'railway_create_service',
    {
      title: 'Create service',
      description: 'Create a new service in the bound project, optionally from a GitHub repo or a Docker image.',
      inputSchema: {
        name: z.string().describe('Name for the new service.'),
        repo: z.string().optional().describe('GitHub repo as owner/name to deploy from.'),
        image: z.string().optional().describe('Docker image to deploy from.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const name = args.name as string;
      const repo = args.repo as string | undefined;
      const image = args.image as string | undefined;
      const service = await railway.createService(binding.projectId, name, { repo, image });
      return {
        content: [{ type: 'text', text: `Created service ${service.name} (${service.id}).` }],
        audit: { projectId: binding.projectId, projectName: binding.projectName, environment: binding.environmentName },
      };
    },
  );

  // ---- Irreversible (gated: Slack approval + config snapshot first) --------

  /** Shared post-gate auditing for a destructive tool. */
  const gatedAudit = (
    binding: { projectId: string; projectName: string; environmentName: string },
    outcomeWord: string,
    approver: string | null,
  ): HandlerResult['audit'] => ({
    projectId: binding.projectId,
    projectName: binding.projectName,
    environment: binding.environmentName,
    outcome: outcomeWord,
    approval: approver ? { approver, approvedAt: new Date().toISOString() } : null,
  });

  define(
    'railway_delete_service',
    {
      title: 'Delete service',
      description: 'Delete a service in the bound project. Gated: requires Slack approval and writes a snapshot first.',
      inputSchema: { serviceId: z.string().describe('The service id to delete.') },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const serviceId = args.serviceId as string;
      const outcome = await runGate({
        tool: 'railway_delete_service',
        initiator: identity,
        binding,
        action: `Delete service ${serviceId}`,
        targetType: 'service',
        targetId: serviceId,
        serviceIdForVars: serviceId,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: 'text', text: `Aborted. Approval was ${outcome.status}.` }],
          audit: gatedAudit(binding, `aborted: ${outcome.status}`, outcome.approver),
        };
      }
      await railway.deleteService(serviceId);
      return {
        content: [{ type: 'text', text: `Service ${serviceId} deleted. Approved by ${outcome.approver}.` }],
        audit: gatedAudit(binding, 'success', outcome.approver),
      };
    },
  );

  define(
    'railway_delete_project',
    {
      title: 'Delete project',
      description: 'Delete the bound project entirely. Gated: requires Slack approval and writes a snapshot first.',
      inputSchema: {
        confirmProjectId: z.string().describe('Must equal the bound project id, as a safety confirmation.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const confirmProjectId = args.confirmProjectId as string;
      if (confirmProjectId !== binding.projectId) {
        throw new Error('confirmProjectId does not match the bound project id. Refusing to delete.');
      }
      const outcome = await runGate({
        tool: 'railway_delete_project',
        initiator: identity,
        binding,
        action: `Delete project ${binding.projectName}`,
        targetType: 'project',
        targetId: binding.projectId,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: 'text', text: `Aborted. Approval was ${outcome.status}.` }],
          audit: gatedAudit(binding, `aborted: ${outcome.status}`, outcome.approver),
        };
      }
      await railway.deleteProject(binding.projectId);
      // The bound project no longer exists; clear the session binding.
      await pool.query('DELETE FROM sessions WHERE identity = $1', [identity]);
      return {
        content: [{ type: 'text', text: `Project ${binding.projectName} deleted. Approved by ${outcome.approver}.` }],
        audit: gatedAudit(binding, 'success', outcome.approver),
      };
    },
  );

  define(
    'railway_delete_environment',
    {
      title: 'Delete environment',
      description:
        'Delete an environment in the bound project. Production is protected and cannot be deleted when a staging environment exists. Gated: Slack approval and snapshot first.',
      inputSchema: { environmentId: z.string().describe('The environment id to delete.') },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const environmentId = args.environmentId as string;
      const envs = await railway.listEnvironments(binding.projectId);
      const target = envs.find((e) => e.id === environmentId);
      if (!target) throw new Error('That environment is not part of the bound project.');
      const hasStaging = envs.some((e) => e.name.toLowerCase() === STAGING);
      if (target.name.toLowerCase() === PRODUCTION && hasStaging) {
        throw new Error('Refusing to delete the production environment while a staging environment exists.');
      }
      const outcome = await runGate({
        tool: 'railway_delete_environment',
        initiator: identity,
        binding,
        action: `Delete environment ${target.name}`,
        targetType: 'environment',
        targetId: environmentId,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: 'text', text: `Aborted. Approval was ${outcome.status}.` }],
          audit: gatedAudit(binding, `aborted: ${outcome.status}`, outcome.approver),
        };
      }
      await railway.deleteEnvironment(environmentId);
      return {
        content: [{ type: 'text', text: `Environment ${target.name} deleted. Approved by ${outcome.approver}.` }],
        audit: gatedAudit(binding, 'success', outcome.approver),
      };
    },
  );

  define(
    'railway_wipe_volume',
    {
      title: 'Wipe volume',
      description:
        'Wipe a volume by deleting it and all its data. Railway has no in-place wipe, so this removes the volume. Gated: Slack approval, snapshot first, and volume backup when the project flag is on.',
      inputSchema: { volumeId: z.string().describe('The volume id to wipe.') },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const volumeId = args.volumeId as string;
      const project = await railway.getProject(binding.projectId);
      if (!project.volumes.some((v) => v.id === volumeId)) {
        throw new Error('That volume is not part of the bound project.');
      }
      const outcome = await runGate({
        tool: 'railway_wipe_volume',
        initiator: identity,
        binding,
        action: `Wipe (delete) volume ${volumeId}`,
        targetType: 'volume',
        targetId: volumeId,
        volumeId,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: 'text', text: `Aborted. Approval was ${outcome.status}.` }],
          audit: gatedAudit(binding, `aborted: ${outcome.status}`, outcome.approver),
        };
      }
      await railway.deleteVolume(volumeId);
      return {
        content: [{ type: 'text', text: `Volume ${volumeId} wiped. Approved by ${outcome.approver}.` }],
        audit: gatedAudit(binding, 'success', outcome.approver),
      };
    },
  );

  define(
    'railway_delete_variables',
    {
      title: 'Delete variables',
      description:
        'Delete one or more variables from the bound project and environment. Gated: Slack approval and snapshot first.',
      inputSchema: {
        names: z.array(z.string()).min(1).describe('Variable names to delete.'),
        serviceId: z.string().optional().describe('Target a service. Omit for shared environment variables.'),
      },
    },
    async (args) => {
      const binding = await requireBinding(identity);
      const names = args.names as string[];
      const serviceId = args.serviceId as string | undefined;
      const outcome = await runGate({
        tool: 'railway_delete_variables',
        initiator: identity,
        binding,
        action: `Delete ${names.length} variable(s) [${names.join(', ')}]`,
        targetType: 'variables',
        targetId: serviceId ?? 'shared',
        serviceIdForVars: serviceId,
      });
      if (!outcome.approved) {
        return {
          content: [{ type: 'text', text: `Aborted. Approval was ${outcome.status}.` }],
          audit: gatedAudit(binding, `aborted: ${outcome.status}`, outcome.approver),
        };
      }
      for (const name of names) {
        await railway.deleteVariable(binding.projectId, binding.environmentId, serviceId, name);
      }
      return {
        content: [{ type: 'text', text: `Deleted ${names.length} variable(s). Approved by ${outcome.approver}.` }],
        audit: gatedAudit(binding, 'success', outcome.approver),
      };
    },
  );
}
