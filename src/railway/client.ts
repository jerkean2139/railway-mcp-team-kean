/**
 * Minimal Railway Public GraphQL client.
 *
 * Authenticates with one Railway Team/Workspace token via `Authorization: Bearer`
 * (verified against docs.railway.com: workspace and account tokens use Bearer;
 * only project tokens use the Project-Access-Token header, which we do not use).
 */
import { config } from '../config.js';

export class RailwayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailwayError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function railwayGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(config.railway.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.railway.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new RailwayError(`Could not reach the Railway API: ${(err as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new RailwayError('Railway rejected the token (401/403). Check RAILWAY_TOKEN is a valid workspace token.');
  }
  if (res.status === 429) {
    throw new RailwayError('Railway rate limit hit (429). Try again shortly.');
  }

  let body: GraphQLResponse<T>;
  try {
    body = (await res.json()) as GraphQLResponse<T>;
  } catch {
    throw new RailwayError(`Railway returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (body.errors && body.errors.length > 0) {
    const messages = body.errors.map((e) => e.message).join('; ');
    throw new RailwayError(`Railway API error: ${messages}`);
  }
  if (body.data === undefined) {
    throw new RailwayError('Railway API returned no data.');
  }
  return body.data;
}
