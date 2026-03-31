import client from "./mongodb";

let sessionCleanupPromise: Promise<void> | null = null;

declare global {
  var _sessionCleanupPromise: Promise<void> | undefined;
}

async function setupSessionCleanup() {
  const db = client.db();
  await db.collection("session").createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "session_ttl_index" }
  );
}

export function ensureSessionCleanupRunsOnce() {
  if (process.env.NODE_ENV === "development") {
    if (!global._sessionCleanupPromise) {
      global._sessionCleanupPromise = setupSessionCleanup();
    }
    return global._sessionCleanupPromise;
  } else {
    if (!sessionCleanupPromise) {
      sessionCleanupPromise = setupSessionCleanup();
    }
    return sessionCleanupPromise;
  }
}
