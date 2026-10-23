"use client";

import { useState } from "react";
import { TabPanel, Tabs } from "@/app/components/ui/Tabs";
import { AppFrame, CvesPreview, DashboardPreview, DevicesPreview, RunsPreview } from "./Previews";

type PreviewId = "dashboard" | "devices" | "cves" | "runs";

const PREVIEWS: { id: PreviewId; label: string; nav: string; path: string; view: () => React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", nav: "Dashboard", path: "/dashboard", view: DashboardPreview },
  { id: "devices", label: "Devices", nav: "Devices", path: "/devices", view: DevicesPreview },
  { id: "cves", label: "CVE Database", nav: "Vulnerabilities", path: "/vulnerabilities", view: CvesPreview },
  { id: "runs", label: "Analysis Runs", nav: "Runs", path: "/runs", view: RunsPreview },
];

/** The platform tour: one tab per page, each a static preview with sample data. */
export default function PlatformPreview() {
  const [active, setActive] = useState<PreviewId>("dashboard");
  const preview = PREVIEWS.find((p) => p.id === active) ?? PREVIEWS[0];
  const View = preview.view;
  return (
    <div>
      <div className="flex justify-center">
        <Tabs
          tabs={PREVIEWS.map(({ id, label }) => ({ id, label }))}
          active={active}
          onChange={setActive}
          ariaLabel="Platform previews"
        />
      </div>
      <TabPanel id={active}>
        <div key={active} className="motion-safe:animate-fade-up">
          <AppFrame path={preview.path} active={preview.nav}>
            <View />
          </AppFrame>
        </div>
      </TabPanel>
    </div>
  );
}
