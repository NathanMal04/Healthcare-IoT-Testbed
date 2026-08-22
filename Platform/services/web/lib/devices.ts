import { fetchAuthSession } from "aws-amplify/auth";

export interface Device {
  deviceId: string;
  name: string;
  role: string;
}

export async function getDevices(): Promise<Device[]> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!apiUrl) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }

  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error("No Cognito ID token available");
  }

  const response = await fetch(`${apiUrl}/devices`, {
    method: "GET",
    headers: {
      Authorization: idToken,
    },
  });

  if (!response.ok) {
    throw new Error(`GET /devices failed with status ${response.status}`);
  }

  const data: { devices: Device[] } = await response.json();
  return data.devices;
}
