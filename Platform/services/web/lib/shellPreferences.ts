// The application shell's layout preference (sidebar expanded or collapsed
// to an icon rail), remembered per user on this browser. Only this flag is
// stored; unreadable or blocked storage means the default (expanded).

const PREFIX = "vzoniq.shell.v1.";

export interface ShellPreferences {
  sidebarCollapsed: boolean;
}

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = { sidebarCollapsed: false };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readShellPreferences(userId: string): ShellPreferences {
  try {
    const raw = storage()?.getItem(PREFIX + userId);
    if (!raw) return DEFAULT_SHELL_PREFERENCES;
    const value = JSON.parse(raw) as { sidebarCollapsed?: unknown } | null;
    return { sidebarCollapsed: value?.sidebarCollapsed === true };
  } catch {
    return DEFAULT_SHELL_PREFERENCES;
  }
}

export function writeShellPreferences(userId: string, preferences: ShellPreferences): void {
  try {
    storage()?.setItem(PREFIX + userId, JSON.stringify({ sidebarCollapsed: preferences.sidebarCollapsed === true }));
  } catch {
    // Not remembered; the shell still works for this visit.
  }
}
