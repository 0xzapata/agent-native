import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

import { AgentNativeI18nProvider } from "@agent-native/core/client/i18n";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { AppToolkitProvider } from "@/components/ui/toolkit-provider";
import { Toaster } from "@/components/ui/sonner";
import { i18nCatalog } from "@/i18n";

import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, maximum-scale=1",
      },
      { title: "Local Visual Plan" },
      {
        name: "description",
        content: "Review and edit Agent-Native Plan files on this machine.",
      },
      {
        httpEquiv: "Content-Security-Policy",
        content:
          "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
      },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: Root,
  notFoundComponent: () => (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Local Visual Plan
        </p>
        <h1 className="mt-3 text-2xl font-semibold">Plan session not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open a plan with the local CLI to create a private session URL.
        </p>
      </div>
    </main>
  ),
});

function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <AgentNativeI18nProvider
          catalog={i18nCatalog}
          initialLocale="en-US"
          initialPreference="en-US"
          persistPreference={false}
        >
          <TooltipProvider delayDuration={350}>
            <AppToolkitProvider>{children}</AppToolkitProvider>
            <Toaster richColors position="bottom-left" />
          </TooltipProvider>
        </AgentNativeI18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function Root() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Providers>
          <Outlet />
        </Providers>
        <Scripts />
      </body>
    </html>
  );
}
