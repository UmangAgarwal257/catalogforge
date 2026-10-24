// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./theme-toggle";

afterEach(() => {
  cleanup();
  document.documentElement.classList.add("dark");
  window.localStorage.clear();
});

it("starts in dark mode, lets the user switch themes, and remembers the choice", async () => {
  render(<ThemeToggle />);
  const button = await screen.findByRole("button", { name: "Switch to light mode" });
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  fireEvent.click(button);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(window.localStorage.getItem("catalogforge-theme")).toBe("light");
  expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeTruthy();
});
