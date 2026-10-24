// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/shop/products/example",
  useSearchParams: () => new URLSearchParams("page=2&lang=de"),
  useRouter: () => ({ push }),
}));

import { LanguageSwitcher } from "./language-switcher";
import { storefrontCategoryLabel, storefrontCopy } from "./copy";

afterEach(() => {
  cleanup();
  push.mockClear();
  document.documentElement.lang = "en";
});

it("sets the document language and preserves other query parameters when switching", async () => {
  render(<LanguageSwitcher />);
  const select = screen.getByRole("combobox", { name: "Sprache des Shops" });
  await waitFor(() => expect(document.documentElement.lang).toBe("de"));

  fireEvent.change(select, { target: { value: "fr" } });
  expect(document.documentElement.lang).toBe("fr");
  expect(push).toHaveBeenCalledWith("/shop/products/example?page=2&lang=fr");
});

it("localizes storefront controls and category labels while retaining an explicit English fallback", () => {
  expect(storefrontCopy("de").fallback).toBe("Englische Version");
  expect(storefrontCopy("fr").emptyTitle).toBe("Aucun produit publié pour le moment");
  expect(storefrontCategoryLabel("Electronics > Chargers", "de")).toBe("Elektronik > Ladegeräte");
});
