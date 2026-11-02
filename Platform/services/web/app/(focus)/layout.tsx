import FocusShell from "@/app/components/shell/FocusShell";

// Full-screen signed-in pages (no sidebar). Route groups don't change URLs:
// app/(focus)/devices/notebook is served at /devices/notebook.
export default function FocusLayout({ children }: { children: React.ReactNode }) {
  return <FocusShell>{children}</FocusShell>;
}
