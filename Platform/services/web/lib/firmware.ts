import { fetchAuthSession } from "aws-amplify/auth";

export interface Firmware {
  firmwareId: string;
  version: string;
  status: string;
  originalFilename: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  uploadedAt?: string;
}

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}

export type PresignFirmwareRequest =
  | {
      version: string;
      originalFilename: string;
      sizeBytes: number;
      sha256: string;
      retryOfAttemptId?: never;
    }
  | {
      version: string;
      retryOfAttemptId: string;
      originalFilename?: never;
      sizeBytes?: never;
      sha256?: never;
    };

export interface PresignFirmwareResponse {
  deviceId: string;
  version: string;
  firmwareId: string;
  attemptId: string;
  status: "pending";
  upload: PresignedPost;
}

export interface CompleteFirmwareResponse {
  deviceId: string;
  version: string;
  firmwareId: string;
  status: string;
  uploadedAt?: string;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function getApiUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }
  return apiUrl;
}

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error("No Cognito ID token available");
  }
  return idToken;
}

async function throwApiError(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const errorBody = await response.json();
    if (typeof errorBody?.error === "string") {
      message = errorBody.error;
    }
  } catch {
    // response body wasn't JSON; keep the fallback message
  }
  throw new ApiError(message, response.status);
}

export async function presignFirmware(
  deviceId: string,
  request: PresignFirmwareRequest
): Promise<PresignFirmwareResponse> {
  const apiUrl = getApiUrl();
  const idToken = await getIdToken();

  const response = await fetch(
    `${apiUrl}/devices/${encodeURIComponent(deviceId)}/firmware/presign`,
    {
      method: "POST",
      headers: {
        Authorization: idToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    await throwApiError(
      response,
      `POST /devices/${deviceId}/firmware/presign failed with status ${response.status}`
    );
  }

  return response.json();
}

export async function uploadFirmwareToS3(
  upload: PresignedPost,
  file: File
): Promise<void> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) {
    formData.append(key, value);
  }
  // The file field must come last in the multipart body — S3 ignores any
  // field that appears after it.
  formData.append("file", file);

  // No Authorization header: S3 presigned POST auth is entirely embedded in
  // upload.fields (policy/signature/credential/security token), not a
  // bearer token. No Content-Type is set on this request either — the
  // browser must generate its own multipart/form-data boundary; the
  // "Content-Type": "application/octet-stream" value in upload.fields is a
  // separate S3 form field, not this HTTP request's header.
  const response = await fetch(upload.url, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    // S3 error responses are XML, not JSON, and may echo request details —
    // report only the status, never the response body.
    throw new Error(`S3 upload failed with status ${response.status}`);
  }
  // S3 returns 204 No Content on success — no JSON body to parse.
}

export async function completeFirmware(
  deviceId: string,
  version: string,
  attemptId: string
): Promise<CompleteFirmwareResponse> {
  const apiUrl = getApiUrl();
  const idToken = await getIdToken();

  const response = await fetch(
    `${apiUrl}/devices/${encodeURIComponent(deviceId)}/firmware/${encodeURIComponent(version)}/complete`,
    {
      method: "POST",
      headers: {
        Authorization: idToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ attemptId }),
    }
  );

  if (!response.ok) {
    await throwApiError(
      response,
      `POST /devices/${deviceId}/firmware/${version}/complete failed with status ${response.status}`
    );
  }

  return response.json();
}

export async function getFirmware(deviceId: string): Promise<Firmware[]> {
  const apiUrl = getApiUrl();
  const idToken = await getIdToken();

  const response = await fetch(
    `${apiUrl}/devices/${encodeURIComponent(deviceId)}/firmware`,
    {
      method: "GET",
      headers: {
        Authorization: idToken,
      },
    }
  );

  if (!response.ok) {
    await throwApiError(
      response,
      `GET /devices/${deviceId}/firmware failed with status ${response.status}`
    );
  }

  const data: { firmware: Firmware[] } = await response.json();
  return data.firmware;
}

export async function sha256Hex(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
