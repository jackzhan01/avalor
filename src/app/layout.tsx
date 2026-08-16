import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Avalor · 阿瓦隆记录本",
  description: "线下阿瓦隆对局的实时信息记录本：保踩、点车、票型、任务结果。",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Avalor",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  // viewportFit: cover is what makes env(safe-area-inset-*) report real values.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0e13" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className="no-overscroll min-h-dvh">{children}</body>
    </html>
  );
}
