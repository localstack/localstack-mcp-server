interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
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
    };
  }

  public static markdown(content: string): ToolResponse {
    return {
      content: [{ type: "text", text: content }],
    };
  }

  public static blocks(...parts: string[]): ToolResponse {
    return {
      content: parts.map((text) => ({ type: "text" as const, text })),
    };
  }
}
