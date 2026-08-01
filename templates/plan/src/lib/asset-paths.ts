import type { PlanBlock, PlanContent } from "@shared/plan-content";

function mapBlocks(
  blocks: PlanBlock[],
  transform: (url: string) => string,
): PlanBlock[] {
  return blocks.map((block): PlanBlock => {
    if (block.type === "image" && block.data.url) {
      return { ...block, data: { ...block.data, url: transform(block.data.url) } };
    }
    if (block.type === "rich-text") {
      return {
        ...block,
        data: {
          ...block.data,
          markdown: block.data.markdown.replace(
            /(\]\()(assets\/[^)\s]+)(\))/g,
            (_match, open: string, url: string, close: string) =>
              `${open}${transform(url)}${close}`,
          ),
        },
      };
    }
    if (block.type === "tabs") {
      return {
        ...block,
        data: {
          ...block.data,
          tabs: block.data.tabs.map((tab) => ({
            ...tab,
            blocks: mapBlocks(tab.blocks, transform),
          })),
        },
      };
    }
    if (block.type === "columns") {
      return {
        ...block,
        data: {
          columns: block.data.columns.map((column) => ({
            ...column,
            blocks: mapBlocks(column.blocks, transform),
          })),
        },
      };
    }
    return block;
  });
}

export function resolveLocalAssetPaths(
  content: PlanContent,
  sessionId: string,
): PlanContent {
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/assets/`;
  return {
    ...content,
    blocks: mapBlocks(content.blocks, (url) =>
      url.startsWith("assets/")
        ? `${prefix}${encodeURIComponent(url.slice("assets/".length))}`
        : url,
    ),
  };
}

export function restoreLocalAssetPaths(
  content: PlanContent,
  sessionId: string,
): PlanContent {
  const prefix = `/api/sessions/${encodeURIComponent(sessionId)}/assets/`;
  return {
    ...content,
    blocks: mapBlocks(content.blocks, (url) =>
      url.startsWith(prefix)
        ? `assets/${decodeURIComponent(url.slice(prefix.length))}`
        : url,
    ),
  };
}
