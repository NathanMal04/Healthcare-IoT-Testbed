"use client";

import { useWorkspace } from "@/context/WorkspaceContext";
import { scopeKey, workspaceScope } from "@/lib/workspaces";

const CREATE_OPTION = "__create__";
const SELECT_CLASS =
  "text-sm bg-slate-800 text-white border border-slate-700 rounded-lg px-2 py-1.5 max-w-[14rem] disabled:opacity-50";

/** The scope selector in the nav bar: Personal, the user's workspaces, and "Create workspace". */
export default function WorkspaceSwitcher() {
  const {
    scope,
    scopeReady,
    workspaces,
    workspacesError,
    invitations,
    selectPersonal,
    selectWorkspace,
    openPanel,
    scopeLocked,
  } = useWorkspace();

  const current = scopeKey(scope);
  const listed = workspaces?.some((w) => w.workspaceId === (scope.kind === "workspace" ? scope.workspaceId : ""));
  const pending = invitations?.length ?? 0;

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

  return (
    <div className="flex items-center gap-3">
      {/* Until the saved workspace is restored, the scope is a placeholder
          Personal; show neither it nor any choice. */}
      {!scopeReady ? (
        <select aria-label="Personal or workspace" value="__loading__" disabled className={SELECT_CLASS}>
          <option value="__loading__">Loading…</option>
          {/* Never shown (the select can't open); it only sizes the select
              like the real one, so the nav bar doesn't shift. */}
          <option value={CREATE_OPTION}>+ Create workspace…</option>
        </select>
      ) : (
        <select
          aria-label="Personal or workspace"
          value={current}
          onChange={(e) => handleChange(e.target.value)}
          disabled={scopeLocked}
          title={scopeLocked ? "Finish the upload before switching" : undefined}
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

      {scopeReady && scope.kind === "workspace" && (
        <button
          type="button"
          onClick={() => openPanel("members")}
          className="text-sm text-slate-300 hover:text-white transition-colors"
        >
          Members
        </button>
      )}

      <button
        type="button"
        onClick={() => openPanel("invitations")}
        className="text-sm text-slate-400 hover:text-white transition-colors flex items-center gap-1.5"
      >
        Invitations
        {pending > 0 && (
          <span className="text-xs bg-blue-600 text-white rounded-full px-1.5 min-w-[1.25rem] text-center">
            {pending}
          </span>
        )}
      </button>
    </div>
  );
}
