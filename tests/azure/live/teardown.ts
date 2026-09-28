import { resetAzureServices } from "../../../src/lib/azure/services";

// Every live file ends by closing the process-wide services. The egress guard's listening
// socket would otherwise keep Jest alive after the last test, until the CI job's timeout.
afterAll(async () => {
  await resetAzureServices();
});
