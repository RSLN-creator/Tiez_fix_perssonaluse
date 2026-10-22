import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
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
    if (customBackground && supportsCustomBackground(theme)) {
      root.style.setProperty("--custom-bg-image", `url("${convertFileSrc(customBackground)}")`);
      body.classList.add("has-custom-bg");
      // Also flag the <html> element: base.css gives html and body the same
      // border-radius + overflow:hidden, so squaring only one of them still
      // clips the window back to the CSS arc at every corner.
      root.classList.add("has-custom-bg");
    } else {
      root.style.removeProperty("--custom-bg-image");
      body.classList.remove("has-custom-bg");
      root.classList.remove("has-custom-bg");
    }
  }, [customBackground, theme, customBackgroundOpacity]);
};
