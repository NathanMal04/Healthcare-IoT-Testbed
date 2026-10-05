"use client";

import { Building2, ChevronDown, UserRound, Users } from "lucide-react";
import { useWorkspace } from "@/context/WorkspaceContext";
import { scopeKey, workspaceScope } from "@/lib/workspaces";

const CREATE_OPTION = "__create__";
const SELECT_CLASS =
  "appearance-none h-9 w-full pl-8 pr-8 rounded-lg border border-line bg-white text-sm font-medium text-slate-800 shadow-sm truncate focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 disabled:opacity-60 disabled:cursor-not-allowed";

/**
 * The scope selector in the top bar: Personal, the user's workspaces, and
 * "Create workspace". Selecting is done through WorkspaceContext, which
 * restores the saved workspace and refuses changes while a write is running.
 */
export default function WorkspaceSelector() {
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

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="relative w-40 sm:w-52 min-w-0">
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

      {scopeReady && scope.kind === "workspace" && (
        <button
          type="button"
          onClick={() => openPanel("members")}
          className="hidden md:inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg text-sm text-slate-600 hover:text-slate-900 hover:bg-surface-sunken"
          title={`Members of ${scope.name}`}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          Members
        </button>
      )}
    </div>
  );
}
