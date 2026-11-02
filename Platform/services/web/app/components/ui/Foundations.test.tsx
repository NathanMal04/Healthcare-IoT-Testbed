// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useState } from "react";
import { Inbox } from "lucide-react";
import { Badge, StatusBadge } from "./Badge";
import { DataTable, nextSort, type Column, type SortState } from "./DataTable";
import { Dialog } from "./Dialog";
import { DescriptionList, PageContainer, PageSection } from "./Layout";
import { Sheet } from "./Sheet";
import { SplitView } from "./SplitView";
import { EmptyState, ErrorState, Skeleton } from "./States";
import { TabPanel, Tabs } from "./Tabs";
import { useLatestRequest } from "./useLatestRequest";
import { axeViolations } from "./testing/axe";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("accessibility checks", () => {
  it("do catch problems (the checker itself works)", async () => {
    const { container } = render(
      <div>
        <button type="button" />
        <input />
      </div>
    );
    const violations = await axeViolations(container);
    expect(violations.some((v) => v.startsWith("button-name"))).toBe(true);
    expect(violations.some((v) => v.startsWith("label"))).toBe(true);
  });
});

// --- Tabs -----------------------------------------------------------------------------

function TabsHarness({
  orientation,
  activation,
  onChange = () => undefined,
}: {
  orientation?: "horizontal" | "vertical";
  activation?: "manual" | "automatic";
  onChange?: (id: string) => void;
}) {
  const [active, setActive] = useState("overview");
  return (
    <>
      <Tabs
        ariaLabel="Device sections"
        active={active}
        orientation={orientation}
        activation={activation}
        idPrefix="device-"
        onChange={(id) => {
          onChange(id);
          setActive(id);
        }}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "firmware", label: "Firmware", count: 3 },
          { id: "notebook", label: "RE Notebook" },
        ]}
      />
      <TabPanel id={active} idPrefix="device-">
        <p>{active} content</p>
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("are reached as one stop, and arrow keys move focus without selecting (manual activation)", () => {
    const onChange = vi.fn();
    render(<TabsHarness onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    expect(onChange).not.toHaveBeenCalled(); // e.g. landing on a tab that navigates away doesn't
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" }); // wraps
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.click(tabs[1]); // Enter and Space activate a button as a click
    expect(onChange).toHaveBeenCalledWith("firmware");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("device-tab-firmware");
  });

  it("can select as focus moves, and run vertically with the up and down arrows", () => {
    const onChange = vi.fn();
    render(<TabsHarness orientation="vertical" activation="automatic" onChange={onChange} />);
    expect(screen.getByRole("tablist").getAttribute("aria-orientation")).toBe("vertical");
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" }); // not this orientation's key
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(tabs[0], { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("firmware");
    fireEvent.keyDown(tabs[1], { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("overview");
  });

  it("keep their existing ids without a prefix", () => {
    render(<Tabs ariaLabel="x" active="a" onChange={() => undefined} tabs={[{ id: "a", label: "A" }]} />);
    expect(screen.getByRole("tab").id).toBe("tab-a");
    expect(screen.getByRole("tab").getAttribute("aria-controls")).toBe("panel-a");
  });

  it("pass automated accessibility checks", async () => {
    const { container } = render(<TabsHarness />);
    expect(await axeViolations(container)).toEqual([]);
  });
});

// --- Dialog and Sheet -------------------------------------------------------------------

function ModalHarness({ kind, autoFocusField = false }: { kind: "dialog" | "sheet"; autoFocusField?: boolean }) {
  const [open, setOpen] = useState(false);
  const body = (
    <div>
      <label htmlFor="name">Name</label>
      <input id="name" autoFocus={autoFocusField} />
      <button type="button">Save</button>
    </div>
  );
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && kind === "dialog" && (
        <Dialog title="Rename device" subtitle="Shown to everyone in the workspace." onClose={() => setOpen(false)}>
          {body}
        </Dialog>
      )}
      {open && kind === "sheet" && (
        <Sheet title="CVE-2024-1234" description="Linked to 2 devices" onClose={() => setOpen(false)}>
          {body}
        </Sheet>
      )}
    </>
  );
}

describe.each(["dialog", "sheet"] as const)("%s", (kind) => {
  it("is named by its title, takes focus, keeps Tab inside, and gives focus back on close", async () => {
    render(<ModalHarness kind={kind} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const modal = screen.getByRole("dialog", { name: kind === "dialog" ? "Rename device" : "CVE-2024-1234" });
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.getAttribute("aria-describedby")).toBeTruthy();
    expect(modal.contains(document.activeElement)).toBe(true);

    const focusable = [...modal.querySelectorAll<HTMLElement>("button, input")];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    expect(await axeViolations(document.body)).toEqual([]);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus on a field that asked for it", () => {
    render(<ModalHarness kind={kind} autoFocusField />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });
});

describe("Sheet", () => {
  it("lets a dialog opened inside it close first on Escape", () => {
    const onClose = vi.fn();
    render(
      <Sheet title="Filters" onClose={onClose}>
        <div role="dialog" aria-label="Inner">
          <button type="button">Inner button</button>
        </div>
      </Sheet>
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Inner button" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// --- DataTable ----------------------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  size: number;
}
const ROWS: Row[] = [
  { id: "a", name: "firmware.bin", size: 3 },
  { id: "b", name: "boot.pcap", size: 1 },
];
const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name, sortable: true },
  { key: "size", header: "Size", cell: (r) => r.size, sortable: true, hideBelow: "md" },
];

describe("DataTable", () => {
  it("renders as before when no new option is used", () => {
    render(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.getAttribute("aria-sort"))).toEqual([null, null]);
    expect(within(headers[0]).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByRole("cell")[0].className).toContain("py-3");
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBeNull();
  });

  it("sorts through header buttons the page controls, and says how it is sorted", () => {
    function Sorted() {
      const [sort, setSort] = useState<SortState | null>(null);
      const rows = sort
        ? [...ROWS].sort((x, y) => (x[sort.key as "name"] < y[sort.key as "name"] ? -1 : 1) * (sort.direction === "asc" ? 1 : -1))
        : ROWS;
      return <DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id} sort={sort} onSortChange={setSort} caption="Artifacts" />;
    }
    render(<Sorted />);
    expect(screen.getByRole("table", { name: "Artifacts" })).toBeTruthy();
    const nameHeader = screen.getAllByRole("columnheader")[0];
    expect(nameHeader.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getAllByRole("row")[1].textContent).toContain("boot.pcap");
    fireEvent.click(within(nameHeader).getByRole("button", { name: "Name" }));
    expect(nameHeader.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getAllByRole("row")[1].textContent).toContain("firmware.bin");
    expect(nextSort({ key: "name", direction: "desc" }, "size")).toEqual({ key: "size", direction: "asc" });
  });

  it("shows placeholder rows while loading, an empty state, density and the selected row", async () => {
    const { rerender, container } = render(
      <DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} loading loadingRows={3} empty={<p>No artifacts</p>} />
    );
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll("tbody tr[aria-hidden='true']")).toHaveLength(3);
    expect(screen.queryByText("No artifacts")).toBeNull();

    rerender(<DataTable columns={COLUMNS} rows={[]} rowKey={(r) => r.id} empty={<p>No artifacts</p>} />);
    expect(screen.getByText("No artifacts")).toBeTruthy();

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        density="compact"
        selectedKey="b"
        onRowClick={() => undefined}
        rowLabel={(r) => `Open ${r.name}`}
      />
    );
    expect(screen.getAllByRole("cell")[0].className).toContain("py-2");
    expect(screen.getByRole("row", { name: "Open boot.pcap" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("row", { name: "Open firmware.bin" }).getAttribute("aria-current")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });
});

// --- States, badges and layout ------------------------------------------------------------

describe("states", () => {
  it("title empty and error states as headings at the level asked for", () => {
    render(
      <>
        <EmptyState icon={Inbox} title="No devices yet" />
        <EmptyState icon={Inbox} title="Nothing here" headingLevel={2} />
        <ErrorState title="Couldn't load" message={<span>Network error</span>} headingLevel={4} />
      </>
    );
    expect(screen.getByRole("heading", { name: "No devices yet", level: 3 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Nothing here", level: 2 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Couldn't load", level: 4 })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Network error");
  });

  it("keep skeletons out of the accessibility tree", () => {
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("badges", () => {
  it("use the semantic tones and sizes, and read multi-word statuses", () => {
    render(
      <>
        <Badge tone="success">Ready</Badge>
        <Badge tone="danger" size="sm">
          Failed
        </Badge>
        <StatusBadge status="build_failed_twice" />
      </>
    );
    expect(screen.getByText("Ready").className).toContain("text-success-700");
    expect(screen.getByText("Failed").className).toContain("text-2xs");
    expect(screen.getByText("build failed twice")).toBeTruthy();
  });
});

describe("layout", () => {
  it("contains pages at the three widths, and names sections by their heading", async () => {
    const { container } = render(
      <PageContainer width="fluid">
        <PageSection id="facts" title="Device facts" description="From the device record" actions={<button type="button">Edit</button>}>
          <DescriptionList
            items={[
              { term: "Manufacturer", value: "Acme" },
              { term: "Model", value: "" },
              { term: "Firmware", value: "1.2.3" },
            ]}
          />
        </PageSection>
      </PageContainer>
    );
    expect(container.firstElementChild?.className).toContain("max-w-content-fluid");
    expect(screen.getByRole("region", { name: "Device facts" })).toBeTruthy();
    // Empty values are left out.
    expect(screen.getAllByRole("term").map((t) => t.textContent)).toEqual(["Manufacturer", "Firmware"]);
    expect(await axeViolations(container)).toEqual([]);
  });
});

// --- SplitView ------------------------------------------------------------------------

function SplitHarness() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <SplitView
      view="cves.detail"
      userId="user-1"
      list={
        <ul>
          <li>
            <button type="button" onClick={() => setOpen("CVE-1")}>
              CVE-1
            </button>
          </li>
        </ul>
      }
      detail={open ? <p>Details of {open}</p> : null}
      detailTitle={open ?? ""}
      detailLabel="CVE details"
      onCloseDetail={() => setOpen(null)}
    />
  );
}

function stubMedia(large: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: large,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("SplitView", () => {
  it("shows details beside the list on large screens, resizable and remembered", () => {
    stubMedia(true);
    render(<SplitHarness />);
    const listButton = screen.getByRole("button", { name: "CVE-1" });
    expect(screen.queryByRole("complementary", { name: "CVE details" })).toBeNull();
    fireEvent.click(listButton);
    expect(within(screen.getByRole("complementary", { name: "CVE details" })).getByText("Details of CVE-1")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    const handle = screen.getByRole("separator", { name: "Resize cve details" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe("496");
    expect(JSON.parse(localStorage.getItem("vzoniq.layout.v1.user-1.cves.detail")!)).toEqual({ width: 496, collapsed: false });
    // The list stayed mounted throughout.
    expect(screen.getByRole("button", { name: "CVE-1" })).toBe(listButton);
  });

  it("opens details as a sheet over the list on smaller screens", () => {
    stubMedia(false);
    render(<SplitHarness />);
    const listButton = screen.getByRole("button", { name: "CVE-1" });
    fireEvent.click(listButton);
    const sheet = screen.getByRole("dialog", { name: "CVE-1" });
    expect(within(sheet).getByText("Details of CVE-1")).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "CVE-1" })).toBe(listButton);
  });
});

// --- useLatestRequest -------------------------------------------------------------------------

describe("useLatestRequest", () => {
  it("lets only the latest request apply, and none after unmount", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    const first = result.current.begin();
    const second = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(false);
    expect(result.current.isCurrent(second)).toBe(true);
    act(() => result.current.invalidate());
    expect(result.current.isCurrent(second)).toBe(false);
    const third = result.current.begin();
    expect(result.current.isCurrent(third)).toBe(true);
    unmount();
    expect(result.current.isCurrent(third)).toBe(false);
  });

  it("keeps a stable identity across renders (safe in effect dependencies)", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
