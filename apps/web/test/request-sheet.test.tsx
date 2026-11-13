import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RequestSheet } from "@/components/connect/request-sheet";
import fixtureJson from "@/lib/fixtures/connect-recording.json";
import { ReplaySource, type ConnectAccountView, type ConnectRecordingFile } from "@/lib/connect-source";

const recording = fixtureJson as unknown as ConnectRecordingFile;

async function view(): Promise<ConnectAccountView> {
  const src = ReplaySource.fromJson(recording);
  const [account] = await src.listAccounts();
  return (await src.getAccount(account!.id))!;
}

describe("RequestSheet blocked state", () => {
  it("shows 'Blocked by Shelter' and names what would have been linked", async () => {
    const v = await view();
    const blocked = v.account.requests.find((r) => r.decision === "blocked")!;
    render(<RequestSheet view={v} request={blocked} open onOpenChange={() => {}} />);

    expect((await screen.findAllByText("Blocked by Shelter")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/your main wallet/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("calldata_linked").length).toBeGreaterThan(0);
    // Decoded request details are still visible under the block banner.
    expect(screen.getAllByText("Send tokens").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/0\.1 USDC/).length).toBeGreaterThan(0);
  });

  it("shows warnings but no block banner for the approved request", async () => {
    const v = await view();
    const approved = v.account.requests.find((r) => r.seq === 1)!;
    render(<RequestSheet view={v} request={approved} open onOpenChange={() => {}} />);

    expect(screen.queryByText("Blocked by Shelter")).not.toBeInTheDocument();
    expect((await screen.findAllByText("Unlimited")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unlimited approval/i).length).toBeGreaterThan(0);
  });

  it("closes on Escape", async () => {
    const v = await view();
    const onOpenChange = vi.fn();
    const blocked = v.account.requests.find((r) => r.decision === "blocked")!;
    render(<RequestSheet view={v} request={blocked} open onOpenChange={onOpenChange} />);
    await screen.findAllByText("Blocked by Shelter");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
