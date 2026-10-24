"use client";

import { useEffect, useSyncExternalStore } from "react";

const STORAGE_KEY = "catalogforge-theme";
const CHANGE_EVENT = "catalogforge-theme-change";
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}
function getSnapshot() { return window.localStorage.getItem(STORAGE_KEY) !== "light"; }
function getServerSnapshot() { return true; }

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  function toggle() {
    const nextDark = !dark;
    document.documentElement.classList.toggle("dark", nextDark);
    window.localStorage.setItem(STORAGE_KEY, nextDark ? "dark" : "light");
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      className="min-h-11 rounded-md border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
      aria-pressed={dark}
      onClick={toggle}
    >
      {dark ? "Dark mode" : "Light mode"}
    </button>
  );
}
