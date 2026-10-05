import { Cpu, Microchip, ShieldAlert, Users } from "lucide-react";
import { BrandMark } from "@/app/components/shell/BrandMark";

// What the platform does today; nothing here promises unbuilt features.
const CAPABILITIES = [
  { icon: Cpu, title: "Devices", text: "Register the devices under test and track reverse-engineering progress." },
  { icon: Microchip, title: "Firmware & artifacts", text: "Upload firmware versions, captures, logs and binaries, up to 5 GiB each." },
  { icon: ShieldAlert, title: "Vulnerabilities", text: "Record known CVEs and link them to the devices they affect." },
  { icon: Users, title: "Workspaces", text: "Work alone or share devices and findings with your team." },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] bg-white">
      <div className="flex flex-col px-6 sm:px-10 py-8">
        <BrandMark tone="light" />
        <div className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
        <p className="text-xs text-slate-400">Vzoniq · Healthcare IoT Vulnerability Testbed</p>
      </div>

      <aside className="hidden lg:flex relative overflow-hidden bg-navy-900 text-white">
        {/* Grid and glow: decoration only. */}
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(147,168,204,0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(147,168,204,0.25) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
          }}
          aria-hidden="true"
        />
        <div className="absolute -top-32 -right-24 h-96 w-96 rounded-full bg-brand-600/30 blur-3xl" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl" aria-hidden="true" />

        <div className="relative flex flex-col justify-center px-12 xl:px-16 py-16 max-w-xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-200">Healthcare IoT Vulnerability Testbed</p>
          <h2 className="mt-4 text-3xl xl:text-4xl font-semibold leading-tight tracking-tight">
            Analyze connected medical devices, from firmware to known vulnerabilities.
          </h2>
          <ul className="mt-10 space-y-5">
            {CAPABILITIES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3.5">
                <span className="h-9 w-9 shrink-0 rounded-lg bg-white/10 ring-1 ring-white/15 flex items-center justify-center">
                  <Icon className="h-[18px] w-[18px] text-brand-200" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-sm font-medium">{title}</p>
                  <p className="text-sm text-navy-200 mt-0.5">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
