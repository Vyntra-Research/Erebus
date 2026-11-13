import { useEffect } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useWallpaperAsset } from "~/wallpaperStore";

export function WallpaperBackdrop() {
  const wallpaper = useWallpaperAsset();
  const effect = useClientSettings((settings) => settings.wallpaperEffect);
  const bottomBlur = useClientSettings((settings) => settings.wallpaperBottomBlur);
  const active = wallpaper.url !== null;

  useEffect(() => {
    if (active) {
      document.documentElement.dataset.wallpaper = "true";
      document.documentElement.dataset.wallpaperEffect = effect;
    } else {
      delete document.documentElement.dataset.wallpaper;
      delete document.documentElement.dataset.wallpaperEffect;
    }
    return () => {
      delete document.documentElement.dataset.wallpaper;
      delete document.documentElement.dataset.wallpaperEffect;
    };
  }, [active, effect]);

  if (!wallpaper.url) return null;
  const imageStyle = { backgroundImage: `url(${JSON.stringify(wallpaper.url)})` };

  return (
    <div aria-hidden className="app-wallpaper" data-effect={effect}>
      <div className="app-wallpaper__image" style={imageStyle} />
      {bottomBlur ? (
        <div className="app-wallpaper__image app-wallpaper__bottom-blur" style={imageStyle} />
      ) : null}
      {effect === "none" ? null : <div className="app-wallpaper__effect" />}
    </div>
  );
}
