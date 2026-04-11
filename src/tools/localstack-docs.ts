import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { httpClient } from "../core/http-client";
import { runPreflights, requireAuthToken } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";

const CRAWLCHAT_DOCS_ENDPOINT =
  "https://wings.crawlchat.app/mcp/698f2c11e688991df3c7e020";

type CrawlChatDocsResult = {
  content: string;
  url: string;
};

export const schema = {
  query: z.string().describe("The search query."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe("Maximum number of results to return."),
};

export const metadata: ToolMetadata = {
  name: "localstack-docs",
  description:
    "Search the LocalStack documentation to find guides, API references, and configuration details",
  annotations: {
    title: "LocalStack Docs Search",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function localstackDocs({ query, limit }: InferSchema<typeof schema>) {
  try {
    const preflightError = await runPreflights([requireAuthToken()]);
    if (preflightError) return preflightError;

    const endpoint = `${CRAWLCHAT_DOCS_ENDPOINT}?query=${encodeURIComponent(query)}`;
    const response = await httpClient.request<CrawlChatDocsResult[]>(endpoint, {
      method: "GET",
      baseUrl: "",
    });

    if (!Array.isArray(response) || response.length === 0) {
      return ResponseBuilder.error(
        "No Results",
        "No documentation found for your query. Try rephrasing or visit https://docs.localstack.cloud directly."
      );
    }

    const results = response
      .slice(0, limit)
      .map((item) => ({ content: item.content, url: item.url }));

    const markdown = formatMarkdownResults(query, results);
    return ResponseBuilder.markdown(markdown);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return ResponseBuilder.error("Docs Search Unavailable", message);
  }
  
}

function formatMarkdownResults(query: string, results: CrawlChatDocsResult[]): string {
  let markdown = `# LocalStack Docs: "${query}"\n\n`;
  markdown += `**${results.length} results found**\n\n`;

  for (const result of results) {
    const label = getLabelFromUrlPath(result.url);
    markdown += `---\n\n`;
    markdown += `### [${label}](${result.url})\n\n`;
    markdown += `${result.content}\n\n`;
  }

  return markdown.trimEnd();
}

function getLabelFromUrlPath(urlString: string): string {
  try {
    const url = new URL(urlString);
    const lastSegment = url.pathname
      .split("/")
      .filter(Boolean)
      .at(-1);

    if (!lastSegment) {
      return url.hostname;
    }

    const normalizedSegment = decodeURIComponent(lastSegment)
      .replace(/[-_]+/g, " ")
      .replace(/\.[a-zA-Z0-9]+$/, "")
      .trim();

    if (!normalizedSegment) {
      return url.hostname;
    }

    return normalizedSegment
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  } catch {
    return "Documentation";
  }
}
