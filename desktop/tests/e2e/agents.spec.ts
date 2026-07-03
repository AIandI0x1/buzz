import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

async function gotoApp(page: import("@playwright/test").Page) {
  let lastError: unknown = null;

  for (const attempt of [0, 1]) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForInvokeBridge(page);

    try {
      await expect(page.getByTestId("open-agents-view")).toBeVisible({
        timeout: 10_000,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function openCreateAgentStart(page: import("@playwright/test").Page) {
  await page.getByTestId("new-agent-card").click();
}

async function waitForInvokeBridge(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const tauriWindow = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: unknown;
        __TAURI_INTERNALS__?: {
          invoke?: unknown;
        };
      };

      return (
        typeof tauriWindow.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ === "function" ||
        typeof tauriWindow.__TAURI_INTERNALS__?.invoke === "function"
      );
    },
    null,
    { timeout: 5_000 },
  );
}

async function invokeTauri<T>(
  page: import("@playwright/test").Page,
  command: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  await waitForInvokeBridge(page);

  return page.evaluate(
    async ({ command: targetCommand, payload: targetPayload }) => {
      const tauriWindow = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          command: string,
          payload?: Record<string, unknown>,
        ) => Promise<unknown>;
        __TAURI_INTERNALS__?: {
          invoke?: (
            command: string,
            payload?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      };

      const invoke =
        tauriWindow.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ ??
        tauriWindow.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        throw new Error("Mock invoke bridge is unavailable.");
      }

      return (await invoke(targetCommand, targetPayload)) as T;
    },
    { command, payload },
  );
}

async function invokeTauriExpectError(
  page: import("@playwright/test").Page,
  command: string,
  payload?: Record<string, unknown>,
) {
  await waitForInvokeBridge(page);

  return page.evaluate(
    async ({ command: targetCommand, payload: targetPayload }) => {
      const tauriWindow = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          command: string,
          payload?: Record<string, unknown>,
        ) => Promise<unknown>;
        __TAURI_INTERNALS__?: {
          invoke?: (
            command: string,
            payload?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      };

      const invoke =
        tauriWindow.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ ??
        tauriWindow.__TAURI_INTERNALS__?.invoke;
      if (!invoke) {
        throw new Error("Mock invoke bridge is unavailable.");
      }

      try {
        await invoke(targetCommand, targetPayload);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { command, payload },
  );
}

test("create agent wizard offers blank, import, and template starting points", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByTestId("open-agents-view").click();

  await expect(page.getByTestId("agents-library-personas")).toBeVisible();
  await openCreateAgentStart(page);

  await expect(page.getByTestId("create-agent-start-blank")).toBeVisible();
  await expect(page.getByTestId("create-agent-start-import")).toBeVisible();
  await expect(
    page.getByTestId("create-agent-template-builtin:fizz"),
  ).toContainText("Fizz");
  await expect(
    page.getByTestId("create-agent-template-builtin:product-strategist"),
  ).toContainText("Product Strategist");
});

test("selecting a template prefills the create agent form", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByTestId("open-agents-view").click();
  await openCreateAgentStart(page);

  await page.getByTestId("create-agent-template-builtin:fizz").click();
  await page.getByTestId("create-agent-start-use-template").click();

  await expect(page.getByTestId("agent-name-input")).toHaveValue("Fizz");
  await expect(page.getByTestId("agent-instructions-input")).toHaveValue(
    "You are Fizz.",
  );
  await expect(page.getByTestId("create-agent-submit")).toBeVisible();
});

test("template submit creates an agent card in the grid", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("open-agents-view").click();
  await openCreateAgentStart(page);

  await page.getByTestId("create-agent-template-builtin:fizz").click();
  await page.getByTestId("create-agent-start-use-template").click();
  await expect(page.getByTestId("agent-name-input")).toHaveValue("Fizz");
  await expect(page.getByTestId("create-agent-submit")).toBeEnabled();
  await page.getByTestId("create-agent-submit").click();

  // The secret-reveal dialog confirms the create round-trip; dismiss it.
  await expect(page.getByText("Agent created")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("agents-library-personas")).toContainText(
    "Fizz",
  );
});

test("blank starting point opens an empty create agent form", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByTestId("open-agents-view").click();
  await openCreateAgentStart(page);

  await page.getByTestId("create-agent-start-blank").click();

  await expect(page.getByTestId("agent-name-input")).toHaveValue("");
  await expect(page.getByTestId("create-agent-submit")).toBeDisabled();
});

test("agent cards expose edit, duplicate, channel, template, export, and remove actions", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "Honey",
        status: "stopped",
      },
    ],
  });
  await gotoApp(page);

  await page.getByTestId("open-agents-view").click();
  await expect(page.getByTestId("agents-library-personas")).toContainText(
    "Honey",
  );

  await page.getByLabel("Open actions for Honey").click();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Edit",
    "Duplicate",
    "Add to channel",
    "Save as template",
    "Export",
    "Remove",
  ]);
});

test("save as template surfaces the agent in the create wizard's Saved group", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "Honey",
        status: "stopped",
      },
    ],
  });
  await gotoApp(page);

  await page.getByTestId("open-agents-view").click();
  await page.getByLabel("Open actions for Honey").click();
  await page.getByRole("menuitem", { name: "Save as template" }).click();

  await expect(
    page.getByText("Saved Honey as a template", { exact: false }),
  ).toBeVisible();

  await openCreateAgentStart(page);
  await expect(
    page.getByTestId("create-agent-start-dialog-scroll-area"),
  ).toContainText("Saved");
  const savedRow = page
    .getByTestId("create-agent-start-dialog-scroll-area")
    .getByRole("button", { name: "Honey" });
  await expect(savedRow).toBeVisible();

  // Selecting the saved template shows its detail pane with the Saved type.
  await savedRow.click();
  await expect(
    page.getByTestId("create-agent-start-detail-pane"),
  ).toContainText("Saved template");
});

test("duplicate opens the create form prefilled from the agent", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: TEST_IDENTITIES.alice.pubkey,
        name: "Honey",
        status: "stopped",
      },
    ],
  });
  await gotoApp(page);

  await page.getByTestId("open-agents-view").click();
  await page.getByLabel("Open actions for Honey").click();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();

  await expect(page.getByText("Duplicate Honey")).toBeVisible();
  await expect(page.getByTestId("agent-name-input")).toHaveValue("Honey copy");
});

test("teams can be created with agent members", async ({ page }) => {
  await gotoApp(page);

  const team = await invokeTauri<{
    id: string;
    agent_pubkeys: string[];
  }>(page, "create_team", {
    input: {
      name: "Bee Squad",
      personaIds: [],
      agentPubkeys: [TEST_IDENTITIES.alice.pubkey],
    },
  });

  expect(team.agent_pubkeys).toEqual([TEST_IDENTITIES.alice.pubkey]);
});

test("inactive personas cannot be used to create teams", async ({ page }) => {
  await gotoApp(page);

  const error = await invokeTauriExpectError(page, "create_team", {
    input: {
      name: "Fizzes",
      personaIds: ["builtin:product-strategist"],
      agentPubkeys: [],
    },
  });

  expect(error).toBe("Product Strategist is not available for new agents.");
});

test("personas referenced by teams cannot be deleted", async ({ page }) => {
  await gotoApp(page);

  const persona = await invokeTauri<{ id: string }>(page, "create_persona", {
    input: {
      displayName: "Analyst",
      systemPrompt: "You are Analyst.",
    },
  });

  await invokeTauri(page, "create_team", {
    input: {
      name: "Analysts",
      personaIds: [persona.id],
      agentPubkeys: [],
    },
  });

  const error = await invokeTauriExpectError(page, "delete_persona", {
    id: persona.id,
  });

  expect(error).toBe(
    "Analyst is still referenced by a team. Remove it from those teams first.",
  );
});
