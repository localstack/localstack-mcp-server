interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  /** MCP's flag for a failed tool call; clients and test harnesses read it, not the ❌ prefix. */
  isError?: boolean;
}

export class ResponseBuilder {
  public static success(message: string): ToolResponse {
    return {
      content: [{ type: "text", text: `✅ ${message}` }],
    };
  }

  public static error(title: string, details?: string): ToolResponse {
    let text = `❌ **${title}**`;
    if (details) {
      text += `\n\n${details}`;
    }
    return {
      content: [{ type: "text", text }],
      isError: true,
    };
  }

  public static markdown(content: string): ToolResponse {
    return {
      content: [{ type: "text", text: content }],
    };
  }
}
