import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    validator(validate: (value: unknown) => unknown) {
      return {
        handler(handler: (options: { data: unknown }) => unknown) {
          return async ({ data }: { data: unknown }) =>
            handler({ data: validate(data) });
        },
      };
    },
  }),
}));

const {
  preserveOriginalFrontmatter,
  replaceFrontmatterValue,
  serializeLocalPlan,
} = await import("./plan-source");

describe("local plan source", () => {
  it.each([null, {}, { blocks: [null] }, { blocks: ["not a block"] }])(
    "rejects malformed plan content before asset traversal: %j",
    async (content) => {
      await expect(
        serializeLocalPlan({
          data: {
            sessionId: "session",
            content,
            files: { "plan.mdx": "# Existing plan" },
          },
        }),
      ).rejects.toThrow();
    },
  );

  it("preserves valid original frontmatter around the exported body", () => {
    const original = [
      "---",
      'title: "Original"',
      'custom: "keep"',
      "---",
      "",
      "Original body",
    ].join("\n");
    const exported = [
      "---",
      'title: "Exported"',
      "---",
      "",
      "Exported body",
    ].join("\n");

    expect(preserveOriginalFrontmatter(original, exported)).toBe(
      [
        "---",
        'title: "Original"',
        'custom: "keep"',
        "---",
        "",
        "Exported body",
      ].join("\n"),
    );
  });

  it("uses exported source when original frontmatter is absent or malformed", () => {
    const exported = ["---", 'title: "Exported"', "---", "", "Body"].join("\n");

    expect(
      preserveOriginalFrontmatter(
        "# Original\n\n---\n\nThematic break",
        exported,
      ),
    ).toBe(exported);
    expect(
      preserveOriginalFrontmatter('---\ntitle: "Unclosed"\nBody', exported),
    ).toBe(exported);
  });

  it("does not edit malformed frontmatter", () => {
    const source = '---\ntitle: "Unclosed"\nBody';
    expect(replaceFrontmatterValue(source, "title", "Changed")).toBe(source);
  });
});
