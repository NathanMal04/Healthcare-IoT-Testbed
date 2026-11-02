"use client";

import { ArrowLeft, Maximize2, Minimize2, PanelLeft, PanelRight } from "lucide-react";
import type { Device } from "@/lib/devices";
import type { Scope } from "@/lib/workspaces";
import ProfileAvatar from "@/app/components/images/ProfileAvatar";
import type { ImageUrls } from "@/app/components/images/useImageData";
import UserMenu from "@/app/components/shell/UserMenu";
import { ScopeLabel } from "@/app/components/ui";
import SaveStatus from "../SaveStatus";
import type { SaveStateReport } from "../EntryEditor";

export const ENTRIES_PANEL_REGION = "re-notebook-entries-panel";
export const CONTEXT_PANEL_REGION = "re-notebook-context-panel";

function IconToggle({
  label,
  pressed,
  controls,
  icon: Icon,
  onClick,
  text,
  shortcut,
}: {
  label: string;
  pressed: boolean;
  controls?: string;
  icon: typeof PanelLeft;
  onClick: () => void;
  text?: string;
  /** Its keyboard shortcut, shown in the tooltip and announced. */
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={controls ? pressed : undefined}
      aria-pressed={controls ? undefined : pressed}
      aria-controls={controls}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      className={`h-9 inline-flex items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        pressed ? "bg-brand-50 text-brand-700" : "text-slate-500 hover:bg-surface-sunken hover:text-slate-900"
      }`}
    >
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      {text && <span className="hidden lg:inline">{text}</span>}
    </button>
  );
}

/**
 * The notebook workspace's compact top bar: back to the device, the device
 * and notebook it is, the save state, and the layout controls. In Focus Mode
 * only Back, the save state and Exit Focus Mode remain.
 */
export default function NotebookTopBar({
  device,
  scope,
  avatarUrls,
  save,
  focus,
  leftShown,
  rightShown,
  showPanelToggles,
  onBack,
  onToggleLeft,
  onToggleRight,
  onFocus,
}: {
  device: Device;
  scope: Scope;
  avatarUrls: ImageUrls;
  save: SaveStateReport | null;
  focus: boolean;
  leftShown: boolean;
  rightShown: boolean;
  /** False while the notebook has no sections (nothing to show in the panels). */
  showPanelToggles: boolean;
  onBack: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onFocus: (focus: boolean) => void;
}) {
  return (
    <header className="h-14 shrink-0 bg-white border-b border-line">
      <div className="h-full px-2 sm:px-4 flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={onBack}
          className="h-9 shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2 sm:px-2.5 text-sm font-medium text-slate-700 hover:bg-surface-sunken hover:text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Back to Device</span>
        </button>
        <span className="h-6 w-px bg-line shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-2.5">
          <ProfileAvatar
            artifactId={device.profileImageArtifactId}
            urls={avatarUrls}
            alt={device.name}
            className="hidden sm:flex"
          />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate text-sm font-semibold text-slate-900">
              <span className="sr-only">RE Notebook: </span>
              {device.name}
            </h1>
            {!focus && (
              <p className="hidden sm:flex items-center gap-1.5 truncate text-xs text-slate-500" aria-hidden="true">
                <span>RE Notebook</span>
                <span className="text-slate-300">·</span>
                <ScopeLabel scope={scope} />
              </p>
            )}
          </div>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          {save && (
            <div className="min-w-0 max-w-[7rem] sm:max-w-[16rem] truncate">
              <SaveStatus state={save.state} onRetry={save.retry} />
            </div>
          )}
          {focus ? (
            <IconToggle
              label="Exit Focus Mode"
              pressed
              icon={Minimize2}
              text="Exit Focus Mode"
              shortcut="Escape"
              onClick={() => onFocus(false)}
            />
          ) : (
            <>
              {showPanelToggles && (
                <>
                  <span className="hidden sm:block h-6 w-px bg-line" aria-hidden="true" />
                  <IconToggle
                    label={leftShown ? "Hide the entries panel" : "Show the entries panel"}
                    pressed={leftShown}
                    controls={ENTRIES_PANEL_REGION}
                    icon={PanelLeft}
                    shortcut="Control+Alt+["
                    onClick={onToggleLeft}
                  />
                  <IconToggle
                    label={rightShown ? "Hide the device context panel" : "Show the device context panel"}
                    pressed={rightShown}
                    controls={CONTEXT_PANEL_REGION}
                    icon={PanelRight}
                    shortcut="Control+Alt+]"
                    onClick={onToggleRight}
                  />
                  <IconToggle
                    label="Focus Mode"
                    pressed={false}
                    icon={Maximize2}
                    shortcut="Control+Alt+F"
                    onClick={() => onFocus(true)}
                  />
                </>
              )}
              <UserMenu />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
