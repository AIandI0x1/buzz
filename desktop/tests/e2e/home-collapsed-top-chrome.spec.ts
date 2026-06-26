import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

test.describe("home inbox header collapsed-sidebar chrome clearance", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("inbox options clear the macOS traffic-light region when sidebar is collapsed", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("home-inbox-list")).toBeVisible();

    await page.locator('[data-sidebar="trigger"]').click();

    const inboxOptions = page.getByTestId("inbox-options-trigger");
    await expect(inboxOptions).toBeVisible();
    await expect
      .poll(async () =>
        inboxOptions.evaluate((element) =>
          Math.round(element.getBoundingClientRect().left),
        ),
      )
      .toBeGreaterThanOrEqual(168);

    await waitForAnimations(page);
  });

  test("inbox list and detail share a single header backdrop", async ({
    page,
  }) => {
    await installMockBridge(page);
    await page.goto("/");
    await expect(page.getByTestId("home-inbox-list")).toBeVisible();
    await expect(page.getByTestId("home-inbox-detail")).toBeVisible();

    const homeInbox = page.getByTestId("home-inbox");
    const sharedBackdrop = page.getByTestId(
      "home-inbox-shared-header-backdrop",
    );
    await expect(sharedBackdrop).toHaveCount(1);

    const [homeBox, backdropBox, backdropFilter] = await Promise.all([
      homeInbox.boundingBox(),
      sharedBackdrop.boundingBox(),
      sharedBackdrop.evaluate(
        (element) => getComputedStyle(element).backdropFilter,
      ),
    ]);

    expect(homeBox).not.toBeNull();
    expect(backdropBox).not.toBeNull();
    expect(Math.round(backdropBox?.x ?? 0)).toBe(Math.round(homeBox?.x ?? 0));
    expect(Math.round(backdropBox?.width ?? 0)).toBe(
      Math.round(homeBox?.width ?? 0),
    );
    expect(backdropFilter).not.toBe("none");

    await waitForAnimations(page);
  });
});
