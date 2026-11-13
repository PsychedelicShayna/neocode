import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { Route as LegacyProvidersRoute } from "../../routes/_chat.settings.providers";
import { validateSettingsRouteSearch } from "./settingsScopeNavigation";

it.each([
  { query: "machine=selected-server&instanceId=native-work", environment: "selected-server" },
  { query: "environmentId=legacy-server&instanceId=native-work", environment: "legacy-server" },
  {
    query: "machine=selected-server&environmentId=stale-server&instanceId=native-work",
    environment: "selected-server",
  },
])("preserves the selected Models destination from $query", async ({ query, environment }) => {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "settings",
    validateSearch: validateSettingsRouteSearch,
  });
  const legacy = createRoute({
    getParentRoute: () => settings,
    path: "providers",
    validateSearch: LegacyProvidersRoute.options.validateSearch,
    beforeLoad: (context) =>
      LegacyProvidersRoute.options.beforeLoad?.(
        context as unknown as Parameters<
          NonNullable<typeof LegacyProvidersRoute.options.beforeLoad>
        >[0],
      ),
  });
  const models = createRoute({ getParentRoute: () => root, path: "models" });
  const router = createRouter({
    routeTree: root.addChildren([settings.addChildren([legacy]), models]),
    history: createMemoryHistory({ initialEntries: [`/settings/providers?${query}`] }),
  });
  await router.navigate({
    to: "/settings/providers",
    search: Object.fromEntries(new URLSearchParams(query)),
  });
  expect(router.state.redirect?.options.to).toBe("/models");
  expect(router.state.redirect?.options.search).toEqual({ environment, instance: "native-work" });
});
