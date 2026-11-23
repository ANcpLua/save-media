import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { userMessage, type UserMessage } from "@savemedia/core";
import { FailureMessage } from "../../../src/popup/components/FailureMessage";
import { TechnicalDetails } from "../../../src/popup/components/TechnicalDetails";

const message = (over: Partial<UserMessage> = {}): UserMessage => ({ title: "The server is busy", body: "The video server is not responding properly right now.",
  hint: "Try again in a few minutes.", tone: "unavailable", action: null,
  details: [{ label: "HTTP status", value: "503" }, { label: "Server", value: "cdn.example:8443" }, { label: "Error code", value: "server_busy" }], ...over });

describe("the one way a failure is shown", () => {
  it("always shows what happened and what to do, and keeps the technical facts closed until asked for", () => {
    render(<FailureMessage message={message()} testId="job-error"/>);
    const failure = screen.getByTestId("job-error");
    expect(within(failure).getByTestId("failure-title").textContent).toBe("The server is busy");
    expect(within(failure).getByTestId("failure-body").textContent).toBe("The video server is not responding properly right now.");
    expect(within(failure).getByTestId("failure-hint").textContent).toBe("Try again in a few minutes.");
    const details = failure.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Technical details");
    // Title, body and hint are outside the disclosure: a failure with details never hides its own explanation.
    for (const id of ["failure-title", "failure-body", "failure-hint"]) expect(details.contains(within(failure).getByTestId(id))).toBe(false);
  });

  it("puts every technical fact in an element of its own, so no value is glued to another", () => {
    render(<FailureMessage message={message()}/>);
    const labels = [...document.querySelectorAll("dt")].map(node => node.textContent);
    const values = [...document.querySelectorAll("dd")].map(node => node.textContent);
    expect(labels).toEqual(["HTTP status", "Server", "Error code"]);
    expect(values).toEqual(["503", "cdn.example:8443", "server_busy"]);
    // An exact match finds each value: nothing precedes or follows it in its element.
    expect(screen.getByText("cdn.example:8443", { exact: true }).tagName).toBe("DD");
    expect(screen.getByText("server_busy", { exact: true }).tagName).toBe("DD");
  });

  it("shows no hint line when nothing helps, and no disclosure when there is nothing technical to say", () => {
    render(<FailureMessage message={message({ hint: null, details: [] })} testId="drm-card"/>);
    expect(screen.queryByTestId("failure-hint")).toBeNull();
    expect(screen.getByTestId("drm-card").querySelector("details")).toBeNull();
    const { container } = render(<TechnicalDetails rows={[]}/>);
    expect(container.firstChild).toBeNull();
  });

  it.each([["protected", "text-white"], ["unusable", "text-red-300"], ["unavailable", "text-orange-300"], ["neutral", "text-muted"]] as const)(
    "colours the title of a %s message %s", (tone, className) => {
      render(<FailureMessage message={message({ tone })} testId="job-error"/>);
      expect(screen.getByTestId("job-error").getAttribute("data-tone")).toBe(tone);
      expect(screen.getByTestId("failure-title").className).toContain(className);
    });

  it("says what a failed save kept and for how long, and shows what else can be tried", () => {
    const expiresAt = Date.now() + 9 * 60_000 + 500;
    render(<FailureMessage message={message()} retained={{ bytes: 3 * 1024 ** 2, total: 12 * 1024 ** 2, expiresAt }}
      extra={<p data-testid="extra">The Local downloader below can try this page with yt-dlp.</p>}/>);
    expect(screen.getByTestId("retained-bytes").textContent).toBe("savemedia kept 3.0 MB of 12.0 MB for 10 more minutes. Retry save in this tab to continue from there.");
    expect(screen.getByTestId("extra")).toBeTruthy();
  });

  it("promises nothing about bytes that are no longer kept", () => {
    render(<FailureMessage message={message()} retained={{ bytes: 3, total: 12, expiresAt: Date.now() - 1 }}/>);
    expect(screen.queryByTestId("retained-bytes")).toBeNull();
  });

  it("has no live region of its own: what is on screen when a popup opens is not read out", () => {
    render(<FailureMessage message={userMessage({ code: "unexpected_media_response", severity: "terminal", response: "page", host: "cdn.example" })}/>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("[aria-live]")).toBeNull();
  });
});
