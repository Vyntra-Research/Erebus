import { APP_BASE_NAME } from "../branding";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Erebus splash screen">
        <span className="text-xl font-semibold tracking-tight text-foreground">
          {APP_BASE_NAME}
        </span>
      </div>
    </div>
  );
}
