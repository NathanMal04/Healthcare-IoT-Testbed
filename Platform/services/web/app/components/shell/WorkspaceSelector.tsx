"use client";

import { Building2, ChevronDown, UserRound, Users } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { isReadOnlyScope, scopeKey, workspaceScope } from "@/lib/workspaces";
import { ReadOnlyMark } from "@/app/components/ui";

const CREATE_OPTION = "__create__";
const SELECT_CLASS =
  "appearance-none h-9 w-full pl-8 pr-8 rounded-lg border border-line bg-white text-sm font-medium text-slate-800 shadow-sm truncate focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 disabled:opacity-60 disabled:cursor-not-allowed";

/**
 * The scope selector at the top of the navigation: Personal, the user's
 * workspaces, and "Create workspace". Selecting is done through
 * WorkspaceContext, which restores the saved workspace and refuses changes
 * while a write is running (the selector is disabled and says why).
 *
 * In the collapsed navigation ("rail") it is a single button showing the
 * current scope; it expands the navigation to switch.
 */
export default function WorkspaceSelector({
  variant = "sidebar",
  onExpand,
}: {
  variant?: "sidebar" | "rail";
  /** Rail only: expands the navigation (where the selector is). */
  onExpand?: () => void;
}) {
  const {
    scope,
    scopeReady,
    workspaces,
    workspacesError,
    selectPersonal,
    selectWorkspace,
    openPanel,
    scopeLocked,
  } = useWorkspace();

  const current = scopeKey(scope);
  const listed = workspaces?.some((w) => w.workspaceId === (scope.kind === "workspace" ? scope.workspaceId : ""));

  function handleChange(value: string) {
    if (value === CREATE_OPTION) {
      // The select is controlled, so it stays on the current scope.
      openPanel("create");
    } else if (value === "personal") {
      selectPersonal();
    } else {
      const workspace = workspaces?.find((w) => scopeKey(workspaceScope(w)) === value);
      if (workspace) selectWorkspace(workspace);
    }
  }

  const ScopeIcon = scopeReady && scope.kind === "workspace" ? Building2 : UserRound;
  const scopeName = !scopeReady ? "Loading" : scope.kind === "workspace" ? scope.name : "Personal";
  const readOnly = scopeReady && isReadOnlyScope(scope);

  if (variant === "rail") {
    return (
      <button
        type="button"
        onClick={onExpand}
        aria-label={`Scope: ${scopeName}${readOnly ? " (read-only)" : ""}. Expand the navigation to switch`}
        title={`Scope: ${scopeName}${readOnly ? " (read-only)" : ""}`}
        className="group relative h-10 w-10 inline-flex items-center justify-center rounded-lg border border-line bg-white text-slate-600 shadow-sm hover:text-slate-900 hover:border-line-strong outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ScopeIcon className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div className="space-y-1.5 min-w-0">
      <div className="relative w-full min-w-0">
        <ScopeIcon className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
        {/* Until the saved workspace is restored, the scope is a placeholder
            Personal; show neither it nor any choice. */}
        {!scopeReady ? (
          <select aria-label="Personal or workspace" value="__loading__" disabled className={SELECT_CLASS}>
            <option value="__loading__">Loading…</option>
          </select>
        ) : (
          <select
            aria-label="Personal or workspace"
            value={current}
            onChange={(e) => handleChange(e.target.value)}
            disabled={scopeLocked}
            title={scopeLocked ? "Finish the upload or change in progress before switching" : undefined}
            aria-describedby={scopeLocked ? "scope-locked-reason" : undefined}
            className={SELECT_CLASS}
          >
            <option value="personal">Personal</option>
            {workspaces && workspaces.length > 0 && (
              <optgroup label="Workspaces">
                {workspaces.map((w) => (
                  <option key={w.workspaceId} value={scopeKey(workspaceScope(w))}>
                    {w.name}
                  </option>
                ))}
              </optgroup>
            )}
            {scope.kind === "workspace" && !listed && <option value={current}>{scope.name}</option>}
            {workspacesError && (
              <option disabled value="__error__">
                Couldn&apos;t load workspaces
              </option>
            )}
            <option value={CREATE_OPTION}>+ Create workspace…</option>
          </select>
        )}
        <ChevronDown className="h-4 w-4 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
      </div>

      {readOnly && (
        <p className="px-1">
          <ReadOnlyMark />
        </p>
      )}
      {scopeLocked && (
        <p id="scope-locked-reason" className="px-1 text-2xs text-slate-500">
          Finish the upload or change in progress before switching.
        </p>
      )}
      {scopeReady && scope.kind === "workspace" && (
        <button
          type="button"
          onClick={() => openPanel("members")}
          className="w-full inline-flex items-center gap-2 h-8 px-2.5 rounded-lg text-sm text-slate-600 hover:text-slate-900 hover:bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          title={`Members of ${scope.name}`}
        >
          <Users className="h-4 w-4 text-slate-400" aria-hidden="true" />
          Members
        </button>
      )}
    </div>
  );
}
