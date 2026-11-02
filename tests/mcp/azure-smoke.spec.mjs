import { createServer } from "node:net";
import { expect, test } from "@gleanwork/mcp-server-tester/fixtures/mcp";

// The Azure tool against a live LocalStack Azure emulator (.github/workflows/azure-smoke.yml):
// the management tool starts it, then a short tour of az commands runs through the tool.

const text = (result) => (result?.content ?? []).map((c) => c.text ?? "").join("\n");
const id = Date.now().toString(36);
const group = `mcp-smoke-${id}`;
const account = `mcpsmoke${id}`;
const vault = `mcp-smoke-${id}`;

test("az commands through the Azure tool", async ({ mcp }) => {
  test.setTimeout(15 * 60_000);
  const az = async (command, expected) => {
    const answer = text(await mcp.callTool("localstack-azure-client", { command }));
    expect(answer, command).not.toMatch(/^❌/);
    if (expected) expect(answer, command).toMatch(expected);
    return answer;
  };
  const storage = `--account-name ${account} --auth-mode key`;

  await test.step("start the emulator", async () => {
    const answer = text(
      await mcp.callTool("localstack-management", { action: "start", service: "azure" })
    );
    expect(answer).toMatch(/started successfully|already running/);
  });
  await test.step("resource group", () =>
    az(`group create --name ${group} --location westeurope`, /"Succeeded"/));
  await test.step("storage account, container and blob", async () => {
    await az(
      `storage account create --name ${account} --resource-group ${group} --location westeurope --sku Standard_LRS`
    );
    await az(`storage container create --name data ${storage}`);
    await az(
      `storage blob upload --container-name data --name hello.txt --file data/sample-azure/hello.txt ${storage}`
    );
    await az(`storage blob list --container-name data ${storage} --query "[].name"`, /hello\.txt/);
  });
  await test.step("key vault secret", async () => {
    await az(`keyvault create --name ${vault} --resource-group ${group} --location westeurope`);
    await az(`keyvault secret set --vault-name ${vault} --name smoke --value s3cret-${id}`);
    await az(
      `keyvault secret show --vault-name ${vault} --name smoke --query value`,
      `s3cret-${id}`
    );
  });
  await test.step("rest with a management.azure.com URL", () =>
    az(
      "rest --method get --url https://management.azure.com/subscriptions/{subscriptionId}/resourcegroups?api-version=2021-04-01",
      new RegExp(group)
    ));
  await test.step("a refused command", async () => {
    const answer = text(await mcp.callTool("localstack-azure-client", { command: "login" }));
    expect(answer).toMatch(/^❌ \*\*Command not allowed\*\*/);
  });
  await test.step("an endpoint outside the emulator is refused", async () => {
    // A listener stands in for a server outside the emulator: on this machine, on no emulator
    // port, so nothing goes towards real Azure if the guard ever regresses. http keeps it quick:
    // an https refusal is final too, but az's SDK retries the tunnel for over a minute.
    let connections = 0;
    const listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const outside = `127.0.0.1:${listener.address().port}`;
    const key = Buffer.from("not-a-real-account-key").toString("base64");
    try {
      const answer = text(
        await mcp.callTool("localstack-azure-client", {
          command: `storage blob upload --blob-endpoint http://${outside} --account-name ${account} --account-key ${key} --container-name data --name leak.txt --file data/sample-azure/hello.txt`,
        })
      );
      expect(answer).toMatch(/^❌/);
      expect(answer).toContain(`could not reach \`http://${outside}\``);
      expect(connections).toBe(0);
    } finally {
      listener.close();
    }
  });
  await test.step("delete the resource group", () => az(`group delete --name ${group} --yes`));
});
