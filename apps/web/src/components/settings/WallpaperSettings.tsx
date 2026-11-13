import { ImageIcon, LoaderIcon, Trash2Icon } from "lucide-react";
import type { ChangeEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { DEFAULT_WALLPAPER_EFFECT, type WallpaperEffect } from "@t3tools/contracts/settings";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useWallpaperPalette } from "~/wallpaperPalette";
import { clearWallpaperAsset, setWallpaperAsset, useWallpaperAsset } from "~/wallpaperStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const WALLPAPER_EFFECT_LABELS: Record<WallpaperEffect, string> = {
  none: "None",
  dither: "Dither",
  dots: "Dot screen",
};

function reportWallpaperError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The wallpaper operation failed.",
    }),
  );
}

export function WallpaperSettingsRows() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const wallpaper = useWallpaperAsset();
  const { resolvedTheme } = useTheme();
  const generatedPalette = useWallpaperPalette(wallpaper.url, resolvedTheme);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const hasWallpaper = wallpaper.url !== null;

  const handleFileChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setIsSaving(true);
    try {
      await setWallpaperAsset(file);
    } catch (error) {
      reportWallpaperError("Could not set wallpaper", error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setIsSaving(true);
    try {
      await clearWallpaperAsset();
    } catch (error) {
      reportWallpaperError("Could not remove wallpaper", error);
    } finally {
      setIsSaving(false);
    }
  }, []);

  return (
    <>
      <SettingsRow
        {...searchableSetting("wallpaper")}
        description="Choose an image stored only on this device. It is not included in thread sync."
        status={
          wallpaper.status === "loading"
            ? "Loading wallpaper…"
            : wallpaper.error
              ? wallpaper.error
              : wallpaper.fileName
        }
        control={
          <div className="flex min-w-0 items-center gap-2">
            {wallpaper.url ? (
              <div
                aria-hidden
                className="h-8 w-12 shrink-0 rounded-md border border-border bg-cover bg-center"
                style={{ backgroundImage: `url(${JSON.stringify(wallpaper.url)})` }}
              />
            ) : null}
            <input
              ref={fileInputRef}
              accept="image/avif,image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => void handleFileChange(event)}
              type="file"
            />
            <Button
              disabled={isSaving}
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              {isSaving ? <LoaderIcon className="animate-spin" /> : <ImageIcon />}
              {hasWallpaper ? "Change" : "Choose image"}
            </Button>
            {hasWallpaper ? (
              <Button
                aria-label="Remove wallpaper"
                disabled={isSaving}
                size="icon-sm"
                variant="ghost-muted"
                onClick={() => void handleClear()}
              >
                <Trash2Icon />
              </Button>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("wallpaper-palette")}
        description="Tint the interface with colors extracted from the current wallpaper."
        status={
          settings.wallpaperPaletteEnabled && generatedPalette.status === "loading"
            ? "Generating colors…"
            : generatedPalette.status === "error"
              ? generatedPalette.error
              : undefined
        }
        control={
          <div className="flex items-center gap-3">
            {generatedPalette.status === "ready" ? (
              <div
                aria-label="Generated wallpaper colors"
                className="flex overflow-hidden rounded-full border"
              >
                {generatedPalette.palette.swatches.map((color) => (
                  <span
                    aria-hidden
                    className="h-4 w-4"
                    key={color}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            ) : null}
            <Switch
              aria-label="Use wallpaper colors"
              checked={settings.wallpaperPaletteEnabled}
              disabled={!hasWallpaper}
              onCheckedChange={(checked) =>
                updateSettings({ wallpaperPaletteEnabled: Boolean(checked) })
              }
            />
          </div>
        }
      />

      <SettingsRow
        {...searchableSetting("wallpaper-effect")}
        description="Apply a responsive texture over the wallpaper image."
        resetAction={
          settings.wallpaperEffect !== DEFAULT_WALLPAPER_EFFECT ? (
            <SettingResetButton
              label="wallpaper effect"
              onClick={() => updateSettings({ wallpaperEffect: DEFAULT_WALLPAPER_EFFECT })}
            />
          ) : null
        }
        control={
          <Select
            disabled={!hasWallpaper}
            value={settings.wallpaperEffect}
            onValueChange={(value) => {
              if (value === "none" || value === "dither" || value === "dots") {
                updateSettings({ wallpaperEffect: value });
              }
            }}
          >
            <SelectTrigger aria-label="Wallpaper effect" className="w-full sm:w-40">
              <SelectValue>{WALLPAPER_EFFECT_LABELS[settings.wallpaperEffect]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(WALLPAPER_EFFECT_LABELS).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...searchableSetting("wallpaper-bottom-blur")}
        description="Blend a progressive blur into the lower part of the wallpaper."
        control={
          <Switch
            aria-label="Bottom wallpaper blur"
            checked={settings.wallpaperBottomBlur}
            disabled={!hasWallpaper}
            onCheckedChange={(checked) => updateSettings({ wallpaperBottomBlur: Boolean(checked) })}
          />
        }
      />
    </>
  );
}
