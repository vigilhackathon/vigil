// app/emr/layout.tsx — mock EMR chrome. The nurse surface is framed as tabs living inside
// the hospital EMR (ER Dashboard + Patient Record). The tab strip is rendered per-page so it
// can reflect the selected patient.

import type { ReactNode } from "react";

export const metadata = {
  title: "VIGIL — ED Tracking (mock EMR)",
};

export default function EmrLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex h-12 items-center justify-between border-b border-neutral-200 bg-white px-4 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="font-semibold tracking-tight">
          VIGIL <span className="font-normal text-neutral-400">· ED Tracking board (mock EMR)</span>
        </div>
        <div className="text-xs text-neutral-500">charge desk · demo</div>
      </header>
      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  );
}
