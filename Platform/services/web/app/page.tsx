import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Cpu,
  FolderArchive,
  Layers,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Upload,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { BrandMark } from "@/app/components/shell/BrandMark";
import { GetStartedLink, SignInLink } from "@/app/components/landing/AuthCta";
import LandingHeader from "@/app/components/landing/LandingHeader";
import { LANDING_SECTIONS } from "@/app/components/landing/sections";
import PlatformPreview from "@/app/components/landing/PlatformPreview";
import { AppFrame, DashboardPreview } from "@/app/components/landing/Previews";

export const metadata: Metadata = {
  title: "Vzoniq · Healthcare IoT Security Testbed",
  description:
    "A collaborative security testbed for analyzing medical IoT devices, firmware, vulnerabilities, and reverse-engineering workflows.",
};

// The public landing page. The app itself starts at /dashboard; everything
// here is static apart from the header menu, the auth-aware buttons and the
// preview tabs.

const WORKFLOW: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Cpu,
    title: "Add Device",
    text: "Register each device under test, in Personal or a shared workspace.",
  },
  {
    icon: Upload,
    title: "Upload Firmware",
    text: "Attach firmware versions, captures, logs and binaries, up to 5 GiB per file.",
  },
  {
    icon: Workflow,
    title: "Run Analysis",
    text: "Run your Python scripts over selected files, with a cost estimate first.",
  },
  {
    icon: ShieldAlert,
    title: "Track CVEs",
    text: "Record known vulnerabilities and link them to the devices they affect.",
  },
  {
    icon: Users,
    title: "Collaborate",
    text: "Invite teammates to a workspace and work from the same devices and findings.",
  },
];

const FEATURES: { icon: LucideIcon; title: string; text: string; points: string[] }[] = [
  {
    icon: Cpu,
    title: "Device Management",
    text: "An inventory of the medical devices under test. Each device page gathers its firmware, artifacts and linked CVEs.",
    points: ["Name and device type", "Owner or member access", "Per-device overview tabs"],
  },
  {
    icon: FolderArchive,
    title: "Firmware & Artifacts",
    text: "Upload firmware versions alongside packet captures, logs, binaries and other files from your research.",
    points: ["Up to 5 GiB per file", "SHA-256 checksums computed in the browser", "Types, versions and tags"],
  },
  {
    icon: Workflow,
    title: "Analysis Runs",
    text: "Package an analysis script with the tools it needs, then run it in bulk over the files you choose.",
    points: ["Single .py, .zip project or your own Dockerfile", "Per file, grouped or chunked work units", "Jobs, logs and outputs per run"],
  },
  {
    icon: ShieldAlert,
    title: "CVE Database",
    text: "Record known vulnerabilities with the detail you need to triage them, and link each to the devices it affects.",
    points: ["Severity, CVSS score and version", "Affected chipsets and references", "Search across IDs, descriptions and devices"],
  },
  {
    icon: ScanSearch,
    title: "Reverse Engineering Tracking",
    text: "Mark each device and firmware version as not started, in progress or complete, and follow progress on the dashboard.",
    points: ["Status on devices and firmware", "Progress across the whole scope", "Filter devices by status"],
  },
  {
    icon: Users,
    title: "Collaborative Workspaces",
    text: "Share devices, files, CVEs and analysis runs with your team, or keep work in your Personal scope.",
    points: ["Invite members by email", "Owner and member roles", "Switch scopes from the top bar"],
  },
];

const ABOUT_POINTS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Layers,
    title: "One place for the whole investigation",
    text: "Devices, files, scripts, runs and CVEs live side by side instead of across drives, spreadsheets and notebooks.",
  },
  {
    icon: ShieldCheck,
    title: "Scoped by design",
    text: "Everything you add belongs to your Personal scope or to a workspace, and only that workspace's members can see it.",
  },
  {
    icon: Workflow,
    title: "Analysis you can repeat",
    text: "Scripts and environments are versioned, so a run can be reproduced on new firmware the same way it ran before.",
  },
];

function SectionHeading({ eyebrow, title, text, id }: { eyebrow: string; title: string; text: string; id: string }) {
  return (
    <div className="max-w-2xl mx-auto text-center">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">{eyebrow}</p>
      <h2 id={id} className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">
        {title}
      </h2>
      <p className="mt-3 text-slate-600">{text}</p>
    </div>
  );
}

/** The auth screens' navy grid and glow, as a section background. Clips itself. */
function NavyBackdrop() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
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
      <div className="absolute top-1/3 -left-24 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl" aria-hidden="true" />
    </div>
  );
}

export default function LandingPage() {
  return (
    <div data-landing className="min-h-screen bg-surface-muted">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-white focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-pop"
      >
        Skip to content
      </a>
      <LandingHeader />

      <main id="main-content" tabIndex={-1} className="focus:outline-none">
        {/* Hero */}
        <section id="product" aria-labelledby="hero-title" className="relative scroll-mt-16 bg-navy-900 text-white">
          <NavyBackdrop />
          <div className="relative flow-root max-w-6xl mx-auto px-4 sm:px-6 pt-16 sm:pt-24 text-center">
            <p className="motion-safe:animate-fade-up inline-flex items-center gap-2 rounded-full bg-white/5 ring-1 ring-white/10 px-3 py-1 text-xs font-medium text-brand-200">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden="true" />
              Healthcare IoT Security Testbed
            </p>
            <h1
              id="hero-title"
              className="motion-safe:animate-fade-up mt-6 text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-[1.08]"
            >
              Analyze. Reverse Engineer.{" "}
              <span className="bg-gradient-to-r from-brand-200 to-sky-300 bg-clip-text text-transparent">Secure.</span>
            </h1>
            <p className="motion-safe:animate-fade-up mt-6 max-w-2xl mx-auto text-base sm:text-lg text-navy-200 [animation-delay:80ms]">
              A collaborative security testbed for analyzing medical IoT devices, firmware, vulnerabilities, and
              reverse-engineering workflows.
            </p>
            <div className="motion-safe:animate-fade-up mt-8 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 [animation-delay:160ms]">
              <GetStartedLink size="lg" />
              <a
                href="#platform"
                className="inline-flex h-11 px-5 items-center justify-center gap-2 rounded-lg text-[15px] font-medium text-white ring-1 ring-inset ring-white/20 hover:bg-white/5 transition-colors"
              >
                Explore Platform
              </a>
            </div>

            <figure className="relative mt-14 sm:mt-16 -mb-24 sm:-mb-40 motion-safe:animate-fade-up [animation-delay:240ms]">
              <div className="absolute inset-x-0 -top-10 bottom-0 bg-brand-500/20 blur-3xl rounded-full" aria-hidden="true" />
              <div className="relative" aria-hidden="true">
                <AppFrame path="/dashboard" active="Dashboard">
                  <DashboardPreview />
                </AppFrame>
              </div>
              <figcaption className="sr-only">
                Preview of the Vzoniq dashboard: device, vulnerability, firmware and artifact counts, reverse-engineering
                progress and recently updated CVEs, shown with sample data.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* How it works */}
        <section aria-labelledby="workflow-title" className="pt-36 sm:pt-56 pb-20 sm:pb-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <p className="text-center text-2xs text-slate-500 mb-16">Previews use illustrative sample data.</p>
            <div id="how-it-works" className="scroll-mt-24">
              <SectionHeading
                id="workflow-title"
                eyebrow="How it works"
                title="From device on the bench to tracked vulnerability"
                text="Five steps take a connected medical device through analysis, with your team working from the same records."
              />
            </div>
            <div className="relative mt-14">
              <div
                className="hidden lg:block absolute top-6 left-[10%] right-[10%] h-px bg-gradient-to-r from-brand-200 via-brand-500 to-brand-200"
                aria-hidden="true"
              />
              <ol className="relative grid gap-8 lg:grid-cols-5 lg:gap-6">
                {WORKFLOW.map(({ icon: Icon, title, text }, i) => (
                  <li key={title} className="group relative flex gap-4 lg:flex-col lg:items-center lg:text-center">
                    {i < WORKFLOW.length - 1 && (
                      <span className="lg:hidden absolute left-6 top-12 -bottom-8 w-px bg-brand-200" aria-hidden="true" />
                    )}
                    <span className="relative z-10 h-12 w-12 shrink-0 rounded-xl bg-white ring-1 ring-line shadow-card flex items-center justify-center text-brand-600 transition-colors group-hover:bg-brand-600 group-hover:text-white group-hover:ring-brand-600">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="pt-1 lg:pt-0">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-brand-600">Step {i + 1}</p>
                      <h3 className="mt-1 text-base font-semibold text-slate-900">{title}</h3>
                      <p className="mt-1.5 text-sm text-slate-600">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" aria-labelledby="features-title" className="scroll-mt-16 py-20 sm:py-24 bg-white border-y border-line">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <SectionHeading
              id="features-title"
              eyebrow="Features"
              title="Everything a device investigation needs"
              text="Each capability below is part of the platform today."
            />
            <ul className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, text, points }) => (
                <li
                  key={title}
                  className="group bg-white rounded-xl border border-line shadow-card p-6 transition hover:border-brand-200 hover:shadow-md motion-safe:hover:-translate-y-0.5"
                >
                  <span className="h-10 w-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center transition-colors group-hover:bg-brand-600 group-hover:text-white">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
                  <p className="mt-2 text-sm text-slate-600">{text}</p>
                  <ul className="mt-4 space-y-1.5 border-t border-line pt-4">
                    {points.map((point) => (
                      <li key={point} className="flex items-start gap-2 text-xs text-slate-600">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-500" aria-hidden="true" />
                        {point}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Platform preview */}
        <section id="platform" aria-labelledby="platform-title" className="scroll-mt-16 py-20 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <SectionHeading
              id="platform-title"
              eyebrow="Platform"
              title="A closer look at the workspace"
              text="The pages you'll use every day. Previews use illustrative sample data, not real devices or findings."
            />
            <div className="mt-10">
              <PlatformPreview />
            </div>
          </div>
        </section>

        {/* About */}
        <section id="about" aria-labelledby="about-title" className="scroll-mt-16 py-20 sm:py-24 bg-white border-y border-line">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 grid gap-12 lg:grid-cols-2 lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-600">About</p>
              <h2 id="about-title" className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">
                A research testbed for connected medical devices
              </h2>
              <p className="mt-4 text-slate-600">
                Vzoniq is a healthcare IoT vulnerability testbed. It brings device inventory, firmware and artifact
                storage, scripted analysis and CVE tracking together, so a research team can follow a device from first
                teardown to known vulnerabilities.
              </p>
              <p className="mt-4 text-slate-600">
                Work on your own in a Personal scope, or create a workspace and invite the people you research with.
              </p>
            </div>
            <ul className="space-y-4">
              {ABOUT_POINTS.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-4 rounded-xl border border-line bg-surface-muted p-5">
                  <span className="h-9 w-9 shrink-0 rounded-lg bg-white ring-1 ring-line text-brand-600 flex items-center justify-center">
                    <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
                    <p className="mt-1 text-sm text-slate-600">{text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Final call to action */}
        <section aria-labelledby="cta-title" className="py-20 sm:py-24">
          <div className="max-w-6xl mx-auto px-4 sm:px-6">
            <div className="relative overflow-hidden rounded-2xl bg-navy-900 text-white px-6 py-14 sm:px-12 sm:py-16 text-center">
              <NavyBackdrop />
              <div className="relative">
                <h2 id="cta-title" className="text-2xl sm:text-4xl font-semibold tracking-tight">
                  Start Analyzing with Vzoniq
                </h2>
                <p className="mt-4 max-w-xl mx-auto text-navy-200">
                  Create an account, register your first device and upload its firmware.
                </p>
                <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <GetStartedLink size="lg" />
                  <SignInLink className="inline-flex items-center gap-1.5 h-11 px-4 rounded-lg text-[15px] font-medium text-navy-200 hover:text-white" />
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="bg-navy-950 text-navy-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 flex flex-col md:flex-row gap-8 md:items-center md:justify-between">
          <Link href="/" className="self-start rounded-lg" aria-label="Vzoniq home">
            <BrandMark tone="dark" />
          </Link>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {LANDING_SECTIONS.map((s) => (
              <a key={s.href} href={s.href} className="hover:text-white transition-colors">
                {s.label}
              </a>
            ))}
            <Link href="/login" className="hover:text-white transition-colors">
              Sign In
            </Link>
            <Link href="/signup" className="inline-flex items-center gap-1 hover:text-white transition-colors">
              Create account <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </nav>
        </div>
        <div className="border-t border-white/5">
          <p className="max-w-6xl mx-auto px-4 sm:px-6 py-5 text-xs text-navy-300">
            Vzoniq · Healthcare IoT Vulnerability Testbed
          </p>
        </div>
      </footer>
    </div>
  );
}
