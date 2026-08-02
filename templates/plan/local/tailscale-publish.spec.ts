import { describe, expect, it, vi } from "vitest";

import {
  publishPlanToTailnet,
  TAILSCALE_HTTPS_PORT,
} from "./tailscale-publish.js";

const sessionId = "q4Nvf1C0kXMGnRPPd9-4wg-ghUhUI_u4";

describe("local Tailscale publishing", () => {
  it("publishes the loopback editor with Tailscale Serve, never Funnel", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.ts.net." },
        }),
      })
      .mockResolvedValueOnce({ stdout: "{}" })
      .mockResolvedValueOnce({ stdout: "Available within your tailnet" })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
          Web: {
            [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8105" } },
            },
          },
        }),
      });

    await expect(publishPlanToTailnet(sessionId, run)).resolves.toEqual({
      url: `https://mac.example.ts.net:${TAILSCALE_HTTPS_PORT}/plans/${sessionId}`,
    });
    expect(run).toHaveBeenCalledWith("tailscale", [
      "serve",
      "--bg",
      "--yes",
      `--https=${TAILSCALE_HTTPS_PORT}`,
      "http://127.0.0.1:8105",
    ]);
    expect(run.mock.calls.flat(2)).not.toContain("funnel");
  });

  it("reuses its existing Serve listener without changing node config", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.ts.net." },
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
          Web: {
            [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8105" } },
            },
          },
        }),
      });

    await publishPlanToTailnet(sessionId, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refuses to overwrite another service on the dedicated port", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.ts.net." },
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
          Web: {
            [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
            },
          },
        }),
      });

    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      /already in use/,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects an existing Funnel listener even when its proxy matches", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.ts.net." },
        }),
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
          Web: {
            [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8105" } },
            },
          },
          AllowFunnel: { [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: true },
        }),
      });

    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      /Funnel is enabled/,
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid session ids before calling Tailscale", async () => {
    const run = vi.fn();
    await expect(publishPlanToTailnet("short/id", run)).rejects.toThrow(
      /Invalid plan session id/,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a connected Tailscale backend", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ BackendState: "Stopped" }),
    });
    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      /must be connected/,
    );
  });

  it("requires a tailnet MagicDNS name", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "example.com." },
      }),
    });
    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      /MagicDNS and HTTPS/,
    );
  });

  it("reports malformed JSON with its Tailscale command", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "not json" });
    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      'Could not read "tailscale status --json" output.',
    );
  });

  it.each([
    { TCP: { [TAILSCALE_HTTPS_PORT]: {} } },
    {
      TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
      Web: {
        [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    },
    {
      TCP: { [TAILSCALE_HTTPS_PORT]: { HTTPS: true } },
      Web: {
        [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8105" } },
        },
      },
      AllowFunnel: { [`mac.example.ts.net:${TAILSCALE_HTTPS_PORT}`]: true },
    },
  ])("rejects an invalid post-publish read-back", async (verified) => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.ts.net." },
        }),
      })
      .mockResolvedValueOnce({ stdout: "{}" })
      .mockResolvedValueOnce({ stdout: "published" })
      .mockResolvedValueOnce({ stdout: JSON.stringify(verified) });

    await expect(publishPlanToTailnet(sessionId, run)).rejects.toThrow(
      /did not publish/,
    );
  });
});
