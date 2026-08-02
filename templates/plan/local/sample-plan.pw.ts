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
const fixtureFiles = [
  "plan.mdx",
  "canvas.mdx",
  "prototype.mdx",
  ".plan-state.json",
  "comments.json",
] as const;

const originalFiles = await Promise.all(
  fixtureFiles.map(
    async (name) =>
      [name, await fs.readFile(path.join(fixture, name), "utf8")] as const,
  ),
);

async function restoreFixture() {
  await Promise.all(
    originalFiles.map(([name, content]) =>
      fs.writeFile(path.join(fixture, name), content, "utf8"),
    ),
  );
}

test.use({ baseURL });
test.afterEach(restoreFixture);

test("complete local plan exercises edit, canvas, prototype, comments, asset, state, reload, and loopback boundary", async ({
  browser,
}) => {
  test.skip(
    !sessionId,
    "Set PLAN_LOCAL_SESSION_ID after registering local/sample-plan.",
  );
  if (!sessionId) return;
  const nonLoopbackRequests: string[] = [];
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost"
    ) {
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
    const replyText = `Local reply ${unique}`;
    const editedReplyText = `Edited local reply ${unique}`;

    const title = page.locator('[aria-label="Plan title"]');
    await title.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(titleText);
    await page.keyboard.press("Enter");

    const summary = page.locator('[aria-label="Plan summary"]');
    await summary.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(summaryText);
    await page.keyboard.press("Enter");

    await page
      .getByPlaceholder("Add feedback for the agent…")
      .fill(commentText);
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByText(commentText)).toBeVisible();

    let sentToAgent = false;
    await page.route(
      `**/api/sessions/${sessionId}/agent/send`,
      async (route) => {
        sentToAgent = true;
        await route.fulfill({
          json: {
            harness: "codex",
            threadId: "sample-agent-task",
            url: "codex://threads/sample-agent-task",
          },
        });
      },
    );
    await page.getByRole("button", { name: "Send to agent" }).click();
    await expect(
      page.getByText("Sent to codex task sample-agent-task"),
    ).toBeVisible();
    expect(sentToAgent).toBe(true);

    const commentThread = page
      .locator("article")
      .filter({ hasText: commentText });
    await commentThread
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await commentThread.getByRole("textbox", { name: "Reply" }).fill(replyText);
    await commentThread
      .getByRole("button", { name: "Reply", exact: true })
      .last()
      .click();
    await expect(commentThread.getByText(replyText)).toBeVisible();

    const replyBlock = commentThread.locator(":scope > div > div").nth(1);
    await replyBlock.getByTitle("Edit comment").click();
    await commentThread
      .getByRole("textbox", { name: "Edit comment" })
      .fill(editedReplyText);
    await commentThread
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(commentThread.getByText(editedReplyText)).toBeVisible();

    await commentThread.getByTitle("Resolve comment").click();
    await expect(
      commentThread.getByText("Resolved", { exact: true }),
    ).toBeVisible();
    await commentThread.getByTitle("Reopen comment").click();
    await expect(
      commentThread.getByText("Open", { exact: true }).first(),
    ).toBeVisible();

    await expect(page.getByText("Saved to disk")).toBeVisible({
      timeout: 20_000,
    });

    let published = false;
    await page.route(`**/api/sessions/${sessionId}/publish`, async (route) => {
      published = true;
      await route.fulfill({
        json: {
          url: `https://mac.example.ts.net:8443/plans/${sessionId}`,
        },
      });
    });
    await page.getByRole("button", { name: "Publish to tailnet" }).click();
    await expect(
      page.getByText(/Tailnet URL copied|Published to https:/),
    ).toBeVisible();
    expect(published).toBe(true);

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
    await expect(page.getByText(editedReplyText)).toBeVisible();
    await expect(page.locator(".plan-canvas-zoom span")).toContainText("72%");
    expect(nonLoopbackRequests).toEqual([]);

    const reloadedThread = page
      .locator("article")
      .filter({ hasText: commentText });
    const reloadedReplyBlock = reloadedThread
      .locator(":scope > div > div")
      .nth(1);
    await reloadedReplyBlock.getByTitle("Delete comment").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(editedReplyText)).toHaveCount(0);

    await reloadedThread.getByTitle("Delete comment").click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText(commentText)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(commentText)).toHaveCount(0);

    expect(await fs.readFile(path.join(fixture, "plan.mdx"), "utf8")).toContain(
      titleText,
    );
    const comments = JSON.parse(
      await fs.readFile(path.join(fixture, "comments.json"), "utf8"),
    ) as Array<{ message: string }>;
    expect(comments.map(({ message }) => message)).not.toContain(commentText);
    expect(comments.map(({ message }) => message)).not.toContain(
      editedReplyText,
    );
  } finally {
    await context.close();
    await restoreFixture();
  }
});
