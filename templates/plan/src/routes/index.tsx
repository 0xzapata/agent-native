import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: LocalStartPage });

function LocalStartPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <div className="max-w-lg text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Local Visual Plan
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">
          The editor is ready.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Run <code>pnpm local open --dir &lt;plan-folder&gt;</code> to register a
          folder and open its private localhost URL.
        </p>
      </div>
    </main>
  );
}
