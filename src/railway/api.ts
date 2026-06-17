/**
 * Typed Railway operations. Each function is one GraphQL query or mutation,
 * shaped per the current Railway Public API (verified June 2026).
 *
 * Notes baked in from the schema:
 *  - `variables` returns a flat JSON key/value map (a scalar), not Relay edges.
 *  - Many mutations return a bare scalar, so we do not request subfields on them.
 *  - Volume mutations use `volumeId`; most others use `id`.
 */
import { railwayGraphQL } from './client.js';

export interface Edge<T> {
  edges: Array<{ node: T }>;
}

export interface ProjectNode {
  id: string;
  name: string;
  description?: string | null;
}

export interface EnvironmentNode {
  id: string;
  name: string;
}

export interface ServiceNode {
  id: string;
  name: string;
}

export interface VolumeNode {
  id: string;
  name: string;
}

export interface DeploymentNode {
  id: string;
  status: string;
  createdAt: string;
}

export interface LogLine {
  timestamp?: string;
  message: string;
  severity?: string;
}

/** whoami: account tokens support `me`; workspace tokens may not, so the caller handles failure. */
export async function getMe(): Promise<{ id: string; name?: string | null; email?: string | null } | null> {
  try {
    const data = await railwayGraphQL<{ me: { id: string; name?: string; email?: string } }>(
      `query { me { id name email } }`,
    );
    return data.me;
  } catch {
    // Workspace/service tokens are not personal-scoped; this is expected.
    return null;
  }
}

export async function listProjects(): Promise<ProjectNode[]> {
  const data = await railwayGraphQL<{ projects: Edge<ProjectNode> }>(
    `query { projects { edges { node { id name description } } } }`,
  );
  return data.projects.edges.map((e) => e.node);
}

export interface ProjectDetail {
  id: string;
  name: string;
  environments: EnvironmentNode[];
  services: ServiceNode[];
  volumes: VolumeNode[];
}

export async function getProject(id: string): Promise<ProjectDetail> {
  const data = await railwayGraphQL<{
    project: {
      id: string;
      name: string;
      environments: Edge<EnvironmentNode>;
      services: Edge<ServiceNode>;
      volumes: Edge<VolumeNode>;
    };
  }>(
    `query project($id: String!) {
       project(id: $id) {
         id name
         environments { edges { node { id name } } }
         services { edges { node { id name } } }
         volumes { edges { node { id name } } }
       }
     }`,
    { id },
  );
  const p = data.project;
  return {
    id: p.id,
    name: p.name,
    environments: p.environments.edges.map((e) => e.node),
    services: p.services.edges.map((e) => e.node),
    volumes: p.volumes.edges.map((e) => e.node),
  };
}

export async function listEnvironments(projectId: string): Promise<EnvironmentNode[]> {
  const detail = await getProject(projectId);
  return detail.environments;
}

export async function listServices(projectId: string): Promise<ServiceNode[]> {
  const detail = await getProject(projectId);
  return detail.services;
}

/** The latest deployment for a service in an environment, used to fetch logs and to redeploy. */
export async function getLatestDeployment(
  serviceId: string,
  environmentId: string,
): Promise<DeploymentNode | null> {
  const data = await railwayGraphQL<{
    serviceInstance: { latestDeployment: DeploymentNode | null } | null;
  }>(
    `query serviceInstance($serviceId: String!, $environmentId: String!) {
       serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
         latestDeployment { id status createdAt }
       }
     }`,
    { serviceId, environmentId },
  );
  return data.serviceInstance?.latestDeployment ?? null;
}

export async function getDeploymentLogs(deploymentId: string, limit = 100): Promise<LogLine[]> {
  const data = await railwayGraphQL<{ deploymentLogs: LogLine[] }>(
    `query logs($deploymentId: String!, $limit: Int) {
       deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
     }`,
    { deploymentId, limit },
  );
  return data.deploymentLogs ?? [];
}

/** Returns a flat key/value map. `unrendered:true` keeps references unresolved. */
export async function getVariables(
  projectId: string,
  environmentId: string,
  serviceId?: string,
): Promise<Record<string, string>> {
  const data = await railwayGraphQL<{ variables: Record<string, string> }>(
    `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
     }`,
    { projectId, environmentId, serviceId: serviceId ?? null },
  );
  return data.variables ?? {};
}

// ---- Reversible mutations --------------------------------------------------

export async function redeploy(serviceId: string, environmentId: string): Promise<void> {
  await railwayGraphQL(
    `mutation redeploy($serviceId: String!, $environmentId: String!) {
       serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
     }`,
    { serviceId, environmentId },
  );
}

export async function upsertVariables(
  projectId: string,
  environmentId: string,
  serviceId: string | undefined,
  variables: Record<string, string>,
  skipDeploys = false,
): Promise<void> {
  await railwayGraphQL(
    `mutation setVars($input: VariableCollectionUpsertInput!) {
       variableCollectionUpsert(input: $input)
     }`,
    { input: { projectId, environmentId, serviceId: serviceId ?? null, variables, skipDeploys } },
  );
}

export async function generateDomain(
  serviceId: string,
  environmentId: string,
  targetPort?: number,
): Promise<{ id: string; domain: string }> {
  const data = await railwayGraphQL<{ serviceDomainCreate: { id: string; domain: string } }>(
    `mutation makeDomain($input: ServiceDomainCreateInput!) {
       serviceDomainCreate(input: $input) { id domain }
     }`,
    { input: { serviceId, environmentId, targetPort: targetPort ?? null } },
  );
  return data.serviceDomainCreate;
}

export async function createEnvironment(projectId: string, name: string): Promise<{ id: string; name: string }> {
  const data = await railwayGraphQL<{ environmentCreate: { id: string; name: string } }>(
    `mutation makeEnv($input: EnvironmentCreateInput!) {
       environmentCreate(input: $input) { id name }
     }`,
    { input: { projectId, name } },
  );
  return data.environmentCreate;
}

// ---- Create mutations ------------------------------------------------------

export async function createProject(name: string, workspaceId?: string): Promise<{ id: string; name: string }> {
  const data = await railwayGraphQL<{ projectCreate: { id: string; name: string } }>(
    `mutation makeProject($input: ProjectCreateInput!) {
       projectCreate(input: $input) { id name }
     }`,
    { input: { name, workspaceId: workspaceId ?? null } },
  );
  return data.projectCreate;
}

export async function createService(
  projectId: string,
  name: string,
  source?: { repo?: string; image?: string },
): Promise<{ id: string; name: string }> {
  const input: Record<string, unknown> = { projectId, name };
  if (source && (source.repo || source.image)) {
    input.source = source.repo ? { repo: source.repo } : { image: source.image };
  }
  const data = await railwayGraphQL<{ serviceCreate: { id: string; name: string } }>(
    `mutation makeService($input: ServiceCreateInput!) {
       serviceCreate(input: $input) { id name }
     }`,
    { input },
  );
  return data.serviceCreate;
}

/** Create a persistent volume for a service (used when provisioning a database). */
export async function createVolume(
  projectId: string,
  serviceId: string,
  environmentId: string,
  mountPath: string,
): Promise<{ id: string }> {
  const data = await railwayGraphQL<{ volumeCreate: { id: string } }>(
    `mutation makeVolume($input: VolumeCreateInput!) {
       volumeCreate(input: $input) { id }
     }`,
    { input: { projectId, serviceId, environmentId, mountPath } },
  );
  return data.volumeCreate;
}

export interface ServiceInstanceUpdateInput {
  startCommand?: string;
  healthcheckTimeout?: number;
  region?: string;
  numReplicas?: number;
  restartPolicyType?: 'ON_FAILURE' | 'ALWAYS' | 'NEVER';
  sleepApplication?: boolean;
}

/** Update a service's per-environment config. Returns nothing useful (Boolean scalar). */
export async function updateServiceInstance(
  serviceId: string,
  environmentId: string,
  input: ServiceInstanceUpdateInput,
): Promise<void> {
  await railwayGraphQL(
    `mutation editInstance($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
       serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
     }`,
    { serviceId, environmentId, input },
  );
}

// ---- Irreversible mutations (only ever called after a passed gate) ---------

export async function deleteService(id: string): Promise<void> {
  await railwayGraphQL(`mutation del($id: String!) { serviceDelete(id: $id) }`, { id });
}

export async function deleteProject(id: string): Promise<void> {
  await railwayGraphQL(`mutation del($id: String!) { projectDelete(id: $id) }`, { id });
}

export async function deleteEnvironment(id: string): Promise<void> {
  await railwayGraphQL(`mutation del($id: String!) { environmentDelete(id: $id) }`, { id });
}

/**
 * Railway has no in-place volume "wipe" mutation, so wiping data means deleting
 * the volume (and all its data). This is destructive and gated like the deletes.
 */
export async function deleteVolume(volumeId: string): Promise<void> {
  await railwayGraphQL(`mutation del($volumeId: String!) { volumeDelete(volumeId: $volumeId) }`, { volumeId });
}

export async function deleteVariable(
  projectId: string,
  environmentId: string,
  serviceId: string | undefined,
  name: string,
): Promise<void> {
  await railwayGraphQL(
    `mutation delVar($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
    { input: { projectId, environmentId, serviceId: serviceId ?? null, name } },
  );
}
