import { fetchAuthSession } from "aws-amplify/auth";

export class ApiError extends Error {
  readonly status: number;
  /** The parsed JSON error body, when there was one (e.g. a 409's cveRecordId). */
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export function getApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }
  return apiUrl;
}

export async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error("No Cognito ID token available");
  }
  return idToken;
}

export async function throwApiError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  let details: Record<string, unknown> = {};
  try {
    const errorBody = await response.json();
    if (errorBody && typeof errorBody === "object" && !Array.isArray(errorBody)) details = errorBody;
    if (typeof errorBody?.error === "string") {
      message = errorBody.error;
    } else if (typeof errorBody?.message === "string") {
      // API Gateway's own errors (401/403/5xx) use "message".
      message = errorBody.message;
    }
  } catch {
    // response body wasn't JSON; keep the fallback message
  }
  throw new ApiError(message, response.status, details);
}

/**
 * Authenticated JSON request to the platform API. `path` starts with "/",
 * and `query` values that are undefined or empty are left out.
 */
export async function apiRequest<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: { body?: unknown; query?: Record<string, string | number | undefined> } = {}
): Promise<T> {
  const apiUrl = getApiUrl();
  const idToken = await getIdToken();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const queryString = params.toString();

  const headers: Record<string, string> = { Authorization: idToken };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${apiUrl}${path}${queryString ? `?${queryString}` : ""}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    await throwApiError(response, `${method} ${path} failed with status ${response.status}`);
  }

  return response.json();
}
