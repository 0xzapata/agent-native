import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "sample-plan",
);
const baseURL = process.env.PLAN_LOCAL_BASE_URL ?? "http://127.0.0.1:8105";
const sessionId = process.env.PLAN_LOCAL_SESSION_ID;

test.use({ baseURL });

test("complete local plan exercises edit, canvas, prototype, comments, asset, state, reload, and loopback boundary", async ({
  page,
}) => {
  test.skip(
    !sessionId,
    "Set PLAN_LOCAL_SESSION_ID after registering local/sample-plan.",
  );
  if (!sessionId) return;
  const originalFiles = await Promise.all(
    [
      "plan.mdx",
      "canvas.mdx",
      "prototype.mdx",
      ".plan-state.json",
      "comments.json",
    ].map(
      async (name) =>
        [name, await fs.readFile(path.join(fixture, name), "utf8")] as const,
    ),
  );
  const restoreFixture = async () => {
    await Promise.all(
      originalFiles.map(([name, content]) =>
        fs.writeFile(path.join(fixture, name), content, "utf8"),
      ),
    );
  };
  const nonLoopbackRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      nonLoopbackRequests.push(request.url());
    }
  });

  try {
    await page.goto(`/plans/${sessionId}`);
    await expect(page.locator(".local-plan-shell")).toBeVisible();
    await expect(
      page.getByText("Seed feedback loaded from comments.json."),
    ).toBeVisible();

    const assetResponse = await page.request.get(
      `/api/sessions/${sessionId}/assets/local-plan-mark.svg`,
    );
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()["content-type"]).toContain("image/svg+xml");
    await expect(
      page.getByRole("img", { name: "Local plan sample mark" }),
    ).toBeVisible();

    await expect(page.locator(".plan-canvas")).toBeVisible();
    await expect(
      page.locator('[data-canvas-frame="canvas-welcome"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-canvas-frame="canvas-confirmation"]'),
    ).toBeVisible();
    await expect(page.locator(".plan-canvas-annotation")).toContainText(
      "Network boundary",
    );

    await page.getByRole("tab", { name: "Prototype" }).click();
    const viewer = page.locator("[data-plan-prototype-viewer]");
    await expect(
      viewer.locator('[data-prototype-screen="welcome"]'),
    ).toBeVisible();
    await viewer.getByRole("button", { name: "Continue" }).click();
    await expect(
      viewer.locator('[data-prototype-screen="confirmation"]'),
    ).toBeVisible();

    const unique = Date.now().toString(36);
    const titleText = `Local Editor Complete Sample ${unique}`;
    const summaryText = `All local surfaces passed ${unique}.`;
    const commentText = `Local feedback ${unique}`;

    const title = page.locator('[aria-label="Plan title"]');
    await title.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type(titleText);
    await page.keyboard.press("Enter");

    const summary = page.locator('[aria-label="Plan summary"]');
    await summary.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type(summaryText);
    await page.keyboard.press("Enter");

    await page
      .getByPlaceholder("Add feedback for the agent…")
      .fill(commentText);
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByText(commentText)).toBeVisible();
    await expect(page.getByText("Saved to disk")).toBeVisible({
      timeout: 20_000,
    });

    await page.reload();
    await expect(page.locator('[aria-label="Plan title"]')).toHaveText(
      titleText,
    );
    await expect(page.locator('[aria-label="Plan summary"]')).toHaveText(
      summaryText,
    );
    await expect(page.locator(".plan-document-editor-surface")).toContainText(
      "Local-first review flow",
    );
    await expect(page.getByText(commentText)).toBeVisible();
    await expect(page.locator(".plan-canvas-zoom span")).toContainText("72%");
    expect(nonLoopbackRequests).toEqual([]);

    expect(await fs.readFile(path.join(fixture, "plan.mdx"), "utf8")).toContain(
      titleText,
    );
    const comments = JSON.parse(
      await fs.readFile(path.join(fixture, "comments.json"), "utf8"),
    ) as Array<{ message: string }>;
    expect(comments.map(({ message }) => message)).toContain(commentText);
  } finally {
    await restoreFixture();
  }
});
