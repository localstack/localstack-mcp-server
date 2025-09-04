import { DEFAULT_FETCH_TIMEOUT, LOCALSTACK_BASE_URL } from "./config";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface RequestOptions extends RequestInit {
  timeout?: number;
  baseUrl?: string;
}

export class HttpClient {
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const {
      timeout = DEFAULT_FETCH_TIMEOUT,
      baseUrl = LOCALSTACK_BASE_URL,
      ...fetchOptions
    } = options;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        ...fetchOptions,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        const errorMessage = `HTTP Error: ${response.status} ${response.statusText} for URL: ${response.url}`;
        throw new HttpError(response.status, response.statusText, responseBody, errorMessage);
      }

      // Handle empty responses
      if (response.status === 204 || response.headers.get("content-length") === "0") {
        return {} as T;
      }

      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return (await response.json()) as T;
      } else {
        return (await response.text()) as T;
      }
    } catch (error: any) {
      if (error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      if (error.code === "ECONNREFUSED") {
        throw new Error(`Connection refused at ${baseUrl}. Is LocalStack running?`);
      }
      throw error; // Re-throw other errors
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// Export a singleton instance for convenience
export const httpClient = new HttpClient();
