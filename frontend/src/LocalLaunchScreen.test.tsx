import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeLaunchNonce, LocalLaunchScreen } from "./LocalLaunchScreen";

afterEach(() => vi.unstubAllGlobals());

describe("local browser launch", () => {
  it("retains the nonce in memory before removing it from the URL", () => {
    history.replaceState(null, "", "/#launch=secret-value");

    expect(consumeLaunchNonce()).toBe("secret-value");
    expect(location.hash).toBe("#/");
  });

  it("removes malformed launch fragments without crashing", () => {
    history.replaceState(null, "", "/#launch=%E0%A4%A");

    expect(consumeLaunchNonce()).toBe("");
    expect(location.hash).toBe("#/");
  });

  it("claims the browser session and presents the established agent commands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const onContinue = vi.fn();

    render(<LocalLaunchScreen nonce={"a".repeat(43)} onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByText("Prompt Vault 已就绪")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "打开 Prompt Vault" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
