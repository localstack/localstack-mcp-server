export const LOCALSTACK_HOSTNAME = process.env.LOCALSTACK_HOSTNAME || "localhost";
export const LOCALSTACK_PORT = process.env.LOCALSTACK_PORT || 4566;
export const LOCALSTACK_BASE_URL = `http://${LOCALSTACK_HOSTNAME}:${LOCALSTACK_PORT}`;

// Default timeout for network requests in milliseconds
export const DEFAULT_FETCH_TIMEOUT = 15000;

// Default timeouts and buffer sizes for command execution
export const DEFAULT_COMMAND_TIMEOUT = 300000; // 5 minutes
export const DEFAULT_COMMAND_MAX_BUFFER = 1024 * 1024 * 10; // 10 MB
