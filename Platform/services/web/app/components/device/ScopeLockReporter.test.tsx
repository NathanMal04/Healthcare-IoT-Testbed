// @vitest-environment jsdom
// The real workspace provider (signed out, so it makes no requests): a lock
// taken inside ScopeLockReporter still locks the whole scope, and the
// reporter says whether anything inside it holds one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";

vi.mock("@/context/AuthContext", () => ({ useAuth: () => ({ user: null, loading: false }) }));

import { ScopeLockReporter, WorkspaceProvider, useScopeLock, useWorkspace } from "@/context/WorkspaceContext";

afterEach(cleanup);

const controls: Record<string, (on: boolean) => void> = {};

function Worker({ name }: { name: string }) {
  const [on, setOn] = useState(false);
  controls[name] = setOn;
  useScopeLock(on);
  return null;
}

function Locked() {
  return <p>scope locked: {String(useWorkspace().scopeLocked)}</p>;
}

describe("ScopeLockReporter", () => {
  it("reports locks held inside it, and still locks the scope", () => {
    const reports: [string, boolean][] = [];
    const { unmount } = render(
      <WorkspaceProvider>
        <ScopeLockReporter onChange={(locked) => reports.push(["a", locked])}>
          <Worker name="a1" />
          <Worker name="a2" />
        </ScopeLockReporter>
        <ScopeLockReporter onChange={(locked) => reports.push(["b", locked])}>
          <Worker name="b1" />
        </ScopeLockReporter>
        <Worker name="outside" />
        <Locked />
      </WorkspaceProvider>
    );
    const locked = () => screen.getByText(/scope locked/).textContent;
    expect(locked()).toBe("scope locked: false");

    act(() => controls.a1(true));
    expect(locked()).toBe("scope locked: true");
    expect(reports.filter(([n]) => n === "a").at(-1)).toEqual(["a", true]);
    expect(reports.filter(([n]) => n === "b").at(-1)).toEqual(["b", false]);

    act(() => controls.a2(true));
    act(() => controls.a1(false));
    // a2 still holds it.
    expect(reports.filter(([n]) => n === "a").at(-1)).toEqual(["a", true]);
    expect(locked()).toBe("scope locked: true");

    act(() => controls.a2(false));
    expect(reports.filter(([n]) => n === "a").at(-1)).toEqual(["a", false]);
    expect(locked()).toBe("scope locked: false");

    // A lock outside any reporter locks the scope but isn't reported.
    const before = reports.length;
    act(() => controls.outside(true));
    expect(locked()).toBe("scope locked: true");
    expect(reports.length).toBe(before);
    act(() => controls.outside(false));

    // Unmounting while locked releases the scope.
    act(() => controls.b1(true));
    expect(locked()).toBe("scope locked: true");
    unmount();
  });

  it("releases the scope when the part holding it unmounts", () => {
    function Host() {
      const [show, setShow] = useState(true);
      controls.hide = () => setShow(false);
      return (
        <>
          {show && (
            <ScopeLockReporter onChange={() => undefined}>
              <Worker name="w" />
            </ScopeLockReporter>
          )}
          <Locked />
        </>
      );
    }
    render(
      <WorkspaceProvider>
        <Host />
      </WorkspaceProvider>
    );
    act(() => controls.w(true));
    expect(screen.getByText(/scope locked/).textContent).toBe("scope locked: true");
    act(() => controls.hide(false));
    expect(screen.getByText(/scope locked/).textContent).toBe("scope locked: false");
  });
});
