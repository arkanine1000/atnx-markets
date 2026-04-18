import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { DemoProvider } from "@/context/DemoContext";
import "./globals.css";

export const metadata: Metadata = {
  title: "ATNX — Attention Exchange",
  description: "Capture, identify, and track trending content with AI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col font-mono">
        <ThemeProvider attribute="class" defaultTheme="dark" themes={["dark", "light"]}>
          <DemoProvider>{children}</DemoProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
