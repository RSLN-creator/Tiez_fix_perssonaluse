import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { supportsCustomBackground } from "../config/themes";

interface UseCustomBackgroundOptions {
  customBackground: string;
  customBackgroundOpacity: number;
  theme: string;
}

export const useCustomBackground = ({
  customBackground,
  customBackgroundOpacity,
  theme
}: UseCustomBackgroundOptions) => {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.style.setProperty("--custom-bg-opacity", (customBackgroundOpacity / 100).toString());
    const active = Boolean(customBackground) && supportsCustomBackground(theme);
    if (active) {
      root.style.setProperty("--custom-bg-image", `url("${convertFileSrc(customBackground)}")`);
      body.classList.add("has-custom-bg");
    } else {
      root.style.removeProperty("--custom-bg-image");
      body.classList.remove("has-custom-bg");
    }
    // The CSS shell paints its own rounded corners; while a custom background is
    // active, disable the native DWM rounding + backdrop so the window silhouette
    // and the painted background share exactly one corner radius (no interleaved
    // arcs / square backdrop wedges at the edges).
    invoke("set_custom_background_state", { active }).catch(console.error);
  }, [customBackground, theme, customBackgroundOpacity]);
};
